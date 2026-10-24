/**
 * @file party-create-probe.js
 * Mede o ciclo real de montar uma PT de quatro contas contra o servidor.
 *
 * Conecta as quatro contas de uma aba (cada uma pela rota de proxy que o
 * launcher já guarda), desfaz o grupo existente e executa, passo a passo:
 *
 *   leave/disband → create (líder) → new_code → join_code (membros)
 *   → join_answer, se o servidor pedir → get final
 *
 * Cada etapa registra a resposta crua. O que esta sonda responde:
 *   1. `create` devolve `party_response` com estado, ou só push?
 *   2. o código vem no `create` ou exige `new_code`?
 *   3. `join_code` entra direto ou cai em `join_requests` do líder?
 *   4. entrar no grupo tira o membro da caçada dele?
 *
 * MEXE NAS CONTAS DE VERDADE: desfaz o grupo atual e monta outro. Também
 * derruba a sessão da WebView de cada conta, porque o servidor aceita uma
 * sessão por conta.
 *
 *   npx electron tools/party-create-probe.js --pass P
 *   npx electron tools/party-create-probe.js --pass P --tab 0
 *   npx electron tools/party-create-probe.js --pass P --invite   (por nome, não por código)
 *
 * Ferramenta de investigação, não parte do launcher.
 */

'use strict';

const path = require('path');
const { app, safeStorage } = require('electron');

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].replace(/^--/, '');
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

const opts = args();
if (!opts.pass) {
  console.error('uso: npx electron tools/party-create-probe.js --pass P [--tab N] [--invite]');
  process.exit(1);
}

const ACCOUNTS_PER_TAB = 4;
const WS_URL = 'wss://game.levelingidle2d.com.br:8443/ws';
const ORIGIN = 'https://levelingidle2d.com.br';

app.name = 'leveling-launcher';
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'leveling-launcher'));
} catch {}

const log = (...a) => console.log(...a);
const full = v => JSON.stringify(v, null, 2);
const T0 = Date.now();
const ms = () => String(Date.now() - T0).padStart(6) + 'ms';

const QUIET = new Set([
  'world_snapshot', 'world_events', 'world_delta', 'entity_spawn', 'entity_despawn',
  'move_ack', 'npc_interaction', 'content_catalog', 'shadow_delta', 'shadow_page',
  'shadow_species_page', 'inventory_page', 'fight_rules', 'commerce_push',
  'social_push', 'guild_push', 'market_push', 'mail_push', 'news_push'
]);

/** Uma conexão de sonda por conta. Mesma mecânica do monitor, sem refill. */
class Probe {
  constructor(index, creds, codec, dispatcher) {
    this.index = index;
    this.user = creds.username;
    this.pass = opts.pass;
    this.codec = codec;
    this.dispatcher = dispatcher;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Map();
    this.ws = null;
    this.accountId = null;
    this.scene = null;
    this.hunt = null;
    this.party = null;
  }

  tag() {
    return `[${this.index}:${this.user}]`;
  }

