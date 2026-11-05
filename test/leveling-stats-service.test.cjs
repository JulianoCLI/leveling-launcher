/**
 * @file leveling-stats-service.test.cjs
 * O auto-status contra um servidor de mentira que fala o mesmo protobuf.
 *
 * O módulo de regras tem a sua própria suíte (`leveling-stats.test.cjs`), e é
 * lá que mora a prova de que a divisão bate com a do jogo. O que se prova aqui
 * é o que só existe no serviço: o gatilho é o ponto livre e não o nível, o
 * `allocate_stats` sai com o enum em número, a resposta é aplicada antes do
 * push, uma recusa recua em vez de repetir, e o catálogo de classes é lido uma
 * vez e compartilhado.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getCodec } = require('../src/domain/leveling-codec');
const { LevelingHeadlessClient } = require('../src/domain/leveling-headless-service');
const autoStats = require('../src/domain/leveling-stats');

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
const S = autoStats.STATS;

const statsOn = (over = {}) => autoStats.normalizeConfig({ enabled: true, ...over });

/** Catálogo cru, como o `content_catalog` manda. */
const CATALOGO_CRU = {
  rules: { stat_points_per_level: 5 },
  classes: [{
    id: 'mago',
    name: 'Mago',
    builds: [
      {
        id: 'arquimago',
        name: 'Arquimago',
        weights: [
          { stat: S.AGI, points: 20 }, { stat: S.PER, points: 25 },
          { stat: S.VIT, points: 15 }, { stat: S.INT, points: 40 }
        ]
      },
      {
        id: 'guardiao-arcano',
        name: 'Guardião Arcano',
        weights: [
          { stat: S.PER, points: 25 }, { stat: S.VIT, points: 30 },
          { stat: S.INT, points: 45 }
        ]
      }
    ]
  }]
};

const CATALOGO = autoStats.readClassCatalog(CATALOGO_CRU);

function makeClient(options = {}) {
  return new LevelingHeadlessClient(0, {
    WebSocket: MockWebSocket,
    username: 'mago',
    password: 'segredo',
    autoReconnect: false,
    requestTimeoutMs: 300,
    // O catálogo já lido, para a maioria dos casos não precisar encená-lo.
    // `fresh: true` reproduz "outra conta já pagou a leitura".
    classStore: { value: CATALOGO, fresh: true },
    ...options
  });
}

const sentCount = (ws, caseName) => ws.sent.filter(m => m[caseName] !== undefined).length;

const sends = (ws, caseName) => ws.sent.filter(m => m[caseName] !== undefined).map(m => m[caseName]);

async function waitSent(ws, caseName, afterCount = 0) {
  for (let i = 0; i < 200; i++) {
    if (sentCount(ws, caseName) > afterCount) return sends(ws, caseName).pop();
    await sleep(5);
  }
  return null;
}

/**
 * Conecta e autentica, sem mandar estado de personagem.
 *
 * Os casos empurram o `character_state` que precisam: é o pacote que dispara
 * tudo, e deixá-lo de fora aqui é o que permite testar o gatilho.
 */
async function boot(client) {
  client.connect();
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);
  return ws;
}

/** O `character_state` de um mago com pontos livres. */
const personagem = (over = {}) => ({
  identity: { name: 'Mago', class_id: 'mago' },
  progress: { level: 40 },
  points: { stat_points: 5 },
  stats: { allocated: [] },
  ...over
});

/** Soma dos pontos de um `allocate_stats` enviado. */
const somaDe = pedido => pedido.points.reduce((a, p) => a + Number(p.points), 0);

/**
 * O enviado em `{STR:..}`, para comparar com a divisão esperada.
 *
 * `p.stat` chega como `STAT_ID_INT`: o `toJSON` do protobufjs renderiza enum
 * pelo nome, mesmo o que foi codificado como número. `statSigla` aceita as duas
 * formas justamente por isso.
 */
const comoObj = pedido => {
  const out = {};
  for (const p of pedido.points) out[autoStats.statSigla(p.stat)] = Number(p.points);
  return out;
};

// --------------------------------------------------------------- a guarda

