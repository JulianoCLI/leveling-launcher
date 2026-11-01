/**
 * @file leveling-cambio-service.test.cjs
 * O câmbio contra um servidor de mentira que fala o mesmo protobuf.
 *
 * O módulo de regras tem a sua própria suíte (`leveling-cambio.test.cjs`); o
 * que se prova aqui é o que só existe no serviço: duas contas conduzidas em
 * par, a ordem das etapas, a conferência antes de travar, o aborto quando algo
 * tira a conta da cena, e a volta das duas à caçada.
 *
 * As respostas do servidor de mentira são as medidas em `tools/trade-probe.js`
 * contra o servidor real (trades 17835 e 17837).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getCodec } = require('../src/domain/leveling-codec');
const {
  LevelingHeadlessClient,
  LevelingHeadlessManager
} = require('../src/domain/leveling-headless-service');

const codec = getCodec();

/** Socket de mentira que fala o mesmo protobuf binário do servidor real. */
class MockWebSocket {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    this.replied = new Set();
    MockWebSocket.all.push(this);
    setTimeout(() => {
      this.readyState = 1;
      if (this.onopen) this.onopen();
    }, 1);
  }

  send(data) {
    this.sent.push(codec.ClientMessage.decode(data).toJSON());
  }

  close(code) {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code: code || 1000 });
  }

  push(caseName, value, requestId = 0) {
    const payload = { [caseName]: value };
    if (requestId) payload.request_id = requestId;
    const buf = codec.ServerMessage.encode(codec.ServerMessage.create(payload)).finish();
    if (this.onmessage) this.onmessage({ data: Buffer.from(buf) });
  }

  /** Responde ao request pendente de um case. Cada um é respondido uma vez. */
  reply(clientCase, caseName, value) {
    const match = this.sent.find(m => m[clientCase] !== undefined && !this.replied.has(m.request_id));
    if (!match) return null;
    this.replied.add(match.request_id);
    this.push(caseName, value, Number(match.request_id));
    return match;
  }

  /**
   * O pacote mais antigo de um case que ainda não foi respondido.
   *
   * O roteiro tem de decidir pelo **mesmo** pacote que `reply` vai responder,
   * senão a resposta sai com o `request_id` de outra operação e a espera do
   * cliente nunca é acordada — era o que travava a suíte.
   */
  pending(clientCase) {
    const match = this.sent.find(m => m[clientCase] !== undefined && !this.replied.has(m.request_id));
    return match ? match[clientCase] : null;
  }

  /** O último pacote de um case, já desembrulhado do envelope. */
  last(caseName) {
    const list = this.sent.filter(m => m[caseName] !== undefined);
    return list.length ? list[list.length - 1][caseName] : null;
  }

  count(caseName) {
    return this.sent.filter(m => m[caseName] !== undefined).length;
  }
}
MockWebSocket.all = [];

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A caçada em que a conta está; é ela que o `start_hunt` de volta reproduz. */
const HUNT = { gate_id: 'ilha-jeju', tier_min: 51, difficulty: 'normal' };
const CIDADE = 'cidade-seul';
/** Ponto de spawn da cidade, medido: as duas contas nascem aqui. */
const SPAWN = { x: 16050, y: 12240 };

/** As contas da sonda, com os ids reais. */
const CONTA = {
  de: { index: 1, accountId: 16751, name: 'credo', entity: 19590 },
  para: { index: 0, accountId: 14803, name: 'mortemorrida', entity: 19591 }
};

/**
 * Espera uma condição sem prazo fixo no caso de teste: o serviço é todo
 * assíncrono e encadeado por push, então dormir um número mágico tornaria a
 * suíte instável.
 */
async function until(fn, limite = 400) {
  for (let i = 0; i < limite; i++) {
    const r = fn();
    if (r) return r;
    await sleep(5);
  }
  return null;
}

/**
 * Uma conta conectada, autenticada e caçando.
 *
 * A cena de caçada importa: é dela que sai o bilhete de volta, e sem ele o hop
 * não devolve a conta no fim.
 */