  async open() {
    const init = { headers: { Origin: ORIGIN } };
    if (this.dispatcher) init.dispatcher = this.dispatcher;
    const ws = new WebSocket(WS_URL, init);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('conexão falhou'));
      setTimeout(() => reject(new Error('timeout ao conectar')), 20000);
    });
    ws.onmessage = e => this.onPacket(e.data);
    ws.onclose = e => log(`${ms()} ${this.tag()} == socket fechado code=${e && e.code}`);
  }

  waitFor(caseName, timeoutMs = 10000) {
    return new Promise(resolve => {
      const list = this.waiters.get(caseName) || [];
      const entry = { resolve };
      entry.timer = setTimeout(() => {
        const l = this.waiters.get(caseName) || [];
        const i = l.indexOf(entry);
        if (i >= 0) l.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      list.push(entry);
      this.waiters.set(caseName, list);
    });
  }

  fire(caseName, value) {
    const list = this.waiters.get(caseName);
    if (!list || !list.length) return;
    this.waiters.set(caseName, []);
    for (const entry of list) {
      clearTimeout(entry.timer);
      entry.resolve(value);
    }
  }

  send(caseName, value, timeoutMs = 12000) {
    const id = this.nextId++;
    let payload;
    try {
      payload = this.codec.encode(id, caseName, value);
    } catch (e) {
      return Promise.resolve({ caseName: 'ENCODE_FAIL', value: { message: e.message } });
    }
    this.ws.send(payload);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ caseName: 'TIMEOUT', value: {} });
      }, timeoutMs);
      this.pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); } });
    });
  }

  onPacket(data) {
    const buf = Buffer.from(data);
    let head;
    try { head = this.codec.peek(buf); } catch { return; }
    if (!head.caseName) return;
    if (!head.requestId && QUIET.has(head.caseName)) return;

    let packet;
    try { packet = this.codec.decode(buf); } catch { return; }
    const value = packet.value || {};

    if (packet.requestId && this.pending.has(packet.requestId)) {
      const entry = this.pending.get(packet.requestId);
      this.pending.delete(packet.requestId);
      entry.resolve({ caseName: packet.caseName, value });
      return;
    }

    if (packet.caseName === 'scene_enter') {
      this.scene = value;
      if (value.hunt && value.hunt.gate_id) this.hunt = value.hunt;
    }
    if (packet.caseName === 'party_push' && value.state) {
      this.party = value.state;
      log(`${ms()} ${this.tag()} PUSH party_push  ${this.resumoPt(value.state)}`);
    } else if (packet.caseName === 'party_push') {
      log(`${ms()} ${this.tag()} PUSH party_push  ${JSON.stringify(Object.keys(value))} ${full(value)}`);
    } else if (packet.caseName === 'notice' || packet.caseName === 'error') {
      log(`${ms()} ${this.tag()} ${packet.caseName}: ${JSON.stringify(value)}`);
    } else if (packet.caseName === 'session_ended') {
      log(`${ms()} ${this.tag()} !! session_ended ${JSON.stringify(value)}`);
    }

    this.fire(packet.caseName, value);
  }

  /** Visão curta do grupo: é isso que o launcher vai mostrar. */
  resumoPt(state) {
    if (!state || !state.party_id || state.party_id === '0') return 'sem grupo';
    const nomes = (state.members || []).map(m => m.name + (m.leader ? '*' : '')).join(', ');
    const pedidos = (state.join_requests || []).map(r => r.name).join(', ');
    const enviados = (state.invites_sent || []).map(r => r.name).join(', ');
    const code = state.settings && state.settings.code;
    return `pt=${state.party_id} code=${code || '-'} membros=[${nomes}]` +
      (pedidos ? ` pedidos=[${pedidos}]` : '') +
      (enviados ? ` enviados=[${enviados}]` : '');
  }

  async login() {
    const auth = await this.send('login', { username: this.user, password: this.pass });
    if (auth.caseName !== 'auth_ok') {
      log(`${ms()} ${this.tag()} !! login recusado: ${auth.caseName} ${full(auth.value)}`);
      return false;
    }
    this.accountId = auth.value.account_id != null ? String(auth.value.account_id) : null;
    log(`${ms()} ${this.tag()} login ok account_id=${this.accountId}`);
    this.ping = setInterval(() => this.send('ping', { client_time_ms: Date.now() }), 15000);
    await this.waitFor('scene_enter', 10000);
    return true;
  }

  async getParty() {
    const res = await this.send('party_request', { get: {} });
    if (res.caseName === 'party_response') this.party = res.value.state || null;
    return res;
  }

  close() {
    clearInterval(this.ping);
    try { this.ws && this.ws.close(1000); } catch {}
  }
}

