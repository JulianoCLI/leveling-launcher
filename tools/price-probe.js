/**
 * @file price-probe.js
 * Descobre como o servidor forma o preço dos consumíveis.
 *
 * O catálogo diz 2 para a poção pequena de vida, mas a compra real custou 11.
 * A fórmula do cliente (`1 + consumablePricePerLevel*(nivel-1)`) prevê 9, então
 * nem o catálogo nem o cliente servem para o planejador orçar a compra.
 *
 * Esta sonda faz uma viagem só, compra **uma unidade de cada tier** e registra
 * o `gold_cost` de cada uma. Com nove pontos medidos contra nove preços base
 * conhecidos, o fator fica determinado sem achismo.
 *
 *   node tools/price-probe.js --user U --pass P
 *
 * COMPRA DE VERDADE: nove unidades, poucas dezenas de ouro. Tira a conta da
 * caçada e a devolve.
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
  console.error('uso: node tools/price-probe.js --user U --pass P');
  process.exit(1);
}

const codec = getCodec();
const log = (...a) => console.log(...a);

let nextId = 1;
const pending = new Map();
const waiters = new Map();
let ws = null;

const world = { scene: null, own: 0, npcs: new Map(), hunt: null, rules: null, consumables: [] };
const char = { level: 0, pos: null };

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

  if (packet.caseName === 'content_catalog') {
    world.rules = value.rules || {};
    world.consumables = value.consumables || [];
  }
  if (packet.caseName === 'scene_enter') {
    world.scene = value;
    world.own = value.your_entity || 0;
    world.npcs = new Map((value.npcs || []).map(n => [n.npc_id || String(n.entity), n]));
    if (value.hunt && value.hunt.gate_id) world.hunt = value.hunt;
  }
  if (packet.caseName === 'character_state' || packet.caseName === 'character_patch') {
    if (value.progress && value.progress.level != null) char.level = Number(value.progress.level);
  }
  if (packet.caseName === 'world_snapshot') {
    for (const ent of value.entities || []) {
      if (ent && ent.state && ent.state.id === world.own) char.pos = { x: ent.state.x, y: ent.state.y };
    }
  }

  fire(packet.caseName, value);
}

const dist = (a, b) => (a && b ? Math.round(Math.hypot(a.x - b.x, a.y - b.y)) : null);

const KINDS = { CONSUMABLE_KIND_HP_POTION: 1, CONSUMABLE_KIND_MANA_POTION: 2, CONSUMABLE_KIND_REVIVE: 3 };
const TIERS = { POTION_TIER_PEQUENA: 1, POTION_TIER_MEDIA: 2, POTION_TIER_GRANDE: 3 };

(async () => {
  ws = new WebSocket(WS_URL, { headers: { Origin: ORIGIN } });
  ws.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('conexão falhou'));
    setTimeout(() => reject(new Error('timeout ao conectar')), 20000);
  });
  ws.onmessage = e => onPacket(e.data);

  const auth = await send('login', { username: opts.user, password: opts.pass });
  if (auth.caseName !== 'auth_ok') {
    log('!! login recusado:', auth.caseName, JSON.stringify(auth.value));
    ws.close();
    return;
  }
  await waitFor('scene_enter');
  await waitFor('character_state', 8000);
  await waitFor('content_catalog', 10000);

  const hunt = world.hunt;
  if (!hunt) {
    log('!! conta não está em caçada; sem bilhete de volta, abortando.');
    ws.close();
    setTimeout(() => process.exit(1), 300);
    return;
  }

  const r = world.rules || {};
  const ppl = Number(r.consumable_price_per_level) || 0;
  const pplsq = Number(r.consumable_price_per_level_sq) || 0;
  const s = Math.max(0, char.level - 1);
  const cCliente = 1 + ppl * s + pplsq * s * s;
  log(`nível ${char.level}  ppl=${ppl} pplsq=${pplsq}  fator do cliente = ${cCliente.toFixed(4)}`);

  const base = new Map();
  for (const d of world.consumables) {
    if (!KINDS[d.kind] || !TIERS[d.tier]) continue;
    base.set(`${d.kind}|${d.tier}`, Number(d.price) || 0);
  }

  const cidade = r.city_scene_id || 'cidade-seul';
  try {
    emit('travel', { scene_id: cidade });
    const chegou = await waitFor('scene_enter', 15000);
    if (!chegou || chegou.scene_id !== cidade) throw new Error('travel falhou');

    const loja = [...world.npcs.values()].find(n => n.service === 'NPC_SERVICE_SHOP');
    if (!loja) throw new Error('sem NPC de loja');

    emit('move_to', { x: loja.pos.x, y: loja.pos.y });
    for (let i = 0; i < 60; i++) {
      await waitFor('world_snapshot', 2000);
      const d = dist(char.pos, loja.pos);
      if (d != null && d <= 700) break;
    }
    emit('interact', { entity: loja.entity });
    await waitFor('npc_interaction', 5000);

    log('\nitem                                   base  cobrado  fator');
    for (const [key, price] of base) {
      const [kind, tier] = key.split('|');
      const res = await send('buy_consumable', { kind: KINDS[kind], tier: TIERS[tier], qty: 1 });
      if (res.caseName !== 'buy_consumable_result') {
        log(`${key.padEnd(38)} ${String(price).padStart(4)}  ${res.caseName} ${JSON.stringify(res.value)}`);
        continue;
      }
      const cost = Number(res.value.gold_cost) || 0;
      log(`${key.padEnd(38)} ${String(price).padStart(4)} ${String(cost).padStart(8)}  ${(cost / price).toFixed(4)}`);
    }

    // Lotes: o preço é por unidade ou tem desconto/arredondamento no total?
    const lote = await send('buy_consumable', { kind: 1, tier: 1, qty: 5 });
    log(`\nlote de 5 (hp pequena): ${JSON.stringify(lote.value)}`);

    const ess = await send('buy_essence', { qty: 1 });
    log(`essência 1: ${JSON.stringify(ess.value)}`);
    const essLote = await send('buy_essence', { qty: 4 });
    log(`essência 4: ${JSON.stringify(essLote.value)}`);
  } catch (e) {
    log(`!! falhou: ${e.message}`);
  } finally {
    const volta = await send('start_hunt', {
      gate_id: hunt.gate_id,
      tier_min: hunt.tier_min,
      difficulty: hunt.difficulty
    });
    log(`\nvolta: ${volta.caseName} ${JSON.stringify(volta.value)}`);
  }

  ws.close();
  setTimeout(() => process.exit(0), 500);
})().catch(e => {
  log('!! erro fatal:', e.message);
  process.exit(1);
});