async function bootClient(perfil, { gold, hunt = HUNT } = {}) {
  const client = new LevelingHeadlessClient(perfil.index, {
    WebSocket: MockWebSocket,
    username: perfil.name,
    password: 'segredo',
    autoReconnect: false,
    requestTimeoutMs: 400
  });
  const antes = MockWebSocket.all.length;
  client.connect();
  await until(() => MockWebSocket.all.length > antes);
  await sleep(5);
  const ws = MockWebSocket.all[MockWebSocket.all.length - 1];
  client.ws = client.ws || ws;

  ws.reply('login', 'auth_ok', { token: 't', account_id: perfil.accountId, username: perfil.name });
  await sleep(5);
  ws.push('character_state', {
    identity: { name: perfil.name },
    progress: { level: 50 },
    wallet: { gold }
  });
  if (hunt) {
    ws.push('scene_enter', {
      scene_id: hunt.gate_id, kind: 2, channel: 1, your_entity: perfil.entity, hunt
    });
  } else {
    ws.push('scene_enter', { scene_id: CIDADE, kind: 1, channel: 1, your_entity: perfil.entity });
  }
  await sleep(5);
  return { client, ws };
}

/**
 * Manager com as duas contas já dentro, sem ligar o laço: os casos chamam
 * `pollCambio` à mão para controlar quando o hop acontece.
 */
async function bootPar(over = {}) {
  MockWebSocket.all = [];
  const manager = new LevelingHeadlessManager({
    cambioConfig: {
      enabled: true, destino: 1, reserva: 100000, intervaloMs: 600000, ...over.config
    },
    // Jitter determinístico: o caso de teste não pode depender do dado.
    random: () => 0.5
  });

  const doador = await bootClient(CONTA.de, { gold: over.goldDe == null ? 7726267 : over.goldDe });
  const destino = await bootClient(CONTA.para, {
    gold: over.goldPara == null ? 850875 : over.goldPara,
    hunt: over.huntPara === undefined ? HUNT : over.huntPara
  });

  manager.clients.set(CONTA.de.index, doador.client);
  manager.clients.set(CONTA.para.index, destino.client);
  return { manager, de: doador, para: destino };
}

/**
 * Faz o papel do servidor durante um hop inteiro, respondendo cada etapa na
 * ordem em que ela chega. É o roteiro medido na sonda.
 */
