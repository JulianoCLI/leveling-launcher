/**
 * @file refill-trip-probe.js
 * Mede o custo real do refill com viagem (caminho C).
 *
 * `shop-probe.js` provou que não existe compra remota: o servidor exige o
 * personagem junto ao NPC de loja, em `cidade-seul`. Esta sonda executa o ciclo
 * completo e **cronometra cada etapa**:
 *
 *   guardar contexto da caçada → travel → achar NPC → move_to → interact
 *   → comprar → conferir o saldo → start_hunt de volta
 *
 * Orientada a evento, sem sleep fixo: cada passo espera o pacote que o
 * confirma. O número que importa é quanto tempo a conta fica fora da caçada.
 *
 * MOVE A CONTA DE VERDADE. Tira o personagem da caçada e o devolve. Se algo
 * falhar no meio, a conta pode ficar na cidade — o `finally` tenta recolocá-la.
 *
 *   node tools/refill-trip-probe.js --user U --pass P          (ensaio: não compra)
 *   node tools/refill-trip-probe.js --user U --pass P --buy    (compra 1 de cada)
 *
 * Ferramenta de investigação, não parte do launcher.
 */

'use strict';

const { getCodec } = require('../src/domain/leveling-codec');

const WS_URL = 'wss://game.levelingidle2d.com.br:8443/ws';
const ORIGIN = 'https://levelingidle2d.com.br';

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

const opts = args();
if (!opts.user || !opts.pass) {
  console.error('uso: node tools/refill-trip-probe.js --user U --pass P [--buy]');
  process.exit(1);
}

const codec = getCodec();
const log = (...a) => console.log(...a);
const brief = (v, n = 400) => {
  const t = JSON.stringify(v);
  return t && t.length > n ? t.slice(0, n) + `…(${t.length}b)` : t;
};

const T0 = Date.now();
/** Marca de tempo relativa ao início: tudo no log é comparável. */
const ms = () => String(Date.now() - T0).padStart(6) + 'ms';

let nextId = 1;
const pending = new Map();
/** Esperas por push: `caseName` -> lista de resolvers. */
const waiters = new Map();
let ws = null;

const world = { scene: null, own: 0, npcs: new Map(), hunt: null, rules: null };
const char = { gold: null, level: null, consumables: null, pos: null };

/** Espera um push específico. É isto que substitui o sleep. */
function waitFor(caseName, timeoutMs = 15000) {
  return new Promise(resolve => {
    const list = waiters.get(caseName) || [];
    const entry = { resolve };
    entry.timer = setTimeout(() => {
      const l = waiters.get(caseName) || [];
      const i = l.indexOf(entry);
      if (i >= 0) l.splice(i, 1);
      resolve(null);
    }, timeoutMs);
    list.push(entry);
    waiters.set(caseName, list);
  });
}

function fire(caseName, value) {
  const list = waiters.get(caseName);
  if (!list || !list.length) return;
  waiters.set(caseName, []);
  for (const entry of list) {
    clearTimeout(entry.timer);
    entry.resolve(value);
  }
}

function send(caseName, value, timeoutMs = 12000) {
  const id = nextId++;
  let payload;
  try {
    payload = codec.encode(id, caseName, value);
  } catch (e) {
    return Promise.resolve({ caseName: 'ENCODE_FAIL', value: { message: e.message } });
  }
  ws.send(payload);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ caseName: 'TIMEOUT', value: {} });
    }, timeoutMs);
    pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); } });
  });
}

/** Envio sem resposta: `move_to`, `interact` e `travel` não respondem. */
function emit(caseName, value) {
  ws.send(codec.encode(nextId++, caseName, value));
}

