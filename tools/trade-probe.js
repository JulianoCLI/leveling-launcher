/**
 * @file trade-probe.js
 * Mede o protocolo real de troca (`trade_request`) contra o servidor, com
 * **duas contas na mesma sonda**.
 *
 * Nada aqui é suposição: cada etapa manda o pacote e registra a resposta crua,
 * para que a automação de câmbio (concentrar ouro numa conta) use só o que o
 * servidor aceita. As perguntas que esta sonda responde estão listadas em
 * scratch/estudo-cambio.md, item 4.
 *
 *   # só ler estado: amizade, canal, cena, e escutar pushes
 *   node tools/trade-probe.js --a-user U1 --a-pass P1 --b-user U2 --b-pass P2
 *
 *   # pelas contas já configuradas no launcher (1-based, como o painel mostra)
 *   npx electron tools/trade-probe.js --a 9 --b 8
 *
 *   # garantir amizade entre as duas
 *   ... --amizade
 *
 *   # viajar para seoul e alinhar canal, sem trocar nada
 *   ... --reuniao
 *
 *   # troca completa de 1 de ouro: A -> B, com correio no fim
 *   ... --trocar 1
 *
 *   # medir se a troca é recusada dentro da caçada (não viaja antes)
 *   ... --trocar 1 --sem-viagem
 *
 * CUIDADO: `--trocar` move ouro de verdade e é irreversível. Só ouro é
 * ofertado; item e sombra nunca entram na oferta.
 *
 * Ferramenta de investigação, não parte do launcher.
 */

'use strict';

const { getCodec } = require('../src/domain/leveling-codec');

const WS_URL = 'wss://game.levelingidle2d.com.br:8443/ws';
const ORIGIN = 'https://levelingidle2d.com.br';
const CIDADE = 'cidade-seul';
/** Mesmo alcance que o refill usa para chegar ao balcão do NPC. */
const ALCANCE = 700;

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

/**
 * Rota de saída da conta, igual ao serviço: o servidor recusa várias contas
 * vindo do mesmo IP (`session.multi_account_ip`), e o `WebSocket` do Node é o
 * do `undici`, que só aceita proxy pela opção `dispatcher`.
 */
const dispatchers = new Map();
function proxyDispatcher(proxyUrl) {
  if (!proxyUrl) return null;
  if (dispatchers.has(proxyUrl)) return dispatchers.get(proxyUrl);
  const undici = require('undici');
  const socks = /^socks/i.test(proxyUrl);
  const Agent = socks ? undici.Socks5ProxyAgent : undici.ProxyAgent;
  if (!Agent) throw new Error(`proxy ${socks ? 'SOCKS' : 'HTTP'} não suportado por esta versão do undici`);
  const dispatcher = new Agent(proxyUrl);
  dispatchers.set(proxyUrl, dispatcher);
  return dispatcher;
}

/**
 * Credenciais pelas contas já configuradas no launcher, para não redigitar
 * senha nem repetir o proxy à mão. Exige `electron` porque o cofre é o
 * `safeStorage` (DPAPI) — o mesmo caminho do `tools/creds-dump.js`.
 */
function doCofre(numeros) {
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
    return numeros.map(n => {
      // O painel conta a partir de 1; o cofre guarda a partir de 0.
      const acc = accounts[n - 1];
      if (!acc || !acc.username) throw new Error(`conta ${n} não está configurada`);
      if (!acc.password) throw new Error(`conta ${n} (${acc.username}) não tem senha no cofre`);
      return { user: acc.username, pass: acc.password, proxy: acc.proxy || '' };
    });
  });
}
const full = v => JSON.stringify(v, null, 2);
const T0 = Date.now();
const ms = () => String(Date.now() - T0).padStart(6) + 'ms';

/**
 * Pushes de alto volume. `world_snapshot` **não** entra aqui: é por ele que a
 * posição do personagem é lida, que é o único jeito de saber que ele chegou.
 */
