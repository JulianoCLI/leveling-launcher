/**
 * @file refill-probe.js
 * Sonda do protocolo de compra contra o servidor real.
 *
 * Existe porque o refill foi escrito contra `MockWebSocket`, com as respostas
 * do servidor inventadas pelo próprio teste. Os nomes de campo de
 * `buy_consumable_result`, a moeda de `ConsumableDef.price` e o id do material
 * de essência eram suposição lida do `.proto`, não fato observado.
 *
 * Por padrão **não compra nada**: loga catálogo, estoque, ouro e o plano que o
 * refill faria. Comprar exige `--buy` explícito, e sempre `qty: 1`.
 *
 *   node tools/refill-probe.js --user U --pass P
 *   node tools/refill-probe.js --user U --pass P --buy hpPequena
 *   node tools/refill-probe.js --user U --pass P --buy essence
 *
 * Ferramenta de investigação, não parte do launcher.
 */

'use strict';

const { getCodec } = require('../src/domain/leveling-codec');
const refill = require('../src/domain/leveling-refill');

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
  console.error('uso: node tools/refill-probe.js --user U --pass P [--buy CHAVE]');
  process.exit(1);
}

const codec = getCodec();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/** Recorta objetos grandes para o log não virar o catálogo inteiro. */
const brief = (value, limit = 600) => {
  const text = JSON.stringify(value);
  return text && text.length > limit ? text.slice(0, limit) + `…(${text.length}b)` : text;
};

let nextId = 1;
const pending = new Map();
let ws = null;
/** Ligado só na janela da compra: antes disso o login enche o log. */
let traceAll = false;

/** Tudo que chega, por case, para nada passar sem ser visto. */
const seen = new Map();
const state = { gold: null, level: null, consumables: null, materials: null, catalog: null };
/** NPCs vistos na cena, por `def_id`. */
const npcs = new Map();
let snapshots = 0;

function send(caseName, value) {
  const id = nextId++;
  const payload = codec.encode(id, caseName, value);
  if (traceAll) log(`   [enviando] id=${id} ${payload.length}b hex=${payload.toString('hex')}`);
  ws.send(payload);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('timeout em ' + caseName));
    }, 20000);
    pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, reject });
  });
}

function onPacket(data) {
  const buf = Buffer.from(data);
  const head = codec.peek(buf);
  if (!head.caseName) return;

  seen.set(head.caseName, (seen.get(head.caseName) || 0) + 1);

  // Durante a compra, tudo que não é tráfego de mundo vai para o log cru: se a
  // resposta vier sem `request_id`, é só aqui que ela aparece.
  if (traceAll && head.caseName !== 'world_snapshot' && head.caseName !== 'world_delta') {
    try {
      const p = codec.decode(buf);
      log(`   [raw] id=${p.requestId} ${p.caseName} ${brief(p.value, 400)}`);
    } catch { /* ignorado: o log abaixo já reporta */ }
  }

  // Tráfego de mundo a 20 Hz: contar basta, desserializar não. As primeiras
  // snapshots são a exceção — é nelas que a lista de NPCs da cena aparece.
  if (head.caseName === 'world_delta') return;
  if (head.caseName === 'world_snapshot') {
    if (snapshots++ > 2) return;
  }

  let packet;
  try {
    packet = codec.decode(buf);
  } catch (e) {
    log('!! falha ao decodificar', head.caseName, e.message);
    return;
  }
  const value = packet.value || {};

  if (packet.requestId && pending.has(packet.requestId)) {
    const entry = pending.get(packet.requestId);
    pending.delete(packet.requestId);
    entry.resolve({ caseName: packet.caseName, value });
    return;
  }

  // Estado que o plano de compra consome.
  if (packet.caseName === 'character_state' || packet.caseName === 'character_patch') {
    if (value.wallet && value.wallet.gold != null) state.gold = Number(value.wallet.gold);
    if (value.progress && value.progress.level != null) state.level = Number(value.progress.level);
    if (value.consumables) state.consumables = value.consumables;
    if (value.inventory && value.inventory.materials) state.materials = value.inventory.materials;
  }
  // NPCs são entidades da cena: é isto que `shop.npcRequired` cobra.
  if (packet.caseName === 'entity_spawn' || packet.caseName === 'world_snapshot') {
    for (const ent of value.entities || []) {
      const kind = ent && ent.state && ent.state.kind;
      if (kind === 'ENTITY_KIND_NPC') npcs.set(ent.def_id || String(ent.state.id), ent);
    }
  }
  if (packet.caseName === 'scene_enter') state.scene = value;
  if (packet.caseName === 'npc_interaction') log('   [npc_interaction]', JSON.stringify(value));
  if (packet.caseName === 'content_catalog') {
    state.catalogRaw = value;
    state.catalog = refill.readCatalog(value);
  }
}