test('desligado, nenhum allocate_stats sai', async () => {
  const client = makeClient();
  const ws = await boot(client);
  ws.push('character_state', personagem());
  await sleep(30);

  assert.equal(sentCount(ws, 'allocate_stats'), 0);
  client.disconnect();
});

test('conta excluída na tela fica de fora', async () => {
  const client = makeClient({ statsConfig: statsOn({ disabled: [0] }) });
  const ws = await boot(client);
  ws.push('character_state', personagem());
  await sleep(30);

  assert.equal(sentCount(ws, 'allocate_stats'), 0);
  client.disconnect();
});

test('sem pontos livres nada é enviado, mesmo subindo de nível', async () => {
  const client = makeClient({ statsConfig: statsOn() });
  const ws = await boot(client);
  ws.push('character_state', personagem({ points: {} }));
  await sleep(10);
  // Nível novo, ainda sem ponto: o gatilho é o ponto, não o nível.
  ws.push('character_patch', { progress: { level: 41 } });
  await sleep(30);

  assert.equal(sentCount(ws, 'allocate_stats'), 0);
  client.disconnect();
});

// -------------------------------------------------------------- o gatilho

test('o ponto livre no patch dispara a distribuição', async () => {
  const client = makeClient({ statsConfig: statsOn() });
  const ws = await boot(client);
  ws.push('character_state', personagem({ points: {} }));
  await sleep(10);
  assert.equal(sentCount(ws, 'allocate_stats'), 0);

  ws.push('character_patch', { progress: { level: 41 }, points: { stat_points: 5 } });
  const pedido = await waitSent(ws, 'allocate_stats');

  assert.ok(pedido, 'o ponto livre tem de disparar o envio');
  assert.equal(somaDe(pedido), 5, 'gasta exatamente o que está livre');
  client.disconnect();
});

test('pontos acumulados de um monitor desligado saem no próprio login', async () => {
  // Oito níveis sem launcher: 40 pontos parados. O `character_state` do login é
  // o primeiro pacote, e ele já tem de resolver.
  const client = makeClient({ statsConfig: statsOn() });
  const ws = await boot(client);
  ws.push('character_state', personagem({ points: { stat_points: 40 } }));
  const pedido = await waitSent(ws, 'allocate_stats');

  assert.ok(pedido);
  assert.equal(somaDe(pedido), 40);
  client.disconnect();
});

test('o atributo sai como número do enum: o codec recusa o nome', async () => {
  // O `verify` do protobufjs recusa nome em enum com escopo, então um plano que
  // mandasse `'INT'` faria o `encode` lançar e nada sairia. O teste prende isso
  // na fonte, porque o `toJSON` do pacote já enviado mostra o nome de qualquer
  // jeito e esconderia a diferença.
  const plano = autoStats.planAlocacao({ pesos: { INT: 100 }, allocated: {}, livres: 5 });
  const points = autoStats.toAllocatePoints(plano);
  for (const p of points) assert.equal(typeof p.stat, 'number');

  assert.doesNotThrow(() => codec.encode(1, 'allocate_stats', { points }));
  assert.throws(() => codec.encode(1, 'allocate_stats', { points: [{ stat: 'INT', points: 5 }] }));

  // E o que de fato sai do cliente é esse mesmo pacote.
  const client = makeClient({ statsConfig: statsOn() });
  const ws = await boot(client);
  ws.push('character_state', personagem());
  const pedido = await waitSent(ws, 'allocate_stats');
  assert.equal(somaDe(pedido), 5);
  client.disconnect();
});

test('a divisão enviada é a da build escolhida', async () => {
  const client = makeClient({
    statsConfig: statsOn({ porConta: { 0: { modo: 'build', buildId: 'guardiao-arcano' } } })
  });
  const ws = await boot(client);
  ws.push('character_state', personagem({ points: { stat_points: 100 } }));
  const pedido = await waitSent(ws, 'allocate_stats');

  const esperado = autoStats.planAlocacao({
    pesos: autoStats.buildDe(CATALOGO, 'mago', 'guardiao-arcano').pesos,
    allocated: {},
    livres: 100
  });
  const esperadoObj = {};
  for (const e of esperado) esperadoObj[e.stat] = e.points;
  assert.deepEqual(comoObj(pedido), esperadoObj);
  client.disconnect();
});