function serveHop(par, opts = {}) {
  const { de, para } = par;
  const gold = opts.gold == null ? 7626267 : opts.gold;
  const estado = {
    id: '324',
    me: { account: String(CONTA.de.accountId), name: CONTA.de.name, items: [], shadows: [] },
    partner: { account: String(CONTA.para.accountId), name: CONTA.para.name, items: [], shadows: [] },
    version: 1
  };
  const feito = { amizade: false, travelDe: false, travelPara: false, oferta: false };

  const laco = setInterval(() => {
    // ---------------------------------------------------------- correio
    // O hop lê o correio da origem antes de planejar: ouro de venda de mercado
    // fica parado ali e não entra no saldo sozinho.
    // O destino também é lido, depois do hop: ele é a origem do hop de baixo.
    while (para.ws.pending('mail_request')) {
      const pedido = para.ws.pending('mail_request');
      para.ws.reply('mail_request', 'mail_response', pedido.list
        ? { page: { entries: [] } }
        : { claimed: { claimed: [], gold: 0 } });
    }

    while (de.ws.pending('mail_request')) {
      const pedido = de.ws.pending('mail_request');
      if (pedido.list) {
        // A caixa esvazia depois do resgate, como no servidor real: o hop lê o
        // correio antes de planejar **e** de novo depois de fechar, e servir a
        // mesma carta duas vezes contaria o ouro em dobro.
        de.ws.reply('mail_request', 'mail_response', {
          page: { entries: feito.correio ? [] : (opts.correio || []) }
        });
      } else {
        feito.correio = true;
        de.ws.reply('mail_request', 'mail_response', {
          claimed: { claimed: [String(pedido.claim.id)], gold: opts.correioOuro || 0 }
        });
        // O saldo novo chega por `character_patch`, como no servidor real: o
        // `MailClaimResult` diz quanto, não quanto ficou.
        if (opts.correioPatch) {
          de.ws.push('character_patch', { wallet: { gold: opts.correioPatch } });
        }
      }
    }

    // ---------------------------------------------------------- amizade
    if (de.ws.count('social_request') && !feito.amizade) {
      const pedido = de.ws.pending('social_request');
      if (pedido && pedido.friend_list) {
        de.ws.reply('social_request', 'social_response', {
          friend_list: { friends: opts.jaAmigos ? [{ account: String(CONTA.para.accountId) }] : [] }
        });
      } else if (pedido && pedido.friend_action) {
        de.ws.reply('social_request', 'social_response', {
          friend_action: { kind: 'KIND_REQUEST', entry: { account: String(CONTA.para.accountId) } }
        });
        feito.amizade = true;
      }
    }
    if (para.ws.count('social_request')) {
      para.ws.reply('social_request', 'social_response', {
        friend_action: {
          kind: 'KIND_ACCEPT',
          entry: { account: String(CONTA.de.accountId) },
          became_friends: opts.amizadeFalha ? false : true
        }
      });
    }

    // ----------------------------------------------------------- viagem
    // `travel` não responde: o que confirma é o `scene_enter`.
    for (const [lado, flag] of [[de, 'travelDe'], [para, 'travelPara']]) {
      if (lado.ws.count('travel') && !feito[flag]) {
        feito[flag] = true;
        lado.ws.push('scene_enter', {
          scene_id: CIDADE, kind: 1, channel: 1,
          your_entity: lado === de ? CONTA.de.entity : CONTA.para.entity
        });
      }
    }

    // ------------------------------------------------------- aproximação
    // As snapshots que dizem onde cada personagem está. As duas no spawn, que
    // é o que foi medido.
    for (const [lado, flag] of [[de, 'cegaDe'], [para, 'cegaPara']]) {
      if (!lado.client.trip) continue;
      // A cena acabou de montar e a primeira snapshot ainda não traz a
      // entidade própria. Medido no servidor real, e era o que fazia a
      // aproximação desistir com `cambio.semPosicao` — por isso ela entra no
      // roteiro: o caminho normal tem de atravessá-la.
      if (opts.snapshotCega && !feito[flag]) {
        feito[flag] = true;
        lado.ws.push('world_snapshot', { entities: [] });
        continue;
      }
      const pos = lado === de ? (opts.posDe || SPAWN) : SPAWN;
      lado.ws.push('world_snapshot', {
        entities: [{
          id: lado === de ? CONTA.de.entity : CONTA.para.entity,
          x: pos.x, y: pos.y
        }]
      });
    }

    // ------------------------------------------------------------ troca
    if (de.ws.count('trade_request')) {
      const op = de.ws.pending('trade_request');
      if (op && op.invite) {
        if (opts.semAmizade) {
          de.ws.reply('trade_request', 'error', { code: 'trade.friends_only' });
        } else {
          de.ws.reply('trade_request', 'trade_response', {
            invite_sent: { account: String(CONTA.para.accountId), name: CONTA.para.name }
          });
          // O push chega no convidado antes de qualquer resposta.
          para.ws.push('trade_push', {
            invited: { from: String(CONTA.de.accountId), name: CONTA.de.name }
          });
        }
      } else if (op && op.set_offer) {
        estado.me.gold = String(opts.ofertaDivergente || gold);
        estado.version = 2;
        feito.oferta = true;
        de.ws.reply('trade_request', 'trade_response', { state: estado });
      } else if (op && op.get_state) {
        const copia = JSON.parse(JSON.stringify(estado));
        if (opts.itemNaOferta) copia.me.items = [{ uid: '99' }];
        de.ws.reply('trade_request', 'trade_response', { state: copia });
      } else if (op && op.lock) {
        estado.me.locked = true;
        estado.version = 3;
        de.ws.reply('trade_request', 'trade_response', { state: estado });
      } else if (op && op.confirm) {
        estado.me.confirmed = true;
        de.ws.reply('trade_request', 'trade_response', { state: estado });
      } else if (op && op.cancel) {
        // Medido: `cancel` depois do fecho responde erro, e isso é ignorado.
        de.ws.reply('trade_request', 'error', { code: 'trade.none' });
      }
    }

    if (para.ws.count('trade_request')) {
      const op = para.ws.pending('trade_request');
      if (op && op.respond) {
        para.ws.reply('trade_request', 'trade_response', { state: estado });
      } else if (op && op.lock) {
        estado.partner.locked = true;
        estado.version = 4;
        para.ws.reply('trade_request', 'trade_response', { state: estado });
      } else if (op && op.confirm) {
        para.ws.reply('trade_request', 'trade_response', { state: estado });
        // O fecho: `settling` e depois o `completed` em cada lado, com o
        // `character_patch` do ouro — exatamente a ordem medida.
        setTimeout(() => {
          const movido = opts.recebidoMenor || gold;
          de.ws.push('character_patch', { wallet: { gold: 7726267 - gold } });
          de.ws.push('trade_push', {
            completed: { id: '17837', partner: CONTA.para.name, given_gold: String(gold) }
          });
          para.ws.push('character_patch', { wallet: { gold: 850875 + Number(movido) } });
          para.ws.push('trade_push', {
            completed: { id: '17837', partner: CONTA.de.name, received_gold: String(movido) }
          });
        }, 5);
      } else if (op && op.cancel) {
        para.ws.reply('trade_request', 'error', { code: 'trade.none' });
      }
    }

    // ------------------------------------------------- volta à caçada
    for (const lado of [de, para]) {
      if (lado.ws.count('start_hunt') && !lado.voltou) {
        lado.voltou = true;
        // A resposta é `start_hunt_result`; o `scene_enter` vem depois, como
        // push. Responder com o `scene_enter` deixaria a espera por ele sem
        // nada para acordar.
        lado.ws.reply('start_hunt', 'start_hunt_result', { ...HUNT, scene_id: HUNT.gate_id });
        lado.ws.push('scene_enter', {
          scene_id: HUNT.gate_id, kind: 2, channel: 1, hunt: HUNT,
          your_entity: lado === de ? CONTA.de.entity : CONTA.para.entity
        });
      }
    }
  }, 2);
  laco.unref && laco.unref();
  return () => clearInterval(laco);
}

