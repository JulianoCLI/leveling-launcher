/**
 * @file shop-probe.js
 * Sonda do caminho B: existe compra sem mover o personagem?
 *
 * `refill-probe.js` provou que `buy_consumable` numa cena de caçada devolve
 * `error{shop.npcRequired}`. Esta sonda responde a pergunta seguinte: a regra é
 * "estar perto do NPC" ou só "ter uma sessão de loja aberta"? Se um `interact`
 * à distância bastar, o refill é viável sem tirar a conta da caçada.
 *
 * Cada passo é um experimento numerado, com o resultado logado cru. Nada é
 * inferido: o que o servidor responde é o que vale.
 *
 *   node tools/shop-probe.js --user U --pass P
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
  console.error('uso: node tools/shop-probe.js --user U --pass P');
  process.exit(1);
}

const codec = getCodec();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const brief = (v, n = 500) => {
  const t = JSON.stringify(v);
  return t && t.length > n ? t.slice(0, n) + `…(${t.length}b)` : t;
};

let nextId = 1;
const pending = new Map();
let ws = null;

const world = { scene: null, npcs: new Map(), interactions: [], portals: [], own: 0 };
const pushes = [];

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

/** Um experimento: envia, loga a resposta crua, devolve o case. */
async function step(n, title, caseName, value) {
  log(`\n[${n}] ${title}`);
  log(`    → ${caseName} ${JSON.stringify(value)}`);
  const res = await send(caseName, value);
  log(`    ← ${res.caseName} ${brief(res.value)}`);
  return res;
}

function onPacket(data) {
  const buf = Buffer.from(data);
  const head = codec.peek(buf);
  if (!head.caseName) return;
  if (head.caseName === 'world_snapshot' || head.caseName === 'world_delta') return;
  if (head.caseName === 'world_events') return;

  let packet;
  try { packet = codec.decode(buf); } catch { return; }
  const value = packet.value || {};

  if (packet.requestId && pending.has(packet.requestId)) {
    const entry = pending.get(packet.requestId);
    pending.delete(packet.requestId);
    entry.resolve({ caseName: packet.caseName, value });
    return;
  }

  // Pushes que só aparecem se a loja abrir de verdade.
  if (/npc_interaction|commerce|shop/.test(packet.caseName)) {
    pushes.push({ at: Date.now(), caseName: packet.caseName, value });
    log(`    [push] ${packet.caseName} ${brief(value, 300)}`);
  }

  if (packet.caseName === 'content_catalog' && value.rules) world.rules = value.rules;
  if (packet.caseName === 'scene_enter') {
    world.scene = value;
    world.own = value.your_entity || 0;
    world.interactions = value.interactions || [];
    world.portals = value.portals || [];
    world.npcs = new Map((value.npcs || []).map(n => [n.npc_id || String(n.entity), n]));
  }
}