test('sem escolha, vale a primeira build da classe', async () => {
  const client = makeClient({ statsConfig: statsOn() });
  const ws = await boot(client);
  ws.push('character_state', personagem({ points: { stat_points: 100 } }));
  const pedido = await waitSent(ws, 'allocate_stats');

  const esperado = autoStats.planAlocacao({
    pesos: autoStats.buildDe(CATALOGO, 'mago', 'arquimago').pesos,
    allocated: {},
    livres: 100
  });
  assert.equal(pedido.points.length, esperado.length);
  client.disconnect();
});

test('o personalizado ignora a build e usa os pesos do jogador', async () => {
  const client = makeClient({
    statsConfig: statsOn({ porConta: { 0: { modo: 'custom', pesos: { STR: 100 } } } })
  });
  const ws = await boot(client);
  ws.push('character_state', personagem());
  const pedido = await waitSent(ws, 'allocate_stats');

  assert.deepEqual(comoObj(pedido), { STR: 5 });
  client.disconnect();
});

// ------------------------------------------------------- base da divisão

test('a base é allocated, não o total: a base da classe fica de fora', async () => {
  const client = makeClient({
    statsConfig: statsOn({ porConta: { 0: { modo: 'custom', pesos: { STR: 50, INT: 50 } } } })
  });
  const ws = await boot(client);
  ws.push('character_state', personagem({
    points: { stat_points: 10 },
    stats: {
      // 36 de INT de classe e 6 de item, mas nada investido: a divisão tem de
      // ignorar os dois e repartir meio a meio.
      allocated: [],
      class_base: [{ stat: S.INT, points: 36 }],
      from_items: [{ stat: S.INT, points: 6 }],
      total: [{ stat: S.INT, points: 42 }]
    }
  }));
  const pedido = await waitSent(ws, 'allocate_stats');

  assert.deepEqual(comoObj(pedido), { STR: 5, INT: 5 });
  client.disconnect();
});

test('o já investido desloca a divisão para quem está atrás', async () => {
  const client = makeClient({
    statsConfig: statsOn({ porConta: { 0: { modo: 'custom', pesos: { STR: 50, INT: 50 } } } })
  });
  const ws = await boot(client);
  ws.push('character_state', personagem({
    points: { stat_points: 10 },
    stats: { allocated: [{ stat: S.STR, points: 10 }] }
  }));
  const pedido = await waitSent(ws, 'allocate_stats');

  // Total final 20, alvo 10 cada: STR já tem 10, então os 10 vão para INT.
  assert.deepEqual(comoObj(pedido), { INT: 10 });
  client.disconnect();
});

// ------------------------------------------------------------- a resposta

test('o saldo da resposta é aplicado sem esperar o push', async () => {
  const client = makeClient({ statsConfig: statsOn() });
  const ws = await boot(client);
  ws.push('character_state', personagem());
  await waitSent(ws, 'allocate_stats');

  ws.reply('allocate_stats', 'allocate_stats_result', { allocated: [], remaining_points: 0 });
  await sleep(10);

  assert.equal(client.state.points.stat, 0, 'o ponto gasto some do painel na hora');
  client.disconnect();
});

test('o aplicado pelo servidor vira a base da divisão seguinte', async () => {
  const client = makeClient({
    statsConfig: statsOn({ porConta: { 0: { modo: 'custom', pesos: { STR: 50, INT: 50 } } } })
  });
  const ws = await boot(client);
  ws.push('character_state', personagem({ points: { stat_points: 10 } }));
  await waitSent(ws, 'allocate_stats');

  ws.reply('allocate_stats', 'allocate_stats_result', {
    allocated: [{ stat: S.STR, points: 5 }, { stat: S.INT, points: 5 }],
    remaining_points: 0
  });
  await sleep(10);

  assert.deepEqual(client.statsAllocated,
    { STR: 5, AGI: 0, PER: 0, VIT: 0, INT: 5 },
    'sem isto a próxima divisão repartiria como se nada tivesse sido gasto');
  client.disconnect();
});