// ------------------------------------------------------------- hop completo

test('o hop desce o ouro, confere e devolve as duas à caçada', async () => {
  const par = await bootPar();
  const parar = serveHop(par);
  try {
    const resultado = await par.manager.pollCambio();
    assert.ok(resultado, 'o hop tinha de acontecer');
    assert.equal(resultado.ok, true, resultado.error);
    // Saldo 7.726.267 menos a reserva de 100.000.
    assert.equal(resultado.gold, 7626267);
    assert.equal(resultado.mailed, false, 'a troca de ouro não passa pelo correio');
  } finally { parar(); }

  // A ordem das operações de troca é a medida: convite, oferta, conferência,
  // trava, confirmação.
  const ops = par.de.ws.sent
    .filter(m => m.trade_request !== undefined)
    .map(m => Object.keys(m.trade_request)[0]);
  assert.deepEqual(ops.slice(0, 5), ['invite', 'set_offer', 'get_state', 'lock', 'confirm']);

  // As duas voltaram para a caçada em que estavam.
  assert.equal(par.de.ws.count('start_hunt'), 1);
  assert.equal(par.para.ws.count('start_hunt'), 1);
  assert.deepEqual(par.de.ws.last('start_hunt'), HUNT);

  assert.equal(par.manager.cambioStats.hops, 1);
  assert.equal(par.manager.cambioStats.goldMoved, 7626267);
});

test('a primeira snapshot sem a entidade própria não aborta o hop', async () => {
  // Visto no servidor real: a cena acabou de montar e a primeira
  // `world_snapshot` vem sem a entidade da conta. Desistir nela dava
  // `cambio.semPosicao` com tudo funcionando — a aproximação tem de insistir,
  // como `walkTo` faz no refill.
  const par = await bootPar();
  const parar = serveHop(par, { snapshotCega: true });
  try {
    const resultado = await par.manager.pollCambio();
    assert.ok(resultado, 'o hop tinha de acontecer mesmo assim');
    assert.equal(resultado.ok, true, resultado.error);
  } finally { parar(); }
});

