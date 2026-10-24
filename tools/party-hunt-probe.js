/**
 * @file party-hunt-probe.js
 * Mede como um grupo volta à caçada depois de montado.
 *
 * `party-create-probe.js` provou que montar a PT deixa os membros em
 * `cidade-seul`: `leave` manda para a cidade (`party.left.to_city`) e entrar no
 * grupo não devolve ninguém. Esta sonda responde o que falta:
 *
 *   1. `start_hunt` do líder arrasta o grupo, ou cada conta precisa do seu?
 *   2. se arrasta, quanto tempo os membros levam para aparecer na cena?
 *   3. `start_hunt` de um membro em grupo é aceito ou recusado?
 *
 *   npx electron tools/party-hunt-probe.js --pass P [--tab N] [--each]
 *
 * `--each` manda `start_hunt` em cada conta; sem a flag, só no líder.
 *
 * MEXE NAS CONTAS DE VERDADE e derruba as sessões de WebView delas.
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
  console.error('uso: npx electron tools/party-hunt-probe.js --pass P [--tab N] [--each]');
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
  'social_push', 'guild_push', 'market_push', 'mail_push', 'news_push', 'admin_push',
  'hunt_session', 'character_patch'
]);

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

  tag() { return `[${this.index}:${this.user}]`; }

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

  send(caseName, value, timeoutMs = 15000) {
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
      log(`${ms()} ${this.tag()} scene_enter ${value.scene_id} kind=${value.kind}` +
        (value.hunt && value.hunt.gate_id ? ` hunt=${value.hunt.gate_id}/${value.hunt.tier_min}` : ''));
    }
    if (packet.caseName === 'party_push' && value.state) {
      this.party = value.state;
    }
    if (packet.caseName === 'notice' && value.code !== 'notifications.server_restart') {
      log(`${ms()} ${this.tag()} notice: ${JSON.stringify(value)}`);
    }
    if (packet.caseName === 'error' || packet.caseName === 'session_ended') {
      log(`${ms()} ${this.tag()} ${packet.caseName}: ${JSON.stringify(value)}`);
    }

    this.fire(packet.caseName, value);
  }

  /** Onde cada membro está, do ponto de vista do grupo. */
  lugares() {
    const st = this.party;
    if (!st || !st.party_id) return 'sem grupo';
    return (st.members || []).map(m =>
      `${m.name}${m.leader ? '*' : ''}=${m.place || '-'}${m.hunt_gate_id ? '/' + m.hunt_gate_id : ''}`
    ).join('  ');
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

  const probes = slots.map(s => {
    let dispatcher = null;
    try { dispatcher = proxyDispatcher(s.creds.proxy || ''); } catch (e) {
      log(`!! proxy da conta ${s.index}: ${e.message}`);
    }
    return new Probe(s.index, s.creds, codec, dispatcher);
  });

  try {
    log(`== conectar ${probes.length} contas`);
    for (const p of probes) {
      await p.open();
      if (!await p.login()) throw new Error(`login falhou em ${p.user}`);
    }

    log(`\n== estado inicial`);
    for (const p of probes) {
      await p.getParty();
      log(`   ${p.tag()} cena=${p.scene && p.scene.scene_id} caçada=${p.hunt ? p.hunt.gate_id + '/' + p.hunt.tier_min + '/' + p.hunt.difficulty : '-'}`);
    }
    const lider = probes.find(p => p.party && (p.party.members || []).some(m => m.leader && String(m.account_id) === String(p.accountId))) || probes[0];
    log(`   líder: ${lider.tag()}`);
    log(`   lugares: ${lider.lugares()}`);

    // O bilhete: a caçada que o líder já estava fazendo.
    const ticket = lider.hunt;
    if (!ticket) throw new Error('o líder não está em caçada; sem bilhete não há o que medir');
    log(`   bilhete do líder: ${JSON.stringify(ticket)}`);

    // ---------------------------------------------- start_hunt só no líder
    log(`\n== ${lider.tag()} start_hunt (só o líder)`);
    const tIda = Date.now();
    const res = await lider.send('start_hunt', {
      gate_id: ticket.gate_id,
      tier_min: Number(ticket.tier_min) || 0,
      difficulty: ticket.difficulty || ''
    });
    log(`   ← ${res.caseName} ${full(res.value)}`);
    await lider.waitFor('scene_enter', 15000);
    log(`   líder entrou em ${lider.scene && lider.scene.scene_id} após ${Date.now() - tIda}ms`);

    // Os membros vão sozinhos? Observa as cenas deles sem mandar nada.
    log(`\n== os membros são arrastados?`);
    const membros = probes.filter(p => p !== lider);
    await Promise.all(membros.map(async p => {
      const cena = await p.waitFor('scene_enter', 12000);
      log(`   ${p.tag()} ${cena ? 'scene_enter ' + cena.scene_id : 'NENHUM scene_enter em 12s'}`);
    }));

    await new Promise(r => setTimeout(r, 2000));
    await lider.getParty();
    log(`   lugares: ${lider.lugares()}`);

    // ------------------------------------------- start_hunt em cada membro
    const faltam = membros.filter(p => !p.scene || p.scene.kind !== 'SCENE_KIND_HUNT');
    if (faltam.length && opts.each) {
      log(`\n== start_hunt em cada membro que ficou fora (${faltam.map(p => p.user).join(', ')})`);
      for (const p of faltam) {
        const t = Date.now();
        const r = await p.send('start_hunt', {
          gate_id: ticket.gate_id,
          tier_min: Number(ticket.tier_min) || 0,
          difficulty: ticket.difficulty || ''
        });
        log(`   ${p.tag()} ← ${r.caseName} ${full(r.value)}`);
        const cena = await p.waitFor('scene_enter', 15000);
        log(`   ${p.tag()} cena=${cena && cena.scene_id} em ${Date.now() - t}ms`);
      }
    } else if (faltam.length) {
      log(`\n== ${faltam.length} membro(s) fora da caçada; rode com --each para medir o start_hunt deles`);
    } else {
      log(`\n== todos entraram na caçada sem start_hunt próprio`);
    }

    await new Promise(r => setTimeout(r, 2500));
    log(`\n== estado final`);
    for (const p of probes) {
      await p.getParty();
      log(`   ${p.tag()} cena=${p.scene && p.scene.scene_id} kind=${p.scene && p.scene.kind} instance=${p.scene && p.scene.instance_id}`);
    }
    await lider.getParty();
    log(`   lugares: ${lider.lugares()}`);
    log(`   mesma instância? ${[...new Set(probes.map(p => p.scene && p.scene.instance_id))].join(' / ')}`);
  } catch (e) {
    log(`\n!! sonda falhou: ${e.message}`);
  } finally {
    for (const p of probes) p.close();
    setTimeout(() => app.quit(), 800);
  }
});