test('uma alocação por vez: o patch do meio não dispara a segunda', async () => {
  const client = makeClient({ statsConfig: statsOn() });
  const ws = await boot(client);
  ws.push('character_state', personagem());
  await waitSent(ws, 'allocate_stats');

  // Patch enquanto o pedido ainda não foi respondido. Sem a trava, sairia um
  // segundo `allocate_stats` com a mesma base e o dobro seria gasto.
  ws.push('character_patch', { points: { stat_points: 5 } });
  await sleep(20);

  assert.equal(sentCount(ws, 'allocate_stats'), 1);
  client.disconnect();
});

test('sobra de ponto é resolvida na passada seguinte, não em recursão', async () => {
  const client = makeClient({ statsConfig: statsOn() });
  const ws = await boot(client);
  ws.push('character_state', personagem({ points: { stat_points: 5 } }));
  await waitSent(ws, 'allocate_stats');

  // O servidor aplicou menos do que o pedido: ainda sobram 3.
  ws.reply('allocate_stats', 'allocate_stats_result', {
    allocated: [{ stat: S.INT, points: 2 }], remaining_points: 3
  });
  await sleep(20);

  assert.equal(sentCount(ws, 'allocate_stats'), 1, 'a resposta sozinha não re-dispara');

  // O patch seguinte é que resolve o resto.
  ws.push('character_patch', { points: { stat_points: 3 } });
  const segundo = await waitSent(ws, 'allocate_stats', 1);
  assert.ok(segundo);
  assert.equal(somaDe(segundo), 3);
  client.disconnect();
});

// --------------------------------------------------------------- a recusa

test('recusa do servidor recua em vez de repetir a cada patch', async () => {
  const client = makeClient({ statsConfig: statsOn(), statsBackoffMs: 60000 });
  const ws = await boot(client);
  ws.push('character_state', personagem());
  await waitSent(ws, 'allocate_stats');

  ws.reply('allocate_stats', 'error', { code: 'stats.locked' });
  await sleep(10);

  assert.ok(client.statsAt > Date.now(), 'o recuo precisa estar armado');
  assert.equal(client.statsStats.lastError, 'stats.locked');

  // Vários patches durante o recuo não podem virar vários pedidos.
  for (let i = 0; i < 5; i++) {
    ws.push('character_patch', { points: { stat_points: 5 } });
    await sleep(5);
  }
  assert.equal(sentCount(ws, 'allocate_stats'), 1);
  client.disconnect();
});

test('a recusa entra no relatório com o código do servidor', async () => {
  const client = makeClient({ statsConfig: statsOn() });
  const ws = await boot(client);
  const linhas = [];
  client.on('stats-log', e => linhas.push(e));

  ws.push('character_state', personagem());
  await waitSent(ws, 'allocate_stats');
  ws.reply('allocate_stats', 'error', { code: 'stats.locked' });
  await sleep(10);

  const falha = linhas.find(l => !l.ok);
  assert.ok(falha, 'a recusa tem de virar linha');
  assert.equal(falha.reason, 'stats.locked');
  client.disconnect();
});

test('build apagada num deploy vira motivo e recua, sem enviar nada', async () => {
  const client = makeClient({
    statsConfig: statsOn({ porConta: { 0: { modo: 'build', buildId: 'build-que-sumiu' } } })
  });
  const ws = await boot(client);
  const linhas = [];
  client.on('stats-log', e => linhas.push(e));

  ws.push('character_state', personagem());
  await sleep(30);

  assert.equal(sentCount(ws, 'allocate_stats'), 0, 'nada pode ser enviado às cegas');
  assert.equal(linhas[0].reason, 'stats.buildGone');
  assert.ok(client.statsAt > Date.now(), 'o motivo se repetiria a cada patch sem o recuo');
  client.disconnect();
});

test('ligar pela janela não espera o próximo nível', async () => {
  const client = makeClient();
  const ws = await boot(client);
  ws.push('character_state', personagem());
  await sleep(20);
  assert.equal(sentCount(ws, 'allocate_stats'), 0);

  client.setStatsConfig(statsOn());
  const pedido = await waitSent(ws, 'allocate_stats');
  assert.ok(pedido, 'os pontos parados saem no clique, não no nível seguinte');
  client.disconnect();
});