test('o ouro do correio entra no saldo antes de o hop ser planejado', async () => {
  // Uma venda de mercado entrega o ouro por correio, e ele não entra no saldo
  // sozinho. Sem recolher, o câmbio desceria só o ouro de caçada e deixaria
  // para trás a maior parte do que a conta ganhou.
  const par = await bootPar({ goldDe: 150000 });
  const parar = serveHop(par, {
    correio: [{ id: '77', kind: 'market', subject_key: 'market_sale', gold: 480000 }],
    correioOuro: 480000,
    // O `character_patch` do resgate é o que põe o ouro no saldo.
    correioPatch: 630000,
    gold: 530000
  });
  try {
    const r = await par.manager.pollCambio();
    assert.ok(r, 'o hop tinha de acontecer');
    assert.equal(r.ok, true, r.error);
    // 150.000 de saldo + 480.000 do correio − 100.000 de reserva.
    assert.equal(r.gold, 530000);
  } finally { parar(); }

  assert.equal(par.manager.cambioStats.goldClaimed, 480000);
  // O resgate deixa a sua própria linha: sem ela, o valor do hop pareceria
  // ter saído do nada.
  const correio = par.manager.cambioLog.find(l => l.correio);
  assert.ok(correio, 'o resgate tem de aparecer no relatório');
  assert.equal(correio.gold, 480000);
});

test('depois do hop o correio das duas contas é lido de novo', async () => {
  // A conta que acabou de receber é a origem do hop de baixo: chegar lá com
  // ouro parado na caixa faria a cadeia descer menos do que ela tem. E na
  // origem, uma venda pode ter fechado durante os segundos da troca.
  const par = await bootPar();
  const parar = serveHop(par);
  try {
    const r = await par.manager.pollCambio();
    assert.equal(r.ok, true, r.error);
  } finally { parar(); }

  const lista = ws => ws.sent.filter(m => m.mail_request && m.mail_request.list).length;
  // Origem: uma antes de planejar, uma depois de fechar.
  assert.equal(lista(par.de.ws), 2);
  // Destino: só a de depois — ele não doa neste hop.
  assert.equal(lista(par.para.ws), 1);
});

test('correio só com item não é tocado, e o hop usa só o saldo', async () => {
  // Resgate com a bolsa cheia é parcial e silencioso: o câmbio não abre essa
  // porta por ouro que ele nem precisa.
  const par = await bootPar({ goldDe: 150000 });
  const parar = serveHop(par, {
    correio: [{ id: '77', gold: 9999, items: [{ def_id: 'x' }] }],
    gold: 50000
  });
  try {
    const r = await par.manager.pollCambio();
    assert.equal(r.ok, true, r.error);
    assert.equal(r.gold, 50000, 'só o saldo, sem o correio');
  } finally { parar(); }

  // Nenhum `claim` pode ter saído.
  const claims = par.de.ws.sent.filter(m => m.mail_request && m.mail_request.claim);
  assert.equal(claims.length, 0);
});

test('a oferta leva só ouro: nunca item nem sombra', async () => {
  const par = await bootPar();
  const parar = serveHop(par);
  try {
    await par.manager.pollCambio();
  } finally { parar(); }

  const oferta = par.de.ws.sent
    .map(m => m.trade_request)
    .find(t => t && t.set_offer);
  assert.ok(oferta, 'a oferta tem de ter saído');
  // `uint64` viaja como string no JSON do protobuf.
  assert.equal(oferta.set_offer.gold, '7626267');
  // Proto3 omite campos vazios, então ausência é a prova de que nada foi
  // ofertado além do ouro.
  assert.equal(oferta.set_offer.items, undefined);
  assert.equal(oferta.set_offer.shadows, undefined);
});