(async () => {
  ws = new WebSocket(WS_URL, { headers: { Origin: ORIGIN } });
  ws.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = e => reject(new Error('conexão falhou'));
    setTimeout(() => reject(new Error('timeout ao conectar')), 20000);
  });
  ws.onmessage = e => onPacket(e.data);
  ws.onclose = e => log('== socket fechado, code', e && e.code);

  const auth = await send('login', { username: opts.user, password: opts.pass });
  if (auth.caseName !== 'auth_ok') {
    log('!! login recusado:', auth.caseName, brief(auth.value));
    ws.close();
    return;
  }
  log('== login ok');
  await sleep(5000);

  log('\n== cena atual');
  log('   scene_id   :', world.scene && world.scene.scene_id);
  log('   kind       :', world.scene && world.scene.kind);
  log('   your_entity:', world.own);
  log('   npcs       :', world.npcs.size, [...world.npcs.keys()].join(', ') || '(nenhum)');
  log('   interactions:', world.interactions.length);
  for (const it of world.interactions) log('     ', JSON.stringify(it));
  log('   portals    :', world.portals.length);
  for (const p of world.portals) log('     ', JSON.stringify(p));

  // ---------------------------------------------------------- experimentos
  // A pergunta é sempre a mesma: a compra passa a ser aceita?

  await step(1, 'Compra direta na cena de caçada (controle; já sabemos que falha)',
    'buy_consumable', { kind: 1, tier: 1, qty: 1 });

  // Se a loja for uma sessão, talvez um `interact` em entidade inexistente já
  // mude o estado do servidor. Entidade 0 é o caso degenerado.
  await step(2, 'interact em entidade 0 (existe validação de entidade?)',
    'interact', { entity: 0 });

  // O portal de retorno é a única entidade interagível desta cena. Não é loja,
  // mas a resposta diz como o servidor valida alcance.
  const portal = world.portals[0];
  if (portal) {
    await step(3, `interact no portal "${portal.portal_id}" entidade ${portal.entity} (teste de alcance)`,
      'interact', { entity: portal.entity });
  } else {
    log('\n[3] sem portal na cena, pulado');
  }

  await step(4, 'Compra depois dos interacts (algo mudou?)',
    'buy_consumable', { kind: 1, tier: 1, qty: 1 });

  // Talvez exista uma via de comércio que não dependa de cena.
  await step(5, 'commerce_request{methods} (a via de comércio responde?)',
    'commerce_request', { methods: {} });

  // `buy_material` usa `offer_id` em vez de kind/tier. Se a validação de NPC
  // estiver só no handler de consumível, isto passaria — e seria a brecha.
  // O id é o da **oferta** (`ShopOffer.id`), não o do item.
  await step(6, 'buy_material com a oferta de essência (outro handler, mesma loja?)',
    'buy_material', { offer_id: 'ess10', packs: 1 });

  await step(7, 'buy_essence (handler próprio, mesma pergunta)',
    'buy_essence', { qty: 1 });

  // ACHADO: o passo 6 devolveu `diamonds.insufficient`, não `npcRequired`. O
  // handler de material chegou a validar a carteira, ou seja, passou da checagem
  // de NPC. Os passos abaixo medem o tamanho exato dessa brecha.
  await step('6a', 'buy_material com oferta de MATERIAL em diamante (reset1)',
    'buy_material', { offer_id: 'reset1', packs: 1 });

  await step('6b', 'buy_material apontando para a oferta de essência (categoria ESSENCE)',
    'buy_material', { offer_id: 'essencia-extracao', packs: 1 });

  await step('6c', 'buy_material apontando para uma oferta de consumível (heal:pequena)',
    'buy_material', { offer_id: 'heal:pequena', packs: 1 });

  await step('6d', 'buy_material com oferta inexistente (como erra um id ruim)',
    'buy_material', { offer_id: 'nao-existe', packs: 1 });

  // Daqui para baixo a conta sai da caçada: `travel` muda de cena e para o
  // farm. Exige `--travel` explícito para não acontecer por descuido.
  if (!opts.travel) {
    log('\n[8+] passos que movem a conta foram pulados (use --travel para rodá-los)');
    log('\n== fim');
    ws.close();
    setTimeout(() => process.exit(0), 500);
    return;
  }

  // A cidade é o lugar onde a loja existe. Se `travel` for recusado durante a
  // caçada, o caminho C também é mais caro do que parece.
  await step(8, 'travel para a cidade (o servidor deixa sair da caçada assim?)',
    'travel', { scene_id: (world.rules && world.rules.city_scene_id) || 'cidade-seul' });

  await sleep(4000);
  log('\n   cena depois do travel:', world.scene && world.scene.scene_id,
    '| npcs:', world.npcs.size, [...world.npcs.keys()].join(', ') || '(nenhum)');

  // Se a viagem funcionou e há NPC de loja, esta compra é o teste final: a
  // regra é proximidade física ou só estar na cena certa?
  await step(9, 'Compra na cidade, SEM se mover nem interagir com o NPC',
    'buy_consumable', { kind: 1, tier: 1, qty: 1 });

  const shopNpc = [...world.npcs.values()].find(n => n.service === 'NPC_SERVICE_SHOP');
  if (shopNpc) {
    log('\n   NPC de loja:', JSON.stringify(shopNpc));
    await step(10, `interact no NPC de loja (entidade ${shopNpc.entity}), à distância`,
      'interact', { entity: shopNpc.entity });
    await sleep(1500);
    await step(11, 'Compra depois do interact à distância',
      'buy_consumable', { kind: 1, tier: 1, qty: 1 });
  } else {
    log('\n[10-11] nenhum NPC com NPC_SERVICE_SHOP na cena, pulado');
  }

  log('\n== pushes de loja/comércio recebidos:', pushes.length);
  for (const p of pushes) log('   ', p.caseName, brief(p.value, 300));

  log('\n== fim');
  ws.close();
  setTimeout(() => process.exit(0), 500);
})().catch(e => {
  log('!! erro fatal:', e.message);
  process.exit(1);
});