test('mudar a configuração zera o recuo: o clique não pode ser engolido', async () => {
  const client = makeClient({ statsConfig: statsOn(), statsBackoffMs: 60000 });
  const ws = await boot(client);
  ws.push('character_state', personagem());
  await waitSent(ws, 'allocate_stats');
  ws.reply('allocate_stats', 'error', { code: 'stats.locked' });
  await sleep(10);
  assert.ok(client.statsAt > Date.now());

  client.setStatsConfig(statsOn({ porConta: { 0: { modo: 'custom', pesos: { VIT: 100 } } } }));
  const segundo = await waitSent(ws, 'allocate_stats', 1);
  assert.ok(segundo);
  assert.deepEqual(comoObj(segundo), { VIT: 5 });
  client.disconnect();
});

// ------------------------------------------------------------- o catálogo

test('sem catálogo, nada é enviado às cegas', async () => {
  const client = makeClient({ statsConfig: statsOn(), classStore: { value: null, fresh: true } });
  const ws = await boot(client);
  const linhas = [];
  client.on('stats-log', e => linhas.push(e));

  ws.push('character_state', personagem());
  await sleep(30);

  assert.equal(sentCount(ws, 'allocate_stats'), 0);
  assert.equal(linhas[0].reason, 'stats.noCatalog');
  client.disconnect();
});

test('o catálogo que chega destrava os pontos que esperavam por ele', async () => {
  const client = makeClient({ statsConfig: statsOn(), classStore: { value: null, fresh: false } });
  const ws = await boot(client);
  ws.push('character_state', personagem());
  await sleep(20);
  assert.equal(sentCount(ws, 'allocate_stats'), 0, 'sem builds não há o que distribuir');

  ws.push('content_catalog', CATALOGO_CRU);
  const pedido = await waitSent(ws, 'allocate_stats');
  assert.ok(pedido, 'a leitura do catálogo tem de retomar a distribuição parada');
  client.disconnect();
});

test('o catálogo é lido uma vez e fica compartilhado entre as contas', async () => {
  const store = { value: null, fresh: false };
  const client = makeClient({ statsConfig: statsOn(), classStore: store });
  const ws = await boot(client);
  ws.push('content_catalog', CATALOGO_CRU);
  await sleep(10);

  assert.equal(store.fresh, true, 'a segunda conta não paga a leitura de 1 MB');
  assert.ok(autoStats.hasClasses(store.value));
  assert.equal(client.getClassCatalog().classes.mago.builds.length, 2);
  client.disconnect();
});

// ------------------------------------------------------------- relatório

test('o sucesso entra no relatório com build, nível e o que foi gasto', async () => {
  const client = makeClient({ statsConfig: statsOn() });
  const ws = await boot(client);
  const linhas = [];
  client.on('stats-log', e => linhas.push(e));

  ws.push('character_state', personagem({ progress: { level: 42 } }));
  await waitSent(ws, 'allocate_stats');
  ws.reply('allocate_stats', 'allocate_stats_result', { allocated: [], remaining_points: 0 });
  await sleep(10);

  const linha = linhas.find(l => l.ok);
  assert.ok(linha);
  assert.equal(linha.level, 42);
  assert.equal(linha.gasto, 5);
  assert.equal(linha.buildId, 'arquimago');
  assert.equal(linha.origem, 'padrao');
  client.disconnect();
});

test('o resumo da janela mostra a prévia sem enviar nada', async () => {
  const client = makeClient();
  const ws = await boot(client);
  ws.push('character_state', personagem());
  await sleep(20);

  const resumo = client.getStatsSummary();
  assert.equal(resumo.className, 'Mago');
  assert.equal(resumo.builds.length, 2);
  assert.equal(resumo.livres, 5);
  assert.equal(resumo.previa.reduce((a, e) => a + e.points, 0), 5);
  assert.equal(sentCount(ws, 'allocate_stats'), 0, 'olhar não gasta ponto');
  client.disconnect();
});
