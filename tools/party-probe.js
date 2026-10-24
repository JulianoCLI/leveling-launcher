/**
 * @file party-probe.js
 * Mede o protocolo real de grupo (`party_request`) contra o servidor.
 *
 * Nada aqui é suposição: cada etapa manda o pacote e registra a resposta crua,
 * para que o sistema de "criar PT automática" use só o que o servidor aceita.
 *
 *   node tools/party-probe.js --user U --pass P
 *   node tools/party-probe.js --user U --pass P --create
 *   node tools/party-probe.js --user U --pass P --invite NOME
 *   node tools/party-probe.js --user U --pass P --accept-from NOME
 *   node tools/party-probe.js --user U --pass P --disband
 *   node tools/party-probe.js --user U --pass P --watch 60   (só escuta pushes)
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
  console.error('uso: node tools/party-probe.js --user U --pass P [--create] [--invite NOME] [--disband] [--watch SEGS]');
  process.exit(1);
}

const codec = getCodec();
const log = (...a) => console.log(...a);
const full = v => JSON.stringify(v, null, 2);

const T0 = Date.now();
const ms = () => String(Date.now() - T0).padStart(6) + 'ms';

let nextId = 1;
const pending = new Map();
const waiters = new Map();
let ws = null;

const me = { accountId: null, name: '', level: null };

function waitFor(caseName, timeoutMs = 10000) {
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

const QUIET = new Set([
  'world_snapshot', 'world_events', 'world_delta', 'entity_spawn', 'entity_despawn',
  'move_ack', 'content_catalog', 'shadow_delta', 'shadow_page', 'shadow_species_page',
  'inventory_page', 'fight_rules', 'hunt_session'
]);

function onPacket(data) {
  const buf = Buffer.from(data);
  let head;
  try { head = codec.peek(buf); } catch { return; }
  if (!head.caseName) return;
  if (!head.requestId && QUIET.has(head.caseName)) return;

  let packet;
  try { packet = codec.decode(buf); } catch { return; }
  const value = packet.value || {};

  if (packet.requestId && pending.has(packet.requestId)) {
    const entry = pending.get(packet.requestId);
    pending.delete(packet.requestId);
    entry.resolve({ caseName: packet.caseName, value });
    return;
  }

  if (packet.caseName === 'character_state') {
    if (value.identity) me.name = value.identity.name || me.name;
    if (value.progress) me.level = Number(value.progress.level) || me.level;
  }

  // Tudo que é de grupo aparece inteiro: é o que o sistema vai consumir.
  if (packet.caseName === 'party_push' || packet.caseName === 'party_response') {
    log(`${ms()}  PUSH ${packet.caseName}\n${full(value)}`);
  } else if (packet.caseName === 'notice' || packet.caseName === 'error') {
    log(`${ms()}  ${packet.caseName}: ${JSON.stringify(value)}`);
  } else {
    log(`${ms()}  (${packet.caseName})`);
  }

  fire(packet.caseName, value);
}

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
    log('!! login recusado:', auth.caseName, full(auth.value));
    ws.close();
    setTimeout(() => process.exit(1), 300);
    return;
  }
  me.accountId = auth.value.account_id != null ? String(auth.value.account_id) : null;
  me.name = auth.value.username || '';
  log(`${ms()}  == login ok  account_id=${me.accountId} username=${me.name}`);

  // Manter o elo vivo durante a sonda.
  const ping = setInterval(() => send('ping', { client_time_ms: Date.now() }), 15000);

  await waitFor('character_state', 8000);
  log(`   nome=${me.name} nível=${me.level}`);

  // ------------------------------------------------------------- estado atual
  log(`\n== party_request{get}`);
  const get = await send('party_request', { get: {} });
  log(`${ms()}  ← ${get.caseName}\n${full(get.value)}`);

  // ------------------------------------------------------------------ listar
  log(`\n== party_request{list}`);
  const list = await send('party_request', { list: {} });
  log(`${ms()}  ← ${list.caseName}\n${full(list.value)}`);

  // ------------------------------------------------------------------ criar
  if (opts.create) {
    log(`\n== party_request{create}`);
    const create = await send('party_request', {
      create: {
        settings: {
          privacy: 'PARTY_PRIVACY_CLOSED',
          capacity: 4,
          objective: 'launcher',
          auto_accept_friends: true,
          auto_accept_guild: true
        }
      }
    });
    log(`${ms()}  ← ${create.caseName}\n${full(create.value)}`);
  }

  // --------------------------------------------------------------- convidar
  if (typeof opts.invite === 'string') {
    log(`\n== party_request{invite} para ${opts.invite}`);
    const invite = await send('party_request', { invite: { name: opts.invite } });
    log(`${ms()}  ← ${invite.caseName}\n${full(invite.value)}`);
  }

  // ------------------------------------------------------------ novo código
  if (opts.code) {
    log(`\n== party_request{new_code}`);
    const code = await send('party_request', { new_code: {} });
    log(`${ms()}  ← ${code.caseName}\n${full(code.value)}`);
  }

  // ------------------------------------------------- entrar por código
  if (typeof opts['join-code'] === 'string') {
    log(`\n== party_request{join_code} ${opts['join-code']}`);
    const join = await send('party_request', { join_code: { code: opts['join-code'] } });
    log(`${ms()}  ← ${join.caseName}\n${full(join.value)}`);
  }

  // ----------------------------------------------------- aceitar convite
  if (typeof opts['accept-from'] === 'string') {
    log(`\n== party_request{answer} aceitando ${opts['accept-from']}`);
    const answer = await send('party_request', {
      answer: { from_account: Number(opts['accept-from']), accept: true }
    });
    log(`${ms()}  ← ${answer.caseName}\n${full(answer.value)}`);
  }

  // ---------------------------------------------------------------- sair
  if (opts.leave) {
    log(`\n== party_request{leave}`);
    const leave = await send('party_request', { leave: {} });
    log(`${ms()}  ← ${leave.caseName}\n${full(leave.value)}`);
  }

  if (opts.disband) {
    log(`\n== party_request{disband}`);
    const dis = await send('party_request', { disband: {} });
    log(`${ms()}  ← ${dis.caseName}\n${full(dis.value)}`);
  }

  // --------------------------------------------------------------- escutar
  const segundos = Number(opts.watch) || 0;
  if (segundos > 0) {
    log(`\n== escutando pushes por ${segundos}s`);
    await new Promise(r => setTimeout(r, segundos * 1000));
  }

  log(`\n== estado final`);
  const fim = await send('party_request', { get: {} });
  log(`${ms()}  ← ${fim.caseName}\n${full(fim.value)}`);

  clearInterval(ping);
  ws.close();
  setTimeout(() => process.exit(0), 500);
})().catch(e => {
  log('!! erro fatal:', e.message);
  process.exit(1);
});
