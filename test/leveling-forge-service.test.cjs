/**
 * @file leveling-forge-service.test.cjs
 * A auto-forja contra um servidor de mentira que fala o mesmo protobuf.
 *
 * As regras têm a sua própria suíte (`leveling-forge.test.cjs`), e é lá que
 * mora a prova de que nada é forjado que não fortaleça o personagem. O que se
 * prova aqui é o que só existe no serviço, e cada item da lista é um jeito de
 * destruir peça errada:
 *
 *   o `uid` sai como número inteiro exato, e não arredondado — um uid vizinho
 *   existe, e fundir com ele consumiria cinco peças que o usuário não escolheu;
 *
 *   o `slot` sai como número do enum, porque o `verify` do codec recusa o nome;
 *
 *   a ordem é **moer o lixo, equipar, fundir** — e a inversão em relação à
 *   primeira versão é o ponto: fusão custa pó, pó só vem de desmonte, e deixar
 *   o desmonte para o fim fazia a fusão falhar por falta de um pó que estava na
 *   bolsa o tempo todo em forma de comum e incomum;
 *
 *   depois de moer, o inventário é **relido**: planejar a fusão com a lista
 *   velha escolheria insumos que já não existem;
 *
 *   o gatilho é o `inventory_delta`, com espera entre rodadas: um drop por
 *   segundo não pode virar uma varredura de inventário por segundo;
 *
 *   uma recusa recua em vez de repetir no próximo drop.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getCodec } = require('../src/domain/leveling-codec');
const { LevelingHeadlessClient } = require('../src/domain/leveling-headless-service');
const autoForge = require('../src/domain/leveling-forge');

const codec = getCodec();

/** Socket de mentira que fala o mesmo protobuf binário do servidor real. */
class MockWebSocket {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    MockWebSocket.last = this;
    this.replied = new Set();
    setTimeout(() => {
      this.readyState = 1;
      if (this.onopen) this.onopen();
    }, 1);
  }

  send(data) {
    // `longs: String` no decode: um uid acima de 2^53 renderizado como number
    // perderia na própria asserção a precisão que o teste quer provar.
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

  reply(clientCase, caseName, value) {
    const match = this.sent.find(m => m[clientCase] !== undefined && !this.replied.has(m.request_id));
    assert.ok(match, `nenhum request de ${clientCase} pendente de resposta`);
    this.replied.add(match.request_id);
    this.push(caseName, value, Number(match.request_id));
    return match;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sentCount = (ws, caseName) => ws.sent.filter(m => m[caseName] !== undefined).length;
const sends = (ws, caseName) => ws.sent.filter(m => m[caseName] !== undefined).map(m => m[caseName]);

async function waitSent(ws, caseName, afterCount = 0) {
  for (let i = 0; i < 300; i++) {
    if (sentCount(ws, caseName) > afterCount) return sends(ws, caseName).pop();
    await sleep(5);
  }
  return null;
}

/**
 * O recorte do catálogo, no formato que `leveling-market-catalog` produz.
 *
 * `statMult` cresce com a raridade: é o que permite estimar o ganho de um
 * degrau antes de a peça existir. Sem ele a forja cairia no caminho permissivo,
 * que tem prova própria na suíte de regras.
 */
const CATALOGO = {
  items: { 'espada-x': { slot: 'ARMA' }, 'lixo-x': { slot: 'CAPACETE' } },
  rarities: {
    comum: { name: 'Comum', order: 0, statMult: 1 },
    incomum: { name: 'Incomum', order: 10, statMult: 1.3 },
    raro: { name: 'Raro', order: 20, statMult: 1.8 },
    epico: { name: 'Épico', order: 25, statMult: 2.5 },
    lendario: { name: 'Lendário', order: 30, statMult: 3.5 }
  },
  fusion: {
    fusionInputs: 5,
    swapInputs: 5,
    dustItemId: 'po-arcano',
    dustPerRarity: { comum: 2, incomum: 5, raro: 20 },
    fusionDustCost: { raro: 100 },
    fusionGoldKills: { raro: 7 },
    swapDustCost: { raro: 250 },
    swapGoldKills: { raro: 18 }
  }
};

/**
 * Uids grandes de propósito: acima de 2^53, que é onde `Number()` passa a
 * arredondar. São exatamente os uids que o servidor real manda.
 */
const UIDS = [
  '9007199254740993', '9007199254740995', '9007199254740997',
  '9007199254740999', '9007199254741001'
];

const forgeOn = (over = {}) => autoForge.normalizeConfig({
  enabled: true, equipBest: false, ...over
});

function makeClient(options = {}) {
  return new LevelingHeadlessClient(0, {
    WebSocket: MockWebSocket,
    username: 'ferreiro',
    password: 'segredo',
    autoReconnect: false,
    requestTimeoutMs: 300,
    // Sem espera entre rodadas, para o teste não dormir um minuto. A guarda em
    // si é provada no caso que a liga de propósito.
    forgeGapMs: 0,
    // O catálogo já lido: `fresh: true` reproduz "outra conta já pagou a
    // leitura do `content_catalog`".
    marketCatalogStore: { value: CATALOGO, fresh: true },
    ...options
  });
}

/**
 * Conecta, autentica e deixa pó arcano no saldo.
 *
 * O pó é semeado aqui porque sem ele **nenhuma** fusão é planejada, e o caso
 * que prova essa recusa é o da suíte de regras. Os casos que querem seguir o
 * pedido pelo socket seriam todos iguais sem esta linha: nada sai.
 */
async function boot(client) {
  client.connect();
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);
  client.state.stock.dust = 1000;
  return ws;
}

/** Peça de bolsa no formato que o `inventory_page` devolve. */
const item = (over = {}) => ({
  uid: '1', def_id: 'espada-x', rarity: 'raro', level: 50, power: 100, ...over
});

/**
 * As oito peças equipadas, fortes o bastante para nenhuma fusão as superar:
 * nada a forjar.
 *
 * `equipped_slot` vai como **número**, porque é o que o encode aceita: o nome
 * do enum em string sai do pacote em silêncio, e a peça chegaria como se
 * estivesse na bolsa. É a mesma razão pela qual o envio usa número.
 */
const corpoForte = () => autoForge.SLOT_ORDER.map((sigla, i) => item({
  uid: String(700000 + i), equipped_slot: autoForge.SLOTS[sigla],
  rarity: 'lendario', level: 99, power: 99999
}));

/**
 * O mesmo corpo, com a arma num ponto em que a fusão de raros a supera mas
 * nenhuma peça crua da bolsa a supera.
 *
 * Essa faixa existe porque o plano tem duas saídas que competem: peça crua mais
 * forte na bolsa manda **equipar** em vez de forjar, e aí nenhuma fusão sairia.
 * Com insumos de poder 100 e o degrau raro→épico valendo 2.5/1.8, a fusão
 * estima ~139 — e 120 fica no meio.
 */
const corpoComArmaNoPonto = () => corpoForte().map(p =>
  (p.equipped_slot === autoForge.SLOTS.ARMA
    ? { ...p, rarity: 'raro', level: 50, power: 120 }
    : p));

/**
 * Responde à varredura de inventário com uma página só.
 *
 * A auto-forja lê o escopo 1 (mochila) e para quando `has_next` é falso: o
 * depósito é onde o usuário guarda o que não quer que mexam.
 */
async function replyInventory(ws, items) {
  for (let i = 0; i < 200; i++) {
    const pendente = ws.sent.find(m => m.inventory_page !== undefined && !ws.replied.has(m.request_id));
    if (pendente) {
      ws.replied.add(pendente.request_id);
      ws.push('inventory_page', { items, has_next: false }, Number(pendente.request_id));
      return;
    }
    await sleep(5);
  }
  assert.fail('nenhum inventory_page pedido');
}

/** Um `inventory_delta`, que é o gatilho da rodada. */
const drop = ws => ws.push('inventory_delta', { used_slots: 10, capacity: 100 });

// --------------------------------------------------------------- a guarda

test('desligada, nenhuma varredura de inventário acontece', async () => {
  const client = makeClient();
  const ws = await boot(client);
  drop(ws);
  await sleep(30);

  assert.equal(sentCount(ws, 'inventory_page'), 0);
  client.disconnect();
});

test('conta excluída na tela fica de fora', async () => {
  const client = makeClient({ forgeConfig: forgeOn({ disabled: [0] }) });
  const ws = await boot(client);
  drop(ws);
  await sleep(30);

  assert.equal(sentCount(ws, 'inventory_page'), 0);
  client.disconnect();
});

test('ligar basta: não há mais alvo a configurar', async () => {
  // A primeira versão exigia nível e raridade e não fazia nada sem eles. Agora
  // o alvo é derivado de cada conta, e ligar é tudo o que o usuário escolhe.
  const client = makeClient({ forgeConfig: forgeOn() });
  const ws = await boot(client);
  drop(ws);
  await replyInventory(ws, corpoForte());
  await sleep(20);

  assert.ok(sentCount(ws, 'inventory_page') > 0);
  client.disconnect();
});

test('a espera entre rodadas impede uma varredura por drop', async () => {
  // O gatilho é o `inventory_delta`, que numa caçada ativa chega a cada peça
  // caída. Sem esta guarda, cada drop pagaria doze páginas de inventário.
  const client = makeClient({ forgeConfig: forgeOn(), forgeGapMs: 60000 });
  const ws = await boot(client);

  drop(ws);
  await replyInventory(ws, corpoForte());
  await sleep(20);
  const depois = sentCount(ws, 'inventory_page');

  for (let i = 0; i < 5; i++) drop(ws);
  await sleep(40);

  assert.equal(sentCount(ws, 'inventory_page'), depois);
  client.disconnect();
});

// ------------------------------------------------------------ a ordem

test('o lixo é moído antes de qualquer fusão', async () => {
  // A inversão desta versão. Fusão custa pó, pó só vem de desmonte, e comum e
  // incomum não servem de insumo nem de peça: moê-los por último fazia a fusão
  // falhar por falta de um pó que estava na bolsa o tempo todo.
  const client = makeClient({ forgeConfig: forgeOn() });
  const ws = await boot(client);

  drop(ws);
  await replyInventory(ws, [
    ...corpoComArmaNoPonto(),
    ...UIDS.map(uid => item({ uid })),
    item({ uid: '31', def_id: 'lixo-x', rarity: 'comum' })
  ]);

  const desmonte = await waitSent(ws, 'dismantle');
  assert.ok(desmonte, 'o desmonte sai primeiro');
  assert.deepEqual(desmonte.uids.map(String), ['31']);
  assert.equal(sentCount(ws, 'fuse'), 0, 'a fusão espera o pó chegar');
  client.disconnect();
});

test('depois de moer, o inventário é relido antes de planejar a fusão', async () => {
  // As peças sumiram e o saldo de pó mudou: planejar com a lista velha
  // escolheria insumos que já não existem.
  const client = makeClient({ forgeConfig: forgeOn() });
  const ws = await boot(client);

  const bolsa = [
    ...corpoComArmaNoPonto(),
    ...UIDS.map(uid => item({ uid })),
    item({ uid: '31', def_id: 'lixo-x', rarity: 'comum' })
  ];

  drop(ws);
  await replyInventory(ws, bolsa);
  const antes = sentCount(ws, 'inventory_page');

  await waitSent(ws, 'dismantle');
  ws.reply('dismantle', 'dismantle_result', { pieces: 1, dust: 2 });

  for (let i = 0; i < 100; i++) {
    if (sentCount(ws, 'inventory_page') > antes) break;
    await sleep(5);
  }
  assert.ok(sentCount(ws, 'inventory_page') > antes, 'a bolsa é lida de novo');
  client.disconnect();
});

// ---------------------------------------------------------------- a fusão

/**
 * Leva a rodada até o ponto em que a fusão é pedida.
 *
 * O caminho tem duas varreduras porque o desmonte do lixo acontece no meio, e
 * repetir essa coreografia em cada caso esconderia o que cada um prova.
 */
async function ateFundir(ws, extras = []) {
  const bolsa = [
    ...corpoComArmaNoPonto(),
    ...UIDS.map(uid => item({ uid })),
    item({ uid: '31', def_id: 'lixo-x', rarity: 'comum' }),
    ...extras
  ];
  drop(ws);
  await replyInventory(ws, bolsa);
  await waitSent(ws, 'dismantle');
  ws.reply('dismantle', 'dismantle_result', { pieces: 1, dust: 2 });
  await replyInventory(ws, bolsa.filter(p => p.uid !== '31'));
  return waitSent(ws, 'fuse');
}

test('o uid viaja inteiro: nenhum arredondamento de ponto flutuante', async () => {
  // A prova mais importante da suíte. `Number('9007199254740993')` devolve
  // ...992, que é o uid de **outra** peça — e fundir com ele consumiria cinco
  // peças erradas sem erro nenhum, porque o uid resultante existe.
  const client = makeClient({ forgeConfig: forgeOn() });
  const ws = await boot(client);

  const pedido = await ateFundir(ws);
  assert.ok(pedido);
  assert.deepEqual(pedido.uids.map(String), UIDS);
  client.disconnect();
});

test('o slot sai como número do enum, que é o que o codec aceita', async () => {
  const client = makeClient({ forgeConfig: forgeOn() });
  const ws = await boot(client);

  const pedido = await ateFundir(ws);
  // O `toJSON` do protobufjs renderiza o enum pelo nome mesmo quando foi
  // codificado como número — que é justamente o que se quer provar: o pacote
  // saiu válido. O nome em string no envio teria sido recusado por `verify`.
  assert.equal(pedido.slot, 'EQUIP_SLOT_ARMA');
  assert.ok(!pedido.slot_swap);
  client.disconnect();
});

test('o pó gasto é descontado do saldo local na hora', async () => {
  // O `character_patch` com o material novo chega depois; até ele, a rodada
  // seguinte veria pó que já foi gasto e planejaria uma fusão impossível.
  const client = makeClient({ forgeConfig: forgeOn() });
  const ws = await boot(client);
  client.state.stock.dust = 500;

  await ateFundir(ws);
  ws.reply('fuse', 'fuse_result', {
    item: { uid: '555', rarity: 'epico', level: 50 }, dust_spent: 100, gold_spent: 3
  });
  await sleep(20);

  // 500 do saldo, mais 2 do lixo moído, menos 100 da fusão.
  assert.equal(client.state.stock.dust, 402);
  assert.equal(client.forgeStats.fused, 1);
  client.disconnect();
});

test('uma rodada funde o lote inteiro, não uma peça', async () => {
  // O gargalo que esta versão existe para tirar: a conta com material para
  // várias fusões levava uma rodada de um minuto por fusão.
  const client = makeClient({ forgeConfig: forgeOn() });
  const ws = await boot(client);

  const extras = ['41', '42', '43', '44', '45'].map(uid => item({ uid }));
  await ateFundir(ws, extras);
  ws.reply('fuse', 'fuse_result', { item: { uid: '555' }, dust_spent: 100 });
  // A segunda só sai depois da resposta da primeira e da pausa entre elas.
  await waitSent(ws, 'fuse', 1);
  ws.reply('fuse', 'fuse_result', { item: { uid: '556' }, dust_spent: 100 });
  await sleep(20);

  assert.equal(sentCount(ws, 'fuse'), 2);
  assert.equal(client.forgeStats.fused, 2);
  client.disconnect();
});

test('uma recusa do servidor interrompe o resto do lote', async () => {
  // As fusões seguintes partiriam de um saldo de pó que virou palpite.
  const client = makeClient({ forgeConfig: forgeOn(), forgeBackoffMs: 50000 });
  const ws = await boot(client);

  const extras = ['41', '42', '43', '44', '45'].map(uid => item({ uid }));
  await ateFundir(ws, extras);
  ws.reply('fuse', 'error', { code: 'forge.noDust' });
  await sleep(40);

  assert.equal(sentCount(ws, 'fuse'), 1);
  client.disconnect();
});

test('o lote pede equip_best uma vez só', async () => {
  // `equip_best` varre todos os slots; pedir por fusão repetiria a varredura.
  const client = makeClient({ forgeConfig: forgeOn({ equipBest: true }) });
  const ws = await boot(client);

  const extras = ['41', '42', '43', '44', '45'].map(uid => item({ uid }));
  await ateFundir(ws, extras);
  ws.reply('fuse', 'fuse_result', { item: { uid: '555' }, dust_spent: 100 });
  await waitSent(ws, 'fuse', 1);
  ws.reply('fuse', 'fuse_result', { item: { uid: '556' }, dust_spent: 100 });
  await waitSent(ws, 'equip_best_preview');
  await sleep(20);

  assert.equal(sentCount(ws, 'fuse'), 2);
  assert.equal(sentCount(ws, 'equip_best_preview'), 1);
  client.disconnect();
});

test('o relatório guarda os níveis que entraram na fusão', async () => {
  // O nível que sai é o **menor** dos cinco. Sem esta linha o usuário não teria
  // como descobrir que uma peça atrasada puxou a fusão inteira para baixo — o
  // jogo não guarda registro nenhum de fusão.
  const client = makeClient({ forgeConfig: forgeOn() });
  const ws = await boot(client);
  const linhas = [];
  client.on('forge-log', e => linhas.push(e));

  await ateFundir(ws);
  ws.reply('fuse', 'fuse_result', {
    item: { uid: '555', rarity: 'epico', level: 50 }, dust_spent: 100
  });
  await sleep(20);

  const linha = linhas.find(l => l.action === 'fuse');
  assert.ok(linha);
  assert.deepEqual(linha.inputLevels, [50, 50, 50, 50, 50]);
  assert.equal(linha.waste, 0);
  assert.equal(linha.before.rarity, 'raro');
  client.disconnect();
});

// -------------------------------------------------------------- equipar

test('equipar sai depois da fusão, e com preview antes', async () => {
  // O preview é leitura pura e devolve `already_best`, que é a resposta mais
  // comum: sem ele, cada rodada mandaria uma escrita para o servidor responder
  // "não havia nada a trocar".
  const client = makeClient({ forgeConfig: forgeOn({ equipBest: true }) });
  const ws = await boot(client);

  await ateFundir(ws);
  assert.equal(sentCount(ws, 'equip_best_preview'), 0, 'nada de equipar antes de fundir');

  ws.reply('fuse', 'fuse_result', { item: { uid: '555' }, dust_spent: 100 });

  const previa = await waitSent(ws, 'equip_best_preview');
  assert.ok(previa);
  assert.equal(sentCount(ws, 'equip_best_apply'), 0);

  ws.reply('equip_best_preview', 'equip_best_preview_result', { already_best: false, new_power: 900 });
  const aplica = await waitSent(ws, 'equip_best_apply');
  assert.ok(aplica);
  ws.reply('equip_best_apply', 'equip_best_apply_result', {
    changes: [{ slot: 1 }], new_power: 900, delta_power: 40
  });
  await sleep(20);

  assert.equal(client.forgeStats.equipped, 1);
  client.disconnect();
});

test('forjar sem ganho nenhum recua em vez de repetir', async () => {
  // A rede de segurança da política permissiva: o ganho foi estimado, e o jogo
  // acabou de dizer que não havia nada a trocar. Sem o recuo, o próximo drop
  // refaria a mesma fusão sem ganho, e o seguinte também.
  const client = makeClient({
    forgeConfig: forgeOn({ equipBest: true }), forgeBackoffMs: 50000
  });
  const ws = await boot(client);
  const linhas = [];
  client.on('forge-log', e => linhas.push(e));

  await ateFundir(ws);
  ws.reply('fuse', 'fuse_result', { item: { uid: '555' }, dust_spent: 100 });
  await waitSent(ws, 'equip_best_preview');
  ws.reply('equip_best_preview', 'equip_best_preview_result', { already_best: true });
  await sleep(20);

  assert.equal(sentCount(ws, 'equip_best_apply'), 0);
  assert.ok(linhas.some(l => l.reason === 'forge.noGain'));
  assert.ok(client.forgeAt > Date.now() + 40000);
  client.disconnect();
});

test('sem autorização, equipar nunca é pedido', async () => {
  const client = makeClient({ forgeConfig: forgeOn({ equipBest: false }) });
  const ws = await boot(client);

  await ateFundir(ws);
  ws.reply('fuse', 'fuse_result', { item: { uid: '555' }, dust_spent: 100 });
  await sleep(30);

  assert.equal(sentCount(ws, 'equip_best_preview'), 0);
  assert.equal(sentCount(ws, 'equip_best_apply'), 0);
  client.disconnect();
});

// ------------------------------------------------------------- o desmonte

test('o pó do desmonte entra no saldo e no relatório', async () => {
  const client = makeClient({ forgeConfig: forgeOn() });
  const ws = await boot(client);
  const linhas = [];
  client.on('forge-log', e => linhas.push(e));

  drop(ws);
  await replyInventory(ws, [
    ...corpoForte(),
    item({ uid: '31', def_id: 'lixo-x', rarity: 'comum' }),
    item({ uid: '32', def_id: 'lixo-x', rarity: 'comum' })
  ]);

  const desmonte = await waitSent(ws, 'dismantle');
  assert.deepEqual(desmonte.uids.map(String), ['31', '32']);
  ws.reply('dismantle', 'dismantle_result', { pieces: 2, dust: 4, stones: 1 });
  await sleep(20);

  assert.equal(client.state.stock.dust, 1000 + 4);
  assert.equal(client.forgeStats.dismantled, 2);
  const linha = linhas.find(l => l.action === 'dismantle');
  assert.ok(linha);
  assert.equal(linha.pieces, 2);
  assert.equal(linha.dust, 4);
  assert.equal(linha.kind, 'junk');
  client.disconnect();
});

test('equipado e trancado nunca entram no desmonte', async () => {
  const client = makeClient({ forgeConfig: forgeOn() });
  const ws = await boot(client);

  drop(ws);
  await replyInventory(ws, [
    ...corpoForte(),
    // Comum e equipada: desmontá-la deixaria o slot vazio.
    item({ uid: '41', rarity: 'comum', equipped_slot: autoForge.SLOTS.CINTO }),
    // O cadeado é como o jogador diz "não toque", e aqui ninguém confirma nada.
    item({ uid: '42', def_id: 'lixo-x', rarity: 'comum', locked: true }),
    item({ uid: '43', def_id: 'lixo-x', rarity: 'comum' })
  ]);

  const desmonte = await waitSent(ws, 'dismantle');
  assert.deepEqual(desmonte.uids.map(String), ['43']);
  client.disconnect();
});

test('raros não são moídos quando não falta pó', async () => {
  // Eles são insumo da fusão seguinte. Moê-los sem necessidade é destruir o
  // material que a conta vai precisar para subir o próximo degrau.
  const client = makeClient({ forgeConfig: forgeOn() });
  const ws = await boot(client);

  drop(ws);
  await replyInventory(ws, [
    ...corpoForte(),
    item({ uid: '51', rarity: 'raro' }),
    item({ uid: '52', rarity: 'raro' })
  ]);
  await sleep(40);

  assert.equal(sentCount(ws, 'dismantle'), 0);
  client.disconnect();
});

// ----------------------------------------------------------------- recuo

test('uma recusa recua em vez de repetir no próximo drop', async () => {
  const client = makeClient({ forgeConfig: forgeOn(), forgeBackoffMs: 50000 });
  const ws = await boot(client);

  drop(ws);
  await replyInventory(ws, [
    ...corpoForte(),
    item({ uid: '31', def_id: 'lixo-x', rarity: 'comum' })
  ]);
  await waitSent(ws, 'dismantle');
  ws.reply('dismantle', 'error', { code: 'forge.busy' });
  await sleep(20);

  assert.equal(client.forgeStats.failed, 1);
  assert.equal(client.forgeStats.lastError, 'forge.busy');
  assert.ok(client.forgeAt > Date.now() + 40000);

  const antes = sentCount(ws, 'inventory_page');
  for (let i = 0; i < 3; i++) drop(ws);
  await sleep(40);
  assert.equal(sentCount(ws, 'inventory_page'), antes);
  client.disconnect();
});

test('sem regras de fusão a rodada recua, e o catálogo novo zera o recuo', async () => {
  // Um recuo armado por `forge.noRules` mantido depois de o catálogo chegar
  // faria a forja esperar cinco minutos por uma condição já resolvida.
  const client = makeClient({
    forgeConfig: forgeOn(),
    marketCatalogStore: { value: null, fresh: false }
  });
  const ws = await boot(client);

  drop(ws);
  await replyInventory(ws, corpoForte());
  await sleep(20);
  assert.ok(client.forgeAt > Date.now());

  // `applyCatalog` é quem lê o `content_catalog` e preenche a loja: um
  // catálogo com item é o que `hasCatalog` exige para valer a leitura.
  client.applyCatalog({ items: [{ id: 'espada-x', slot: 1, rarity: 'raro' }] });
  assert.equal(client.forgeAt, 0);
  client.disconnect();
});

test('mudar a configuração zera o recuo mas não forja', async () => {
  // Salvar a tela não pode ser o gesto que começa a destruir inventário.
  const client = makeClient({ forgeConfig: forgeOn(), forgeBackoffMs: 50000 });
  const ws = await boot(client);
  client.forgeAt = Date.now() + 50000;

  client.setForgeConfig(forgeOn({ maxDismantle: 30 }));
  assert.equal(client.forgeAt, 0);
  await sleep(30);
  assert.equal(sentCount(ws, 'inventory_page'), 0);
  client.disconnect();
});

// ----------------------------------------------------------- o pó arcano

test('o saldo de pó sai de `materials` pelo id das regras de fusão', async () => {
  // Pó arcano não tem campo próprio no protocolo: é material comum, e o que o
  // identifica é o `dust_item_id` do catálogo — a mesma mecânica da essência.
  const client = makeClient({ forgeConfig: forgeOn() });
  const ws = await boot(client);

  // O saldo chega dentro do `character_state`, em `inventory.materials`: não há
  // pacote de material avulso no protocolo.
  ws.push('character_state', {
    inventory: { materials: [{ def_id: 'po-arcano', qty: 777 }, { def_id: 'outro', qty: 5 }] }
  });
  await sleep(10);

  assert.equal(client.state.stock.dust, 777);
  client.disconnect();
});

test('sem catálogo o saldo de pó fica em zero', async () => {
  const client = makeClient({
    forgeConfig: forgeOn(),
    marketCatalogStore: { value: null, fresh: false }
  });
  const ws = await boot(client);
  // Desfaz a semente do `boot`: o que se prova aqui é que o material no
  // snapshot não é reconhecido sem o `dust_item_id` do catálogo.
  client.state.stock.dust = 0;

  ws.push('character_state', {
    inventory: { materials: [{ def_id: 'po-arcano', qty: 777 }] }
  });
  await sleep(10);

  // A forja recusa a fusão em vez de tentar gastar um pó que não sabe contar.
  assert.equal(client.state.stock.dust, 0);
  client.disconnect();
});