const QUIET = new Set([
  'world_events', 'world_delta', 'entity_spawn', 'entity_despawn',
  'move_ack', 'content_catalog', 'shadow_delta', 'shadow_page',
  'shadow_species_page', 'inventory_page', 'fight_rules', 'hunt_session'
]);

/**
 * `FriendAction.Kind` como número. Medido: o `verify` do codec responde
 * `enum value expected` ao nome (`KIND_REQUEST`), porque o enum é aninhado em
 * `FriendAction` e o nome só resolve no escopo do pai. É o mesmo motivo pelo
 * qual `MARKET_KIND_NUM` existe no serviço.
 */
const FRIEND_KIND = {
  REQUEST: 1, ACCEPT: 2, DECLINE: 3, REMOVE: 4, BLOCK: 5, UNBLOCK: 6
};

/** Pushes que a sonda imprime inteiros: são o objeto da medição. */
const INTERESSE = new Set(['trade_response', 'trade_push', 'social_response', 'notice', 'error']);

/**
 * Uma conta na sonda. Espelha o mínimo do `LevelingHeadlessClient`: envio com
 * resposta por `requestId`, espera por push, e leitura de cena/posição/ouro.
 */
class Lado {
  constructor(tag, cred) {
    this.tag = tag;
    this.user = cred.user;
    this.pass = cred.pass;
    this.proxy = cred.proxy || '';
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Map();

    this.accountId = null;
    this.name = '';
    this.gold = 0;
    this.scene = { id: '', channel: 0 };
    this.ownEntity = 0;
    this.pos = null;
    /** Bilhete de volta: sem ele a sonda não tira a conta da caçada. */
    this.huntTicket = null;
  }

  log(...a) { console.log(`${ms()} [${this.tag}]`, ...a); }

  async connect() {
    const init = { headers: { Origin: ORIGIN } };
    const dispatcher = proxyDispatcher(this.proxy);
    if (dispatcher) init.dispatcher = dispatcher;
    this.log(`== conectando${this.proxy ? ' via proxy' : ' direto'}`);
    this.ws = new WebSocket(WS_URL, init);
    this.ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error(`${this.tag}: conexão falhou`));
      setTimeout(() => reject(new Error(`${this.tag}: timeout ao conectar`)), 20000);
    });
    this.ws.onmessage = e => this.onPacket(e.data);
    this.ws.onclose = e => this.log(`== socket fechado, code ${e && e.code}`);

    const auth = await this.send('login', { username: this.user, password: this.pass });
    if (auth.caseName !== 'auth_ok') {
      throw new Error(`${this.tag}: login recusado ${auth.caseName} ${JSON.stringify(auth.value)}`);
    }
    this.accountId = auth.value.account_id != null ? String(auth.value.account_id) : null;
    this.name = auth.value.username || '';
    this.log(`== login ok  account_id=${this.accountId} username=${this.name}`);

    this.ping = setInterval(() => this.send('ping', { client_time_ms: Date.now() }), 15000);
    await this.waitFor('character_state', 8000);
    this.log(`nome=${this.name} ouro=${this.gold} cena=${this.scene.id} canal=${this.scene.channel}`);
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

  /** Envio sem resposta: `travel`, `move_to` e `interact` não respondem. */
  emit(caseName, value) {
    this.ws.send(codec.encode(0, caseName, value));
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

    this.reduce(packet.caseName, value);

    if (INTERESSE.has(packet.caseName)) {
      this.log(`PUSH ${packet.caseName}\n${full(value)}`);
    } else if (packet.caseName !== 'world_snapshot') {
      this.log(`(${packet.caseName})`);
    }

    this.fire(packet.caseName, value);
  }

  reduce(caseName, value) {
    // Medido: o ouro vem em `wallet.gold`, tanto no snapshot completo quanto no
    // patch — igual ao `applyCharacter()` do serviço. Ler `value.gold` do patch
    // não acha nada e o saldo fica congelado.
    if (caseName === 'character_state' || caseName === 'character_patch') {
      if (value.identity) this.name = value.identity.name || this.name;
      if (value.wallet && value.wallet.gold != null) this.gold = Number(value.wallet.gold) || 0;
    }
    if (caseName === 'scene_enter') {
      this.scene = { id: value.scene_id || '', channel: Number(value.channel) || 0 };
      if (value.your_entity) this.ownEntity = Number(value.your_entity) || 0;
      // O bilhete de volta, lido igual ao do refill.
      if (value.hunt && value.hunt.gate_id) {
        this.huntTicket = {
          gate_id: value.hunt.gate_id,
          tier_min: Number(value.hunt.tier_min) || 0,
          difficulty: value.hunt.difficulty
        };
      }
    }
    if (caseName === 'world_snapshot' && this.ownEntity) {
      // Medido no refill: as entidades são `EntityState` direto, `x`/`y` estão
      // no próprio elemento, não aninhados.
      for (const ent of value.entities || []) {
        if (Number(ent.id) === this.ownEntity) {
          this.pos = { x: Number(ent.x) || 0, y: Number(ent.y) || 0 };
          break;
        }
      }
    }
  }

  /** Espera chegar ao ponto, observando as snapshots. Sem sleep. */
  async walkTo(target, alcance = ALCANCE) {
    for (let i = 0; i < 60; i++) {
      const snap = await this.waitFor('world_snapshot', 2000);
      if (!snap) return false;
      if (!this.pos) continue;
      if (Math.hypot(this.pos.x - target.x, this.pos.y - target.y) <= alcance) return true;
    }
    return false;
  }
}