test('a amizade é pedida de um lado e aceita do outro, com kind numérico', async () => {
  const par = await bootPar();
  const parar = serveHop(par);
  try {
    await par.manager.pollCambio();
  } finally { parar(); }

  const pedido = par.de.ws.sent
    .map(m => m.social_request)
    .find(s => s && s.friend_action);
  assert.ok(pedido, 'o pedido de amizade tem de sair de quem convida');
  // `KIND_REQUEST`. O nome é recusado pelo `verify`: o enum é aninhado.
  assert.equal(pedido.friend_action.kind, 'KIND_REQUEST');
  assert.equal(pedido.friend_action.target.account, String(CONTA.para.accountId));

  const aceite = par.para.ws.sent
    .map(m => m.social_request)
    .find(s => s && s.friend_action);
  assert.ok(aceite, 'o aceite tem de sair do outro lado');
  assert.equal(aceite.friend_action.kind, 'KIND_ACCEPT');
});

test('contas já amigas não repetem o pedido', async () => {
  const par = await bootPar();
  const parar = serveHop(par, { jaAmigos: true });
  try {
    const r = await par.manager.pollCambio();
    assert.equal(r.ok, true, r.error);
  } finally { parar(); }

  const acoes = par.de.ws.sent.filter(m => m.social_request && m.social_request.friend_action);
  assert.equal(acoes.length, 0, 'amizade é persistente: vale uma vez por par');
});

// ------------------------------------------------------------------ abortos

test('item na oferta aborta antes de travar', async () => {
  const par = await bootPar();
  const parar = serveHop(par, { itemNaOferta: true });
  try {
    const r = await par.manager.pollCambio();
    assert.equal(r.ok, false);
    assert.equal(r.error, 'cambio.itemNaOferta');
  } finally { parar(); }

  // O ponto sem volta nunca foi alcançado.
  const ops = par.de.ws.sent
    .filter(m => m.trade_request !== undefined)
    .map(m => Object.keys(m.trade_request)[0]);
  assert.equal(ops.includes('lock'), false, 'não pode travar uma oferta divergente');
  assert.equal(ops.includes('confirm'), false);
  assert.ok(ops.includes('cancel'), 'a troca tem de ser cancelada');
});

test('oferta com ouro diferente do plano aborta antes de travar', async () => {
  const par = await bootPar();
  const parar = serveHop(par, { ofertaDivergente: 999 });
  try {
    const r = await par.manager.pollCambio();
    assert.equal(r.ok, false);
    assert.equal(r.error, 'cambio.ouroDivergente');
  } finally { parar(); }

  const ops = par.de.ws.sent
    .filter(m => m.trade_request !== undefined)
    .map(m => Object.keys(m.trade_request)[0]);
  assert.equal(ops.includes('lock'), false);
});

test('sem amizade o convite é recusado e o hop para', async () => {
  const par = await bootPar();
  const parar = serveHop(par, { semAmizade: true });
  try {
    const r = await par.manager.pollCambio();
    assert.equal(r.ok, false);
    assert.equal(r.error, 'trade.friends_only');
  } finally { parar(); }
});

test('recebido menor que o enviado não é fecho válido', async () => {
  const par = await bootPar();
  const parar = serveHop(par, { recebidoMenor: 1000 });
  try {
    const r = await par.manager.pollCambio();
    assert.equal(r.ok, false);
    assert.equal(r.error, 'cambio.recebeuDiferente');
  } finally { parar(); }
});

test('a conta arrastada para outra cena aborta o hop antes do convite', async () => {
  const par = await bootPar();
  const parar = serveHop(par);
  try {
    // O arrasto medido: o líder do grupo troca de caçada e leva a conta junto.
    const original = par.de.client.friendList.bind(par.de.client);
    par.de.client.friendList = async () => {
      const r = await original();
      par.de.client.cambioScene = CIDADE;
      par.de.ws.push('scene_enter', {
        scene_id: 'ilha-jeju', kind: 2, channel: 1, your_entity: CONTA.de.entity, hunt: HUNT
      });
      return r;
    };
    const r = await par.manager.pollCambio();
    assert.equal(r.ok, false);
    assert.equal(r.error, 'cambio.arrastado');
  } finally { parar(); }

  const ops = par.de.ws.sent
    .filter(m => m.trade_request !== undefined)
    .map(m => Object.keys(m.trade_request)[0]);
  assert.equal(ops.includes('invite'), false, 'nem o convite pode sair');
});