(async () => {
  ws = new WebSocket(WS_URL, { headers: { Origin: ORIGIN } });
  ws.binaryType = 'arraybuffer';

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = e => reject(new Error('conexão falhou: ' + (e && e.message)));
    setTimeout(() => reject(new Error('timeout ao conectar')), 20000);
  });
  log('== conectado');

  ws.onmessage = e => onPacket(e.data);
  ws.onclose = e => log('== socket fechado, code', e && e.code);

  const auth = await send('login', { username: opts.user, password: opts.pass });
  if (auth.caseName !== 'auth_ok') {
    log('!! login recusado:', auth.caseName, brief(auth.value));
    ws.close();
    return;
  }
  log('== login ok');

  // O catálogo e o snapshot chegam como push depois do login.
  await sleep(6000);

  log('\n-- cases recebidos');
  for (const [name, n] of [...seen].sort((a, b) => b[1] - a[1])) log(`   ${name} x${n}`);

  log('\n-- estado');
  log('   level:', state.level);
  log('   gold :', state.gold);
  log('   consumables:', brief(state.consumables));

  log('\n-- catálogo: ConsumableDef cru (campos de verdade)');
  const defs = (state.catalogRaw && state.catalogRaw.consumables) || [];
  log('   total de defs:', defs.length);
  for (const def of defs) log('   ', JSON.stringify(def));

  log('\n-- catálogo: ofertas da loja (categoria de essência e vizinhas)');
  const shop = (state.catalogRaw && state.catalogRaw.shop) || [];
  log('   total de ofertas:', shop.length);
  for (const offer of shop) log('   ', JSON.stringify(offer));

  log('\n-- readCatalog (o que o refill extrai)');
  log('   ', brief(state.catalog, 2000));

  log('\n-- cena e NPCs');
  log('   scene_enter:', brief(state.scene, 400));
  log('   NPCs vistos:', npcs.size);
  for (const [id, ent] of npcs) log('   ', id, JSON.stringify(ent));

  log('\n-- materiais no inventário');
  const mats = state.materials || [];
  log('   total:', mats.length);
  for (const m of mats.slice(0, 40)) log('   ', JSON.stringify(m));

  if (state.catalog && state.catalog.essence) {
    const id = state.catalog.essence.defId;
    const hit = mats.find(m => m && m.def_id === id);
    log(`\n   essence.defId do catálogo = ${JSON.stringify(id)}`);
    log('   casa com algum material? ', hit ? JSON.stringify(hit) : 'NÃO CASA');
  }

  // ------------------------------------------------------------------ compra
  if (opts.buy) {
    const item = refill.ITEMS.find(i => i.key === opts.buy);
    if (!item) {
      log('\n!! chave desconhecida:', opts.buy);
    } else {
      // Sempre uma unidade: a sonda existe para ver a resposta, não para
      // abastecer a conta.
      const caseName = item.essence ? 'buy_essence' : 'buy_consumable';
      const value = item.essence ? { qty: 1 } : { kind: item.kindNum, tier: item.tierNum, qty: 1 };

      log(`\n== COMPRANDO 1× ${item.label}`);
      log('   enviando', caseName, JSON.stringify(value));
      const goldAntes = state.gold;
      traceAll = true;

      let res;
      try {
        res = await send(caseName, value);
      } catch (e) {
        log('!! sem resposta:', e.message);
        res = null;
      }

      if (res) {
        log('   resposta case :', res.caseName);
        log('   resposta crua :', JSON.stringify(res.value));
        log('   campos        :', Object.keys(res.value).join(', ') || '(vazio)');
      }

      // O patch de estado chega depois; é ele que diz o custo real.
      await sleep(4000);
      log('   ouro antes    :', goldAntes);
      log('   ouro depois   :', state.gold);
      if (goldAntes != null && state.gold != null) {
        log('   delta de ouro :', state.gold - goldAntes);
      }
      log('   consumables   :', brief(state.consumables));
      if (item.essence) {
        const id = state.catalog && state.catalog.essence && state.catalog.essence.defId;
        const hit = (state.materials || []).find(m => m && m.def_id === id);
        log('   material essência depois:', hit ? JSON.stringify(hit) : '(não achado)');
      }
    }
  }

  log('\n== fim');
  ws.close();
  // Sem isto o socket fechado ainda segura o event loop por alguns segundos.
  setTimeout(() => process.exit(0), 500);
})().catch(e => {
  log('!! erro fatal:', e.message);
  process.exit(1);
});