// ----------------------------------------------------------------- amizade

async function medirAmizade(a, b) {
  console.log('\n== social_request{friend_list} nas duas');
  for (const lado of [a, b]) {
    const res = await lado.send('social_request', { friend_list: {} });
    lado.log(`← ${res.caseName}\n${full(res.value)}`);
  }

  if (!opts.amizade) return;

  console.log('\n== friend_action{REQUEST} de A para B');
  const pedido = await a.send('social_request', {
    friend_action: { kind: FRIEND_KIND.REQUEST, target: { account: Number(b.accountId) || 0, name: b.name } }
  });
  a.log(`← ${pedido.caseName}\n${full(pedido.value)}`);

  console.log('\n== friend_action{ACCEPT} de B para A');
  const aceite = await b.send('social_request', {
    friend_action: { kind: FRIEND_KIND.ACCEPT, target: { account: Number(a.accountId) || 0, name: a.name } }
  });
  b.log(`← ${aceite.caseName}\n${full(aceite.value)}`);
  // `became_friends` é o campo que diz se o par ficou de fato formado.

  console.log('\n== friend_list de novo, para conferir o par');
  const confere = await a.send('social_request', { friend_list: {} });
  a.log(`← ${confere.caseName}\n${full(confere.value)}`);
}

// ------------------------------------------------------------------ reunião

async function medirReuniao(a, b) {
  console.log('\n== travel para a cidade nas duas');
  for (const lado of [a, b]) {
    lado.log(`bilhete de volta: ${full(lado.huntTicket)}`);
    lado.emit('travel', { scene_id: CIDADE });
    const chegou = await lado.waitFor('scene_enter', 15000);
    lado.log(`chegou=${chegou && chegou.scene_id} canal=${lado.scene.channel}`);
  }

  console.log('\n== channel_list nas duas');
  for (const lado of [a, b]) {
    const res = await lado.send('channel_list', {});
    lado.log(`← ${res.caseName}\n${full(res.value)}`);
  }

  if (a.scene.channel !== b.scene.channel) {
    console.log(`\n== canais diferentes (A=${a.scene.channel} B=${b.scene.channel}): switch_channel em B`);
    const res = await b.send('switch_channel', { channel: a.scene.channel });
    b.log(`← ${res.caseName}\n${full(res.value)}`);
    await b.waitFor('scene_enter', 15000);
    b.log(`canal agora=${b.scene.channel}`);
  } else {
    console.log(`\n== já no mesmo canal (${a.scene.channel})`);
  }

  console.log('\n== posições');
  // As posições só aparecem nas snapshots; esperar uma de cada lado.
  await Promise.all([a.waitFor('world_snapshot', 5000), b.waitFor('world_snapshot', 5000)]);
  a.log(`pos=${full(a.pos)} entity=${a.ownEntity}`);
  b.log(`pos=${full(b.pos)} entity=${b.ownEntity}`);

  if (a.pos && b.pos) {
    const d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
    console.log(`distância inicial = ${Math.round(d)}`);
    if (d > ALCANCE) {
      console.log(`\n== A anda até B`);
      a.emit('move_to', { x: b.pos.x, y: b.pos.y });
      const perto = await a.walkTo(b.pos);
      a.log(`chegou perto=${perto} pos=${full(a.pos)}`);
    }
  }
}

