/**
 * @file mail-probe.js
 * Mede o correio real (`mail_request`) de uma conta: lista a caixa crua e,
 * opcionalmente, resgata uma entrada e mostra o que o servidor devolve.
 *
 *   # só listar a caixa da conta 7 (1-based, como o painel conta)
 *   npx electron tools/mail-probe.js --conta 7
 *
 *   # resgatar uma entrada pelo id e ver o resultado + o saldo depois
 *   npx electron tools/mail-probe.js --conta 7 --claim 12345
 *
 * CUIDADO: `--claim` resgata de verdade.
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
const codec = getCodec();
const full = v => JSON.stringify(v, null, 2);

const dispatchers = new Map();
function proxyDispatcher(proxyUrl) {
  if (!proxyUrl) return null;
  if (dispatchers.has(proxyUrl)) return dispatchers.get(proxyUrl);
  const undici = require('undici');
  const socks = /^socks/i.test(proxyUrl);
  const Agent = socks ? undici.Socks5ProxyAgent : undici.ProxyAgent;
  const dispatcher = new Agent(proxyUrl);
  dispatchers.set(proxyUrl, dispatcher);
  return dispatcher;
}

function doCofre(numero) {
  const { app, safeStorage } = require('electron');
  const path = require('path');
  app.name = 'leveling-launcher';
  try {
    app.setPath('userData', path.join(app.getPath('appData'), 'leveling-launcher'));
  } catch {}
  return app.whenReady().then(() => {
    const { LevelingCredentialStore } = require('../src/domain/leveling-credentials');
    const store = new LevelingCredentialStore({ safeStorage });
    store.ensureCapacity(64);
    const { accounts } = store.load();
    const acc = accounts[numero - 1];
    if (!acc || !acc.username) throw new Error(`conta ${numero} não está configurada`);
    return { user: acc.username, pass: acc.password, proxy: acc.proxy || '' };
  });
}

const QUIET = new Set([
  'world_events', 'world_delta', 'entity_spawn', 'entity_despawn', 'world_snapshot',
  'move_ack', 'content_catalog', 'shadow_delta', 'shadow_page', 'social_push',
  'shadow_species_page', 'inventory_page', 'fight_rules', 'hunt_session'
]);

class Lado {
  constructor(cred) {
    Object.assign(this, cred);
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Map();
    this.gold = 0;
  }

  async connect() {
    const init = { headers: { Origin: ORIGIN } };
    const dispatcher = proxyDispatcher(this.proxy);
    if (dispatcher) init.dispatcher = dispatcher;
    this.ws = new WebSocket(WS_URL, init);
    this.ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('conexão falhou'));
      setTimeout(() => reject(new Error('timeout ao conectar')), 20000);
    });
    this.ws.onmessage = e => this.onPacket(e.data);

    const auth = await this.send('login', { username: this.user, password: this.pass });
    if (auth.caseName !== 'auth_ok') {
      throw new Error(`login recusado: ${auth.caseName} ${JSON.stringify(auth.value)}`);
    }
    console.log(`== login ok  account_id=${auth.value.account_id}  ${auth.value.username}`);
    this.ping = setInterval(() => this.send('ping', { client_time_ms: Date.now() }), 15000);
    await this.waitFor('character_state', 8000);
    console.log(`== ouro no saldo: ${this.gold}`);
  }

  close() {
    clearInterval(this.ping);
    if (this.ws) this.ws.close();
  }

  send(caseName, value, timeoutMs = 12000) {
    const id = this.nextId++;
    let payload;
    try {
      payload = codec.encode(id, caseName, value);
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

  onPacket(data) {
    const buf = Buffer.from(data);
    let head;
    try { head = codec.peek(buf); } catch { return; }
    if (!head.caseName) return;
    if (!head.requestId && QUIET.has(head.caseName)) return;

    let packet;
    try { packet = codec.decode(buf); } catch { return; }
    const value = packet.value || {};

    if (packet.requestId && this.pending.has(packet.requestId)) {
      const entry = this.pending.get(packet.requestId);
      this.pending.delete(packet.requestId);
      entry.resolve({ caseName: packet.caseName, value });
      return;
    }

    if (packet.caseName === 'character_state' || packet.caseName === 'character_patch') {
      if (value.wallet && value.wallet.gold != null) this.gold = Number(value.wallet.gold) || 0;
    }
    if (packet.caseName === 'mail_push') console.log(`PUSH mail_push\n${full(value)}`);

    const list = this.waiters.get(packet.caseName);
    if (list && list.length) {
      this.waiters.set(packet.caseName, []);
      for (const entry of list) { clearTimeout(entry.timer); entry.resolve(value); }
    }
  }
}

(async () => {
  const numero = Number(opts.conta);
  if (!numero) throw new Error('uso: --conta 7 [--claim <id>]');
  const cred = await doCofre(numero);
  console.log(`== conta ${numero} (${cred.user})`);

  const lado = new Lado(cred);
  try {
    await lado.connect();

    const size = Number(opts.size) || 20;
    if (opts.listar === undefined && !opts.claim) opts.listar = true;
    const vistos = new Set();
    if (opts.varrer) {
      for (const pg of [0, 1, 2]) {
        const r = await lado.send('mail_request', { list: { page: pg, page_size: 10 } });
        const p = (r.value && r.value.page) || {};
        const ids = (p.entries || []).map(e => e.id).join(',');
        console.log(`page ${pg} size 10 → entries=${(p.entries || []).length} eco_page=${p.page} ids=${ids}`);
      }
      throw new Error('fim da varredura');
    }

    // `page` é 0-based: medido.
    for (let page = 0; opts.listar && page <= 40; page++) {
      const r = await lado.send('mail_request', { list: { page, page_size: size } });
      const p = (r.value && r.value.page) || {};
      const entries = p.entries || [];
      console.log(`\n== página ${page} (size ${size}): ${entries.length} de ${p.total}, unclaimed=${p.unclaimed}`);
      if (page === 1) console.log(full(entries[0]));
      for (const e of entries) {
        vistos.add(String(e.id));
        console.log(`   id=${e.id} kind=${e.kind} subj=${e.subject_key} gold=${e.gold || 0} dia=${e.diamonds || 0} itens=${(e.items || []).length} claimed=${e.claimed_at_ms ? 'sim' : 'NAO'} held=${e.held_until_ms || 0}`);
      }
      if (!entries.length) break;
    }
    console.log(`\n== ids distintos vistos: ${vistos.size}`);

    if (opts.claim) {
      console.log(`\n== mail_request{claim id=${opts.claim}}  (ouro antes: ${lado.gold})`);
      const r = await lado.send('mail_request', { claim: { id: Number(opts.claim) } });
      console.log(`← ${r.caseName}\n${full(r.value)}`);
      await new Promise(x => setTimeout(x, 2000));
      console.log(`== ouro depois: ${lado.gold}`);
    }
  } catch (e) {
    console.error('ERRO:', e.message);
  } finally {
    lado.close();
    setTimeout(() => process.exit(0), 300);
  }
})();