// ------------------------------------------------------------- guardas e ritmo

test('saldo na reserva não dispara hop nenhum', async () => {
  const par = await bootPar({ goldDe: 100000 });
  const r = await par.manager.pollCambio();
  assert.equal(r, null);
  assert.equal(par.de.ws.count('trade_request'), 0);
  assert.equal(par.manager.cambioStats.lastError, 'cambio.nadaASobrar');
});

test('a reserva de 100k fica na conta de origem', async () => {
  const par = await bootPar({ goldDe: 250000 });
  const parar = serveHop(par, { gold: 150000 });
  try {
    const r = await par.manager.pollCambio();
    assert.equal(r.ok, true, r.error);
    assert.equal(r.gold, 150000, 'sai o saldo menos a reserva');
  } finally { parar(); }
});

test('o hop seguinte espera o intervalo', async () => {
  const par = await bootPar();
  const parar = serveHop(par);
  try {
    const primeiro = await par.manager.pollCambio();
    assert.equal(primeiro.ok, true, primeiro.error);
    // Logo depois do fecho, a cadeia não pode disparar de novo.
    const segundo = await par.manager.pollCambio();
    assert.equal(segundo, null, 'só uma troca por intervalo');
  } finally { parar(); }

  assert.ok(par.manager.cambioLastAtMs > 0, 'o relógio conta do fecho');
  // Jitter determinístico no centro: o intervalo configurado, inteiro.
  assert.equal(par.manager.cambioWaitMs, 600000);
});

test('o relógio restaurado do disco segura o primeiro hop depois de um reinício', async () => {
  const par = await bootPar();
  // O que o `main.js` faz no boot: repõe o relatório e o instante do último
  // hop. Sem isso, religar o launcher logo depois de uma troca liberaria a
  // seguinte na hora, furando o intervalo que o usuário escolheu.
  par.manager.setCambioLog([{ atMs: Date.now(), de: 1, para: 0, gold: 500, ok: true }], Date.now());

  const r = await par.manager.pollCambio();
  assert.equal(r, null, 'o intervalo vale desde antes do reinício');
  assert.equal(par.de.ws.count('trade_request'), 0);
  assert.equal(par.manager.cambioLog.length, 1, 'o relatório volta do disco');
});

test('"Transferir agora" fura o intervalo, mas não as outras guardas', async () => {
  const par = await bootPar();
  par.manager.setCambioLog([], Date.now());

  // Sem `force`, o intervalo recém-reiniciado segura o hop.
  assert.equal(await par.manager.pollCambio(), null);
  assert.equal(par.manager.cambioStats.lastError, 'cambio.aguardandoIntervalo');

  const parar = serveHop(par);
  try {
    const r = await par.manager.pollCambio({ force: true });
    assert.ok(r, 'o botão tem de furar a espera');
    assert.equal(r.ok, true, r.error);
  } finally { parar(); }

  // A reserva continua valendo mesmo forçado: o que o botão pula é o ritmo.
  assert.equal(par.de.client.state.gold, 100000);
});

test('relógio antigo não segura nada: o intervalo já venceu', async () => {
  const par = await bootPar();
  par.manager.setCambioLog([], Date.now() - 3600000);
  const parar = serveHop(par);
  try {
    const r = await par.manager.pollCambio();
    assert.ok(r, 'uma hora depois, o hop sai');
    assert.equal(r.ok, true, r.error);
  } finally { parar(); }
});

test('o sink grava a configuração e o relógio juntos', async () => {
  const par = await bootPar();
  const gravado = [];
  par.manager.cambioSink = (config, lastAtMs) => gravado.push({ config, lastAtMs });

  const parar = serveHop(par);
  try {
    await par.manager.pollCambio();
  } finally { parar(); }

  assert.ok(gravado.length, 'o hop tem de gravar');
  const ultimo = gravado[gravado.length - 1];
  assert.equal(ultimo.config.destino, 1);
  // O relógio é o que faz o intervalo sobreviver a um reinício.
  assert.ok(ultimo.lastAtMs > 0);
  assert.equal(ultimo.lastAtMs, par.manager.cambioLastAtMs);
});