function onPacket(data) {
  const buf = Buffer.from(data);
  const head = codec.peek(buf);
  if (!head.caseName) return;
  if (head.caseName === 'world_delta' || head.caseName === 'world_events') return;

  let packet;
  try { packet = codec.decode(buf); } catch { return; }
  const value = packet.value || {};

  if (packet.requestId && pending.has(packet.requestId)) {
    const entry = pending.get(packet.requestId);
    pending.delete(packet.requestId);
    entry.resolve({ caseName: packet.caseName, value });
    return;
  }

  if (packet.caseName === 'content_catalog' && value.rules) world.rules = value.rules;

  if (packet.caseName === 'scene_enter') {
    world.scene = value;
    world.own = value.your_entity || 0;
    world.npcs = new Map((value.npcs || []).map(n => [n.npc_id || String(n.entity), n]));
    // `hunt` só vem preenchido numa cena de caçada; é o bilhete de volta.
    if (value.hunt && value.hunt.gate_id) world.hunt = value.hunt;
    log(`${ms()}  [scene_enter] ${value.scene_id} kind=${value.kind} npcs=${world.npcs.size}` +
      (value.hunt && value.hunt.gate_id ? ` hunt=${value.hunt.gate_id}` : ''));
  }

  if (packet.caseName === 'character_state' || packet.caseName === 'character_patch') {
    if (value.wallet && value.wallet.gold != null) char.gold = Number(value.wallet.gold);
    if (value.progress && value.progress.level != null) char.level = Number(value.progress.level);
    if (value.consumables) char.consumables = value.consumables;
  }

  // Posição do próprio personagem, para saber se o `move_to` andou.
  if (packet.caseName === 'world_snapshot') {
    for (const ent of value.entities || []) {
      if (ent && ent.state && ent.state.id === world.own) {
        char.pos = { x: ent.state.x, y: ent.state.y };
      }
    }
  }

  if (packet.caseName === 'npc_interaction') {
    log(`${ms()}  [npc_interaction] ${brief(value)}`);
  }

  fire(packet.caseName, value);
}

const dist = (a, b) => (a && b ? Math.round(Math.hypot(a.x - b.x, a.y - b.y)) : null);

/** Conta de poções pequenas de vida, que é o item que a sonda compra. */
const hpPequena = () => {
  const c = char.consumables || {};
  return (c.hp_potions && Number(c.hp_potions.pequena)) || 0;
};