// -------------------------------------------------------------------- troca

async function medirTroca(a, b, ouro) {
  console.log(`\n======================= TROCA de ${ouro} ouro: ${a.name} -> ${b.name}`);
  const ouroAntesA = a.gold;
  const ouroAntesB = b.gold;
  console.log(`ouro antes: A=${ouroAntesA} B=${ouroAntesB}`);

  // Um `completed` por lado: o que A vê traz `given_gold`, o que B vê traz
  // `received_gold`. Guardar só um perde metade da medição da taxa.
  const completados = {};
  let completou = null;
  let fechou = null;
  // Escuta solta: `completed` e `closed` podem chegar a qualquer momento, e
  // perder o `completed` é perder a medição inteira do item 4.7.
  const escuta = lado => {
    const original = lado.reduce.bind(lado);
    lado.reduce = (caseName, value) => {
      if (caseName === 'trade_push') {
        if (value.completed) {
          completados[lado.tag] = value.completed;
          completou = { lado: lado.tag, value: value.completed };
        }
        if (value.closed) fechou = { lado: lado.tag, value: value.closed };
      }
      original(caseName, value);
    };
  };
  escuta(a);
  escuta(b);

  try {
    // -------------------------------------------------------- 1. convite
    console.log('\n-- A: trade_request{invite}');
    const convite = await a.send('trade_request', {
      invite: { account: Number(b.accountId) || 0, name: b.name }
    });
    a.log(`← ${convite.caseName}\n${full(convite.value)}`);
    if (convite.caseName === 'error') {
      console.log('!! convite recusado — é aqui que aparece a exigência de amizade/canal/distância');
      return;
    }

    console.log('\n-- B: espera trade_push{invited}');
    const convidado = await b.waitFor('trade_push', 10000);
    b.log(`invited=${full(convidado && convidado.invited)}`);

    // -------------------------------------------------------- 2. aceitar
    console.log('\n-- B: trade_request{respond accept}');
    const respondeu = await b.send('trade_request', {
      respond: { from: Number(a.accountId) || 0, accept: true }
    });
    b.log(`← ${respondeu.caseName}\n${full(respondeu.value)}`);
    if (respondeu.caseName === 'error') return;

    // -------------------------------------------------------- 3. oferta
    // Só ouro. Item e sombra nunca entram: ofertar item por engano não volta.
    console.log('\n-- A: trade_request{set_offer gold}');
    const oferta = await a.send('trade_request', { set_offer: { gold: ouro } });
    a.log(`← ${oferta.caseName}\n${full(oferta.value)}`);
    if (oferta.caseName === 'error') return;

    // Conferência antes de qualquer trava: o estado tem de refletir o plano.
    const estado = await a.send('trade_request', { get_state: {} });
    a.log(`estado após oferta\n${full(estado.value)}`);
    const meGold = estado.value && estado.value.state && estado.value.state.me
      ? Number(estado.value.state.me.gold) || 0 : -1;
    if (meGold !== ouro) {
      console.log(`!! oferta divergente (esperado ${ouro}, estado ${meGold}) — cancelando`);
      await a.send('trade_request', { cancel: {} });
      return;
    }

    // -------------------------------------------------------- 4. travar
    console.log('\n-- A: trade_request{lock true}');
    const travaA = await a.send('trade_request', { lock: { locked: true } });
    a.log(`← ${travaA.caseName}\n${full(travaA.value)}`);

    // Item 4.3: mexer na oferta depois do lock derruba as travas?
    if (opts['medir-relock']) {
      console.log('\n-- A: set_offer DEPOIS do lock (mede se a trava cai)');
      const remexeu = await a.send('trade_request', { set_offer: { gold: ouro } });
      a.log(`← ${remexeu.caseName}\n${full(remexeu.value)}`);
      const depois = await a.send('trade_request', { get_state: {} });
      a.log(`estado após remexer\n${full(depois.value)}`);
    }

    console.log('\n-- B: trade_request{lock true}');
    const travaB = await b.send('trade_request', { lock: { locked: true } });
    b.log(`← ${travaB.caseName}\n${full(travaB.value)}`);

    // Item 4.4: confirmar antes de ambos travarem é aceito?
    const antesConfirm = await a.send('trade_request', { get_state: {} });
    a.log(`estado antes do confirm\n${full(antesConfirm.value)}`);

    // ---------------------------------------------------- 5. confirmar
    console.log('\n-- A: trade_request{confirm}');
    const confA = await a.send('trade_request', { confirm: { confirmed: true } });
    a.log(`← ${confA.caseName}\n${full(confA.value)}`);

    console.log('\n-- B: trade_request{confirm}');
    const confB = await b.send('trade_request', { confirm: { confirmed: true } });
    b.log(`← ${confB.caseName}\n${full(confB.value)}`);

    // ---------------------------------------------- 6. esperar o fecho
    console.log('\n-- esperando trade_push{completed}');
    for (let i = 0; i < 30 && !completou && !fechou; i++) {
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`completed A (quem deu)    = ${full(completados.A)}`);
    console.log(`completed B (quem recebeu)= ${full(completados.B)}`);
    console.log(`closed    = ${full(fechou)}`);
    const deu = Number((completados.A || {}).given_gold) || 0;
    const recebeu = Number((completados.B || {}).received_gold) || 0;
    console.log(`>> given_gold=${deu} received_gold=${recebeu} taxa=${deu - recebeu}`);
    const mailed = (completados.B || {}).mailed;
    const held = Number((completados.B || {}).held_until_ms) || 0;
    console.log(`>> mailed=${!!mailed} held_until_ms=${held || 'nenhum'}`);
    if (held) {
      const espera = held - Date.now();
      console.log(`>> RETENÇÃO de ${Math.round(espera / 1000)}s (${(espera / 3600000).toFixed(1)}h)`);
    }

    // ------------------------------------------------------- 7. correio
    // Medido: sem `mailed`, a troca entregou direto e a caixa não tem nada a
    // ver com isso. A listagem só vale a pena quando o servidor avisou que
    // mandou por correio.
    if (!mailed) {
      console.log('\n-- `mailed` ausente: a troca entregou direto, sem passar pelo correio');
    } else {
    console.log('\n-- B: mail_request{list} para descobrir o subject_key da troca');
    const correio = await b.send('mail_request', { list: { page: 1, page_size: 50 } });
    const pagina = (correio.value && correio.value.page) || {};
    for (const e of pagina.entries || []) {
      console.log(`   id=${e.id} kind=${e.kind} subject_key=${e.subject_key} gold=${e.gold} claimed=${!!Number(e.claimed_at_ms)} held=${e.held_until_ms || 0}`);
    }
    // Só a entrada não resgatada, com ouro, e sem retenção pendente. Nunca
    // `claim_all`: a caixa tem recompensa e prêmio que o usuário pode estar
    // guardando.
    const agora = Date.now();
    const alvo = (pagina.entries || []).find(e =>
      !Number(e.claimed_at_ms) &&
      Number(e.gold) > 0 &&
      Number(e.held_until_ms || 0) <= agora
    );
    if (alvo) {
      console.log(`\n-- B: mail_request{claim id=${alvo.id}} subject_key=${alvo.subject_key}`);
      const resgate = await b.send('mail_request', { claim: { id: alvo.id } });
      b.log(`← ${resgate.caseName}\n${full(resgate.value)}`);
    } else {
      console.log('\n-- nenhuma entrada de ouro resgatável agora (retida, ou já recolhida)');
    }
    }

    // ---------------------------------------------------- 8. conferência
    console.log('\n-- conferindo saldo');
    await Promise.all([a.waitFor('character_patch', 8000), b.waitFor('character_patch', 8000)]);
    console.log(`ouro depois: A=${a.gold} (antes ${ouroAntesA}, delta ${a.gold - ouroAntesA})`);
    console.log(`             B=${b.gold} (antes ${ouroAntesB}, delta ${b.gold - ouroAntesB})`);
    const perda = (ouroAntesA - a.gold) - (b.gold - ouroAntesB);
    console.log(`>> diferença A perdeu vs B ganhou = ${perda} (taxa, ou ouro ainda retido no correio) — item 4.7`);
  } finally {
    // Cancelar é inofensivo se a troca já fechou, e é o que salva as duas
    // contas de ficarem presas numa janela aberta se algo falhou no meio.
    for (const lado of [a, b]) {
      const res = await lado.send('trade_request', { cancel: {} }).catch(() => null);
      if (res) lado.log(`cancel final ← ${res.caseName}`);
    }
  }
}