app.whenReady().then(async () => {
  const { getCodec } = require('../src/domain/leveling-codec');
  const { proxyDispatcher } = require('../src/domain/leveling-headless-service');
  const { LevelingCredentialStore } = require('../src/domain/leveling-credentials');

  const codec = getCodec();
  const store = new LevelingCredentialStore({ safeStorage });
  store.ensureCapacity(64);
  const { accounts } = store.load();

  const tab = Number(opts.tab) || 0;
  const base = tab * ACCOUNTS_PER_TAB;
  const slots = [];
  for (let i = 0; i < ACCOUNTS_PER_TAB; i++) {
    const acc = accounts[base + i];
    if (acc && acc.username) slots.push({ index: base + i, creds: acc });
  }

  if (slots.length < 2) {
    log('!! a aba precisa de pelo menos duas contas configuradas');
    app.quit();
    return;
  }

  log(`== aba ${tab}: ${slots.map(s => s.creds.username).join(', ')}`);

  const probes = slots.map(s => {
    let dispatcher = null;
    try {
      dispatcher = proxyDispatcher(s.creds.proxy || '');
    } catch (e) {
      log(`!! proxy da conta ${s.index}: ${e.message}`);
    }
    return new Probe(s.index, s.creds, codec, dispatcher);
  });

  try {
    // ------------------------------------------------------------ 1. conectar
    log(`\n== 1. conectar e autenticar as ${probes.length} contas`);
    for (const p of probes) {
      await p.open();
      const ok = await p.login();
      if (!ok) throw new Error(`login falhou em ${p.user}`);
    }

    // ------------------------------------------------------- 2. estado atual
    log(`\n== 2. estado de grupo de cada conta`);
    for (const p of probes) {
      await p.getParty();
      log(`   ${p.tag()} ${p.resumoPt(p.party)}  cena=${p.scene && p.scene.scene_id} caçada=${p.hunt ? p.hunt.gate_id + '/' + p.hunt.tier_min + '/' + p.hunt.difficulty : '-'}`);
    }

    const lider = probes[0];
    const membros = probes.slice(1);

    // ----------------------------------------------------- 3. desfazer o atual
    log(`\n== 3. desfazer o grupo atual`);
    for (const p of membros) {
      if (p.party && p.party.party_id && p.party.party_id !== '0') {
        const res = await p.send('party_request', { leave: {} });
        log(`   ${p.tag()} leave → ${res.caseName} ${full(res.value)}`);
      }
    }
    if (lider.party && lider.party.party_id && lider.party.party_id !== '0') {
      const res = await lider.send('party_request', { disband: {} });
      log(`   ${lider.tag()} disband → ${res.caseName} ${full(res.value)}`);
    }
    await new Promise(r => setTimeout(r, 1500));
    for (const p of probes) {
      await p.getParty();
      log(`   ${p.tag()} ${p.resumoPt(p.party)}`);
    }

    // -------------------------------------------------------------- 4. criar
    log(`\n== 4. ${lider.tag()} party_request{create}`);
    // Medido: `ClientMessage.verify` recusa o nome do enum e aceita só o
    // número. 0 = REQUEST, 1 = OPEN, 2 = CLOSED.
    const privacy = opts.privacy != null ? Number(opts.privacy) : 1;
    const settings = {
      privacy,
      capacity: 4,
      objective: 'Launcher',
      auto_accept_friends: true,
      auto_accept_guild: true
    };
    log(`   settings enviados: ${JSON.stringify(settings)}`);
    const create = await lider.send('party_request', { create: { settings } });
    log(`   ← ${create.caseName}\n${full(create.value)}`);
    if (create.caseName === 'party_response') lider.party = create.value.state || null;

    const ptId = lider.party && lider.party.party_id;
    let code = lider.party && lider.party.settings && lider.party.settings.code;
    log(`   party_id=${ptId}  code no create=${code || '(nenhum)'}`);

    // ------------------------------------------------------- 5. código, se preciso
    if (!code) {
      log(`\n== 5. sem código no create; pedindo new_code`);
      const nc = await lider.send('party_request', { new_code: {} });
      log(`   ← ${nc.caseName}\n${full(nc.value)}`);
      if (nc.caseName === 'party_response' && nc.value.state) {
        lider.party = nc.value.state;
        code = nc.value.state.settings && nc.value.state.settings.code;
      }
      log(`   code=${code || '(nenhum)'}`);
    } else {
      log(`\n== 5. código já veio no create: ${code}`);
    }

    // ------------------------------------------------------------- 6. entrar
    if (opts.invite) {
      log(`\n== 6. caminho por CONVITE (invite por nome + answer)`);
      for (const p of membros) {
        const inv = await lider.send('party_request', { invite: { name: p.user } });
        log(`   ${lider.tag()} invite ${p.user} → ${inv.caseName}\n${full(inv.value)}`);

        const recebeu = await p.waitFor('party_push', 8000);
        log(`   ${p.tag()} push após convite: ${recebeu ? full(recebeu) : '(nenhum)'}`);

        const ans = await p.send('party_request', {
          answer: { from_account: Number(lider.accountId), accept: true }
        });
        log(`   ${p.tag()} answer aceitar → ${ans.caseName}\n${full(ans.value)}`);
        await new Promise(r => setTimeout(r, 1200));
      }
    } else {
      log(`\n== 6. caminho por CÓDIGO (join_code)`);
      if (!code) throw new Error('sem código para entrar; rode com --invite');
      for (const p of membros) {
        const join = await p.send('party_request', { join_code: { code } });
        log(`   ${p.tag()} join_code ${code} → ${join.caseName}\n${full(join.value)}`);
        if (join.caseName === 'party_response') p.party = join.value.state || null;
        log(`   ${p.tag()} depois do join: ${p.resumoPt(p.party)}`);

        // O líder pode ter recebido um pedido em vez de um membro novo.
        await new Promise(r => setTimeout(r, 1200));
        await lider.getParty();
        log(`   ${lider.tag()} ${lider.resumoPt(lider.party)}`);

        const pedido = (lider.party && lider.party.join_requests || [])
          .find(r => String(r.account_id) === String(p.accountId));
        if (pedido) {
          log(`   → o servidor pediu aprovação; ${lider.tag()} join_answer`);
          const ja = await lider.send('party_request', {
            join_answer: { account_id: Number(p.accountId), accept: true }
          });
          log(`   ← ${ja.caseName}\n${full(ja.value)}`);
          await new Promise(r => setTimeout(r, 1200));
        }
      }
    }

    // -------------------------------------------- 7. devolver o grupo à caçada
    // Medido: `leave` manda o membro para a cidade (`party.left.to_city`) e
    // entrar no grupo não o devolve. Um `start_hunt` do líder puxa todos
    // (`party.follow.pulled`), então é ele que fecha o ciclo.
    if (lider.hunt) {
      log(`\n== 7. ${lider.tag()} start_hunt para puxar o grupo de volta`);
      const volta = await lider.send('start_hunt', {
        gate_id: lider.hunt.gate_id,
        tier_min: Number(lider.hunt.tier_min) || 0,
        difficulty: lider.hunt.difficulty || ''
      });
      log(`   ← ${volta.caseName}\n${full(volta.value)}`);
      await Promise.all(probes.map(p => p.waitFor('scene_enter', 12000)));
      await new Promise(r => setTimeout(r, 1500));
    } else {
      log(`\n== 7. líder sem bilhete de caçada; grupo fica na cidade`);
    }

    // ------------------------------------------------------- 8. estado final
    log(`\n== 8. estado final de cada conta`);
    for (const p of probes) {
      await p.getParty();
      log(`   ${p.tag()} ${p.resumoPt(p.party)}`);
      log(`       cena=${p.scene && p.scene.scene_id} caçada=${p.hunt ? p.hunt.gate_id + '/' + p.hunt.tier_min + '/' + p.hunt.difficulty : '-'}`);
    }

    const finalPt = lider.party;
    log(`\n== resumo`);
    log(`   party_id   : ${finalPt && finalPt.party_id}`);
    log(`   membros    : ${(finalPt && finalPt.members || []).length}/${finalPt && finalPt.max_members}`);
    log(`   code       : ${finalPt && finalPt.settings && finalPt.settings.code}`);
    log(`   settings   : ${full(finalPt && finalPt.settings)}`);
  } catch (e) {
    log(`\n!! sonda falhou: ${e.message}`);
  } finally {
    for (const p of probes) p.close();
    setTimeout(() => app.quit(), 800);
  }
});