(async () => {
  ws = new WebSocket(WS_URL, { headers: { Origin: ORIGIN } });
  ws.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('conexão falhou'));
    setTimeout(() => reject(new Error('timeout ao conectar')), 20000);
  });
  ws.onmessage = e => onPacket(e.data);
  ws.onclose = e => log(`${ms()}  == socket fechado, code ${e && e.code}`);

  const auth = await send('login', { username: opts.user, password: opts.pass });
  if (auth.caseName !== 'auth_ok') {
    log('!! login recusado:', auth.caseName, brief(auth.value));
    ws.close();
    return;
  }
  log(`${ms()}  == login ok`);

  // Espera a cena inicial em vez de dormir um tempo arbitrário.
  await waitFor('scene_enter');
  await waitFor('character_state', 8000);

  const huntOrigem = world.hunt;
  const cena = world.scene && world.scene.scene_id;
  log(`\n== ponto de partida`);
  log(`   cena      : ${cena}`);
  log(`   caçada    : ${brief(huntOrigem)}`);
  log(`   nível/ouro: ${char.level} / ${char.gold}`);
  log(`   hp pequena: ${hpPequena()}`);

  if (!huntOrigem) {
    log('\n!! a conta não está em caçada; sem bilhete de volta, abortando.');
    ws.close();
    setTimeout(() => process.exit(1), 300);
    return;
  }

  const cidade = (world.rules && world.rules.city_scene_id) || 'cidade-seul';
  let fora = null;

  try {
    // ------------------------------------------------------------ 1. viagem
    log(`\n== 1. travel para ${cidade}`);
    const tSaida = Date.now();
    emit('travel', { scene_id: cidade });

    const chegou = await waitFor('scene_enter', 15000);
    if (!chegou || chegou.scene_id !== cidade) {
      log(`${ms()}  !! não chegou na cidade (recebido: ${chegou && chegou.scene_id})`);
      throw new Error('travel falhou');
    }
    log(`${ms()}  viagem levou ${Date.now() - tSaida}ms`);

    // ------------------------------------------------------- 2. achar o NPC
    const loja = [...world.npcs.values()].find(n => n.service === 'NPC_SERVICE_SHOP');
    log(`\n== 2. NPC de loja`);
    log(`   NPCs na cena: ${[...world.npcs.keys()].join(', ') || '(nenhum)'}`);
    if (!loja) throw new Error('nenhum NPC com NPC_SERVICE_SHOP na cidade');
    log(`   loja: ${JSON.stringify(loja)}`);

    // Onde o personagem nasceu na cidade, para medir a distância a andar.
    await waitFor('world_snapshot', 8000);
    log(`   minha posição: ${JSON.stringify(char.pos)}`);
    log(`   distância até o NPC: ${dist(char.pos, loja.pos)}`);

    // ----------------------------------------- 3. compra ANTES de se mover
    // Mede a regra: basta estar na cena da loja, ou precisa andar até o NPC?
    log(`\n== 3. compra sem andar (a cena basta?)`);
    const semAndar = await send('buy_consumable', { kind: 1, tier: 1, qty: 1 });
    log(`${ms()}  ← ${semAndar.caseName} ${brief(semAndar.value)}`);

    // ------------------------------------------------------------ 4. andar
    // `--skip-move` testa a hipótese de que `interact` basta: nas duas corridas
    // anteriores a compra passou com `perto=false`, ou seja, o servidor nunca
    // viu o personagem encostar no NPC.
    if (opts['skip-move']) {
      log(`\n== 4. move_to PULADO (--skip-move)`);
    } else {
      log(`\n== 4. move_to até o NPC`);
      const tAndar = Date.now();
      emit('move_to', { x: loja.pos.x, y: loja.pos.y });

      // Sem sleep: observa as snapshots até encostar no NPC ou desistir.
      let perto = false;
      for (let i = 0; i < 60; i++) {
        await waitFor('world_snapshot', 2000);
        const d = dist(char.pos, loja.pos);
        if (d != null && d <= 700) { perto = true; break; }
      }
      log(`${ms()}  caminhada levou ${Date.now() - tAndar}ms, distância final ${dist(char.pos, loja.pos)}, perto=${perto}`);
    }

    // --------------------------------------------------------- 5. interact
    log(`\n== 5. interact no NPC`);
    emit('interact', { entity: loja.entity });
    const inter = await waitFor('npc_interaction', 5000);
    log(`${ms()}  npc_interaction: ${inter ? brief(inter) : '(nenhum)'}`);

    // ---------------------------------------------------------- 6. comprar
    log(`\n== 6. compras`);
    const antesOuro = char.gold;
    const antesHp = hpPequena();

    if (!opts.buy) {
      log('   ensaio (--buy não passado): mandando só 1 poção para ver a resposta');
    }
    const compra = await send('buy_consumable', { kind: 1, tier: 1, qty: 1 });
    log(`${ms()}  ← ${compra.caseName} ${brief(compra.value)}`);
    if (compra.caseName === 'buy_consumable_result') {
      log(`   CAMPOS DA RESPOSTA: ${Object.keys(compra.value).join(', ')}`);
    }

    let essencia = null;
    if (opts.buy) {
      essencia = await send('buy_essence', { qty: 1 });
      log(`${ms()}  ← ${essencia.caseName} ${brief(essencia.value)}`);
      if (essencia.caseName === 'buy_essence_result') {
        log(`   CAMPOS DA RESPOSTA: ${Object.keys(essencia.value).join(', ')}`);
      }
    }

    // ------------------------------------------------------ 7. conferência
    log(`\n== 7. conferência`);
    await waitFor('character_patch', 6000);
    log(`   ouro : ${antesOuro} → ${char.gold} (delta ${char.gold - antesOuro})`);
    log(`   hp pq: ${antesHp} → ${hpPequena()} (delta ${hpPequena() - antesHp})`);

    // --------------------------------------------------- 8. voltar à caçada
    log(`\n== 8. start_hunt de volta`);
    const tVolta = Date.now();
    const volta = await send('start_hunt', {
      gate_id: huntOrigem.gate_id,
      tier_min: huntOrigem.tier_min,
      difficulty: huntOrigem.difficulty
    });
    log(`${ms()}  ← ${volta.caseName} ${brief(volta.value)}`);

    const deVolta = await waitFor('scene_enter', 15000);
    log(`${ms()}  volta levou ${Date.now() - tVolta}ms, cena: ${deVolta && deVolta.scene_id}`);

    fora = Date.now() - tSaida;
  } catch (e) {
    log(`\n!! ciclo falhou: ${e.message}`);
    // A conta não pode ficar parada na cidade por causa de um erro da sonda.
    log('   tentando devolver a conta à caçada...');
    const resgate = await send('start_hunt', {
      gate_id: huntOrigem.gate_id,
      tier_min: huntOrigem.tier_min,
      difficulty: huntOrigem.difficulty
    });
    log(`   resgate: ${resgate.caseName} ${brief(resgate.value)}`);
    await waitFor('scene_enter', 12000);
    log(`   cena final: ${world.scene && world.scene.scene_id}`);
  }

  log(`\n== resumo`);
  log(`   cena final: ${world.scene && world.scene.scene_id}`);
  log(`   caçada    : ${brief(world.hunt)}`);
  if (fora != null) log(`   TEMPO FORA DA CAÇADA: ${fora}ms`);

  ws.close();
  setTimeout(() => process.exit(0), 500);
})().catch(e => {
  log('!! erro fatal:', e.message);
  process.exit(1);
});