// --------------------------------------------------------------------- main

async function credenciais() {
  if (opts.a && opts.b && !opts['a-user']) {
    const [ca, cb] = await doCofre([Number(opts.a), Number(opts.b)]);
    console.log(`== cofre: A=conta ${opts.a} (${ca.user})  B=conta ${opts.b} (${cb.user})`);
    return [ca, cb];
  }
  if (!opts['a-user'] || !opts['a-pass'] || !opts['b-user'] || !opts['b-pass']) {
    throw new Error('uso: --a 9 --b 8   ou   --a-user U1 --a-pass P1 --b-user U2 --b-pass P2');
  }
  return [
    { user: opts['a-user'], pass: opts['a-pass'], proxy: opts['a-proxy'] || '' },
    { user: opts['b-user'], pass: opts['b-pass'], proxy: opts['b-proxy'] || '' }
  ];
}

(async () => {
  const [credA, credB] = await credenciais();
  const a = new Lado('A', credA);
  const b = new Lado('B', credB);

  try {
    // Em série: o servidor recusa várias conexões do mesmo IP muito juntas.
    await a.connect();
    await b.connect();

    const cenaOrigemA = a.scene.id;
    const cenaOrigemB = b.scene.id;

    await medirAmizade(a, b);

    if (opts.reuniao || (opts.trocar && !opts['sem-viagem'])) {
      await medirReuniao(a, b);
    }

    if (opts.trocar) {
      const ouro = Number(opts.trocar);
      if (!Number.isFinite(ouro) || ouro <= 0) throw new Error('--trocar precisa de um valor de ouro');
      await medirTroca(a, b, ouro);
    }

    const segundos = Number(opts.watch) || 0;
    if (segundos > 0) {
      console.log(`\n== escutando pushes por ${segundos}s`);
      await new Promise(r => setTimeout(r, segundos * 1000));
    }

    // Devolver as duas contas à caçada: deixar conta parada na cidade é o pior
    // caso, e com duas contas o estrago é dobrado.
    for (const [lado, origem] of [[a, cenaOrigemA], [b, cenaOrigemB]]) {
      if (lado.huntTicket && lado.scene.id !== origem) {
        console.log(`\n== devolvendo ${lado.tag} à caçada ${full(lado.huntTicket)}`);
        const volta = await lado.send('start_hunt', lado.huntTicket);
        lado.log(`← ${volta.caseName}`);
        await lado.waitFor('scene_enter', 15000);
        lado.log(`cena final=${lado.scene.id}`);
      }
    }
  } finally {
    a.close();
    b.close();
    setTimeout(() => process.exit(0), 500);
  }
})().catch(e => {
  console.log('!! erro fatal:', e.message);
  process.exit(1);
});