test('duas rodadas em paralelo não abrem duas trocas', async () => {
  const par = await bootPar();
  const parar = serveHop(par);
  try {
    const [a, b] = await Promise.all([
      par.manager.pollCambio(),
      par.manager.pollCambio()
    ]);
    // A segunda cai no guarda de `cambioBusy`.
    const feitos = [a, b].filter(Boolean);
    assert.equal(feitos.length, 1, 'um hop por vez no launcher inteiro');
  } finally { parar(); }

  const convites = par.de.ws.sent.filter(m => m.trade_request && m.trade_request.invite);
  assert.equal(convites.length, 1);
});

test('conta ocupada com refill fica de fora da rodada', async () => {
  const par = await bootPar();
  par.de.client.refillBusy = true;
  const r = await par.manager.pollCambio();
  assert.equal(r, null);
  assert.equal(par.de.ws.count('trade_request'), 0);
});

test('durante o hop a conta recusa refill, boss e troca de caçada', async () => {
  const par = await bootPar();
  const client = par.de.client;
  client.cambioBusy = true;

  const r = await client.setHunt({ gate_id: 'outro', tier_min: 1, difficulty: 'normal' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'hunt.cambioBusy');

  // `maybeRefill` e `maybeBoss` não devolvem nada: a prova é não terem
  // marcado o próprio busy.
  client.maybeRefill();
  client.maybeBoss();
  assert.equal(client.refillBusy, false);
  assert.equal(client.bossBusy, false);
});

test('câmbio desligado não faz nada', async () => {
  const par = await bootPar({ config: { enabled: false } });
  const r = await par.manager.pollCambio();
  assert.equal(r, null);
  assert.equal(par.de.ws.count('trade_request'), 0);
});

test('sem a conta de destino não há cadeia', async () => {
  const par = await bootPar();
  par.manager.clients.delete(CONTA.para.index);
  const r = await par.manager.pollCambio();
  assert.equal(r, null);
  assert.equal(par.manager.cambioStats.lastError, 'cambio.semCadeia');
});

// ---------------------------------------------------------------- relatório

test('o hop deixa uma linha no relatório', async () => {
  const par = await bootPar();
  const parar = serveHop(par);
  try {
    await par.manager.pollCambio();
  } finally { parar(); }

  assert.equal(par.manager.cambioLog.length, 1);
  const linha = par.manager.cambioLog[0];
  assert.equal(linha.ok, true);
  assert.equal(linha.gold, 7626267);
  assert.equal(linha.rotulo, '2→1');
  assert.equal(linha.error, '');
});

test('o status mostra a cadeia e o que cada hop está esperando', async () => {
  const par = await bootPar({ goldDe: 120000 });
  const status = par.manager.cambioStatus();
  assert.deepEqual(status.ativos, [0, 1]);
  assert.equal(status.hops.length, 1);
  assert.equal(status.hops[0].de, 1);
  assert.equal(status.hops[0].para, 0);
  assert.equal(status.hops[0].saldo, 120000);
  assert.equal(status.hops[0].plano.gold, 20000);
  assert.equal(status.busy, false);
});

// ------------------------------------------------------------------ pushes

test('trade_push só é lido durante um hop', async () => {
  const par = await bootPar();
  const client = par.de.client;

  // Fora do hop o push é descartado no `peek`, sem desserializar: nenhuma
  // espera é acordada.
  client.cambioBusy = false;
  let acordou = false;
  client.waitFor('trade_push', 30).then(v => { acordou = !!v; });
  par.de.ws.push('trade_push', { invited: { from: '1', name: 'x' } });
  await sleep(50);
  assert.equal(acordou, false, 'fora do hop, trade_push é volume descartado');

  // Dentro do hop, o mesmo push acorda a espera.
  client.cambioBusy = true;
  let acordouAgora = false;
  client.waitFor('trade_push', 200).then(v => { acordouAgora = !!v; });
  await sleep(5);
  par.de.ws.push('trade_push', { invited: { from: '1', name: 'x' } });
  await sleep(30);
  assert.equal(acordouAgora, true, 'durante o hop, trade_push é o que move a troca');
  client.cambioBusy = false;
});
