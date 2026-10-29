const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getCodec } = require('../src/domain/leveling-codec');
const {
  LevelingHeadlessClient,
  LevelingHeadlessManager,
  IGNORED_PUSHES
} = require('../src/domain/leveling-headless-service');

const codec = getCodec();

/**
 * O mercado viaja todo dentro de `market_request`/`market_response`, com um
 * `oneof` dos dois lados — e os nomes não coincidem: `get` responde `detail`,
 * `search` responde `page`. Estes testes existem sobretudo para travar esse
 * mapeamento, que é a parte fácil de errar em silêncio.
 */

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
    assert.ok(match, `nenhum request de ${clientCase} pendente`);
    this.replied.add(match.request_id);
    this.push(caseName, value, Number(match.request_id));
  }

  /** O último `market_request` enviado, já desembrulhado do envelope. */
  lastMarket() {
    const envio = [...this.sent].reverse().find(m => m.market_request);
    return envio ? envio.market_request : null;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeClient(options = {}) {
  return new LevelingHeadlessClient(0, {
    WebSocket: MockWebSocket,
    username: 'cacador',
    password: 'segredo',
    autoReconnect: false,
    requestTimeoutMs: 200,
    ...options
  });
}

async function conectado() {
  const client = makeClient();
  client.connect();
  await sleep(10);
  MockWebSocket.last.reply('login', 'auth_ok', { token: 't', account_id: 1, username: 'eu' });
  await sleep(5);
  return { client, ws: MockWebSocket.last };
}

/** Uma `MarketSale` no formato do servidor. */
const venda = (id, defId, preco) => ({
  id, listing_id: id * 3, kind: 1, def_id: defId, name: defId,
  category: 'armas', rarity: 'raro', currency: 1,
  quantity: 1, unit_price: preco, total: preco, fee: preco * 0.1,
  net: preco * 0.9, sold_at_ms: Date.now()
});

// ----------------------------------------------------------------- envelope

test('history sai dentro de market_request e volta de market_response', async () => {
  const { client, ws } = await conectado();

  const promessa = client.marketHistory();
  await sleep(5);
  assert.deepEqual(ws.lastMarket(), { history: {} }, 'a operação viaja no oneof op');

  ws.reply('market_request', 'market_response', {
    history: { sales: [venda(1, 'arco', 100), venda(2, 'elmo', 200)] }
  });

  const res = await promessa;
  assert.equal(res.sales.length, 2);
  assert.equal(res.sales[0].def_id, 'arco');
  client.disconnect();
});

test('o nome do resultado não é o da operação: get responde detail', async () => {
  const { client, ws } = await conectado();

  const promessa = client.marketGet(196267);
  await sleep(5);
  assert.deepEqual(ws.lastMarket(), { get: { id: '196267' } });

  ws.reply('market_request', 'market_response', {
    detail: {
      listing: { id: 196267, name: 'Arco', unit_price: 500 },
      prices: { sales: 4055, average_sold: 229149, lowest_now: 2611 }
    }
  });

  const res = await promessa;
  assert.equal(res.prices.sales, 4055, 'o detalhe traz MarketPriceStats junto');
  assert.equal(res.listing.name, 'Arco');
  client.disconnect();
});

test('search responde page, e a página é normalizada para número', async () => {
  const { client, ws } = await conectado();

  const promessa = client.marketSearch({ category: 'armas', sort: 'preco-asc' });
  await sleep(5);
  assert.deepEqual(ws.lastMarket(), { search: { category: 'armas', sort: 'preco-asc', page: 1 } });

  ws.reply('market_request', 'market_response', {
    page: { listings: [{ id: 1, name: 'Arco', unit_price: 100 }], total: 4046, pages: 169 }
  });

  const res = await promessa;
  assert.equal(res.total, 4046);
  assert.equal(res.listings.length, 1);
  client.disconnect();
});

test('o id do anúncio é convertido: o codec recusa string em uint64', async () => {
  const { client } = await conectado();
  // O decode entrega ids como string; mandar de volta sem converter faria o
  // encode falhar com "integer|Long expected" — medido contra o servidor.
  const res = await client.marketGet('não é número');
  assert.equal(res.errorCode, 'market.badId');
  assert.equal((await client.marketGet(0)).errorCode, 'market.badId');
  client.disconnect();
});

test('price_hint só manda days quando foi pedido', async () => {
  const { client, ws } = await conectado();

  client.marketPriceHint('arco');
  await sleep(5);
  assert.deepEqual(ws.lastMarket(), { price_hint: { def_id: 'arco' } });
  ws.reply('market_request', 'market_response', { price_hint: { sales: 10, days: 30 } });
  await sleep(5);

  const promessa = client.marketPriceHint('arco', 7);
  await sleep(5);
  assert.deepEqual(ws.lastMarket(), { price_hint: { def_id: 'arco', days: 7 } });
  ws.reply('market_request', 'market_response', { price_hint: { sales: 8, average: 100, days: 7 } });

  const res = await promessa;
  assert.equal(res.days, 7);
  assert.equal(res.sales, 8);
  client.disconnect();
});

test('erro do servidor vira errorCode em vez de exceção', async () => {
  const { client, ws } = await conectado();

  // Medido: `overview` responde `admin.forbidden` para quem não é GM.
  const promessa = client.marketRequest('overview', {});
  await sleep(5);
  ws.reply('market_request', 'error', { code: 'admin.forbidden' });

  const res = await promessa;
  assert.equal(res.errorCode, 'admin.forbidden');
  assert.equal(res.result, undefined);

  // E o histórico degrada para lista vazia, nunca para `undefined`.
  const p2 = client.marketHistory();
  await sleep(5);
  ws.reply('market_request', 'error', { code: 'market.rate' });
  const h = await p2;
  assert.equal(h.errorCode, 'market.rate');
  assert.deepEqual(h.sales, []);
  client.disconnect();
});

// ------------------------------------------------------------------ coletor

test('o coletor escolhe uma conta conectada e entrega as vendas ao banco', async () => {
  const recebidas = [];
  const mgr = new LevelingHeadlessManager({
    WebSocket: MockWebSocket,
    autoReconnect: false,
    requestTimeoutMs: 200,
    marketSink: sales => { recebidas.push(sales); return sales.length; }
  });

  mgr.start(0, { username: 'a', password: 'b' });
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1, username: 'eu' });
  await sleep(5);

  const p = mgr.pollMarket();
  await sleep(5);
  ws.reply('market_request', 'market_response', { history: { sales: [venda(1, 'arco', 100)] } });

  assert.equal(await p, 1);
  assert.equal(recebidas.length, 1);
  assert.equal(recebidas[0][0].def_id, 'arco');
  assert.equal(mgr.getMarketStats().inserted, 1);
  mgr.stopAll();
});

test('sem conta conectada o coletor registra o motivo e não quebra', async () => {
  const mgr = new LevelingHeadlessManager({ marketSink: () => 0 });
  assert.equal(await mgr.pollMarket(), 0);
  assert.equal(mgr.getMarketStats().lastError, 'market.noneActive');
});

test('uma conta conectando ainda não serve de leitora', async () => {
  const mgr = new LevelingHeadlessManager({
    WebSocket: MockWebSocket,
    autoReconnect: false,
    marketSink: () => 0
  });
  mgr.start(0, { username: 'a', password: 'b' });
  await sleep(10);
  // Sem `auth_ok`, o status ainda é `connecting`.
  assert.equal(mgr.marketClient(), null);
  assert.equal(await mgr.pollMarket(), 0);
  mgr.stopAll();
});

test('o coletor não começa sem destino para as vendas', () => {
  const mgr = new LevelingHeadlessManager({});
  assert.equal(mgr.startMarketPoll(), false, 'sem marketSink não há onde gravar');
  assert.equal(mgr.getMarketStats().running, false);
});

test('ligar o coletor duas vezes não cria dois temporizadores', async () => {
  const mgr = new LevelingHeadlessManager({ marketSink: () => 0, marketIntervalMs: 60000 });
  assert.equal(mgr.startMarketPoll(), true);
  assert.equal(mgr.startMarketPoll(), false);
  assert.equal(mgr.getMarketStats().running, true);
  assert.equal(mgr.stopMarketPoll(), true);
  assert.equal(mgr.stopMarketPoll(), false);
});

test('uma leitura em curso não é atropelada pela seguinte', async () => {
  const mgr = new LevelingHeadlessManager({
    WebSocket: MockWebSocket,
    autoReconnect: false,
    requestTimeoutMs: 200,
    marketSink: s => s.length
  });
  mgr.start(0, { username: 'a', password: 'b' });
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1, username: 'eu' });
  await sleep(5);

  const primeira = mgr.pollMarket();
  await sleep(2);
  // A segunda desiste em vez de abrir outro request contra o mesmo socket.
  assert.equal(await mgr.pollMarket(), 0);
  const antes = ws.sent.filter(m => m.market_request).length;
  assert.equal(antes, 1);

  ws.reply('market_request', 'market_response', { history: { sales: [venda(1, 'arco', 100)] } });
  assert.equal(await primeira, 1);
  mgr.stopAll();
});

// ------------------------------------------------------------------- pushes

test('market_push deixou de ser descartado e vira evento de venda própria', async () => {
  assert.equal(IGNORED_PUSHES.has('market_push'), false,
    'é a única via que informa quem comprou — o feed público é anônimo');

  const { client, ws } = await conectado();
  const vendas = [];
  client.on('market-sold', e => vendas.push(e));

  ws.push('market_push', {
    sold: { listing_id: 999, name: 'Arco', quantity: 1, total: 5000, fee: 500, net: 4500, def_id: 'arco' }
  });
  await sleep(5);

  assert.equal(vendas.length, 1);
  assert.equal(vendas[0].sold.listing_id, '999');
  assert.equal(vendas[0].index, 0);
  client.disconnect();
});

test('market_push sem venda dentro não emite nada', async () => {
  const { client, ws } = await conectado();
  const vendas = [];
  client.on('market-sold', e => vendas.push(e));

  ws.push('market_push', { offer: { listing_id: 1 } });
  await sleep(5);

  assert.equal(vendas.length, 0, 'oferta não é venda');
  client.disconnect();
});

// --------------------------------------------------- inventário por conta

/** Uma `ItemInstance` no formato do servidor. */
const inst = (uid, defId, extra = {}) => ({
  uid, def_id: defId, rarity: 'raro', level: 45, qty: 1,
  power: 100, enchant: 0, ...extra
});

test('o inventário é pedido por def_ids, não varrido inteiro', async () => {
  // Medido: `filter.def_ids` aceita 155 ids num pedido só e o servidor
  // devolve apenas o que a conta tem. Sem o filtro seriam 4 pedidos por
  // conta para descartar quase tudo.
  const { client, ws } = await conectado();

  const promessa = client.inventoryCounts(['arco', 'elmo']);
  await sleep(5);
  const envio = [...ws.sent].reverse().find(m => m.inventory_page);
  assert.deepEqual(envio.inventory_page.filter.def_ids, ['arco', 'elmo']);
  assert.equal(envio.inventory_page.scope, 'INVENTORY_SCOPE_BAG');
  // O teto medido é 100: 101 devolve zero itens, sem erro.
  assert.equal(envio.inventory_page.page_size, 100);

  ws.reply('inventory_page', 'inventory_page', {
    items: [inst(1, 'arco'), inst(2, 'arco'), inst(3, 'elmo')], total: 3, has_next: false
  });
  await sleep(5);
  ws.reply('inventory_page', 'inventory_page', { items: [], has_next: false });

  const res = await promessa;
  assert.equal(res.owned.arco.qty, 2, 'duas peças somam duas');
  assert.equal(res.owned.elmo.qty, 1);
  client.disconnect();
});

test('material empilhado conta pela quantidade, não pela linha', async () => {
  const { client, ws } = await conectado();
  const promessa = client.inventoryCounts(['po-arcano']);
  await sleep(5);
  ws.reply('inventory_page', 'inventory_page', {
    items: [inst(1, 'po-arcano', { qty: 617 })], has_next: false
  });
  await sleep(5);
  ws.reply('inventory_page', 'inventory_page', { items: [], has_next: false });

  const res = await promessa;
  assert.equal(res.owned['po-arcano'].qty, 617, 'uma linha, 617 unidades');
  assert.equal(res.owned['po-arcano'].linhas, 1);
  client.disconnect();
});

test('equipado é contado à parte do que está à venda', async () => {
  // Está no patrimônio mas não disponível: somá-lo ao total mentiria sobre o
  // que dá para vender.
  const { client, ws } = await conectado();
  const promessa = client.inventoryCounts(['arco']);
  await sleep(5);
  ws.reply('inventory_page', 'inventory_page', {
    items: [inst(1, 'arco'), inst(2, 'arco', { equipped_slot: 1 })], has_next: false
  });
  await sleep(5);
  ws.reply('inventory_page', 'inventory_page', { items: [], has_next: false });

  const res = await promessa;
  assert.equal(res.owned.arco.qty, 1, 'só o que não está vestido');
  assert.equal(res.owned.arco.equipped, 1);
  client.disconnect();
});

test('mochila e depósito são somados mas ficam distinguíveis', async () => {
  const { client, ws } = await conectado();
  const promessa = client.inventoryCounts(['arco']);
  await sleep(5);
  ws.reply('inventory_page', 'inventory_page', { items: [inst(1, 'arco')], has_next: false });
  await sleep(5);
  ws.reply('inventory_page', 'inventory_page', { items: [inst(2, 'arco')], has_next: false });

  const res = await promessa;
  assert.equal(res.owned.arco.qty, 2);
  assert.equal(res.owned.arco.bag, 1);
  assert.equal(res.owned.arco.warehouse, 1, 'o depósito é seu também');
  client.disconnect();
});

test('a melhor peça é a de maior poder, não a primeira', async () => {
  const { client, ws } = await conectado();
  const promessa = client.inventoryCounts(['arco']);
  await sleep(5);
  ws.reply('inventory_page', 'inventory_page', {
    items: [
      inst(1, 'arco', { power: 70, rarity: 'comum' }),
      inst(2, 'arco', { power: 190, rarity: 'lendario', enchant: 5 }),
      inst(3, 'arco', { power: 120, rarity: 'raro' })
    ],
    has_next: false
  });
  await sleep(5);
  ws.reply('inventory_page', 'inventory_page', { items: [], has_next: false });

  const res = await promessa;
  assert.equal(res.owned.arco.melhor.power, 190);
  assert.equal(res.owned.arco.melhor.rarity, 'lendario');
  assert.equal(res.owned.arco.melhor.enchant, 5);
  client.disconnect();
});

test('has_next encadeia as páginas de uma mesma conta', async () => {
  // Equipamento é uma linha por peça: o teto de 100 por página é alcançável
  // mesmo com o filtro estreito.
  const { client, ws } = await conectado();
  const promessa = client.inventoryCounts(['arco'], { scopes: [1] });
  await sleep(5);
  ws.reply('inventory_page', 'inventory_page', { items: [inst(1, 'arco')], has_next: true });
  await sleep(5);
  ws.reply('inventory_page', 'inventory_page', { items: [inst(2, 'arco')], has_next: false });

  const res = await promessa;
  assert.equal(res.owned.arco.qty, 2, 'a segunda página não pode ser perdida');
  client.disconnect();
});

test('pedir sem itens não varre o inventário por engano', async () => {
  const { client, ws } = await conectado();
  const antes = ws.sent.length;
  const res = await client.inventoryCounts([]);
  assert.deepEqual(res.owned, {});
  assert.equal(ws.sent.length, antes, 'nada deve sair');
  client.disconnect();
});

test('conta desconectada responde "não sei", não "não tem"', async () => {
  const client = makeClient();
  const res = await client.inventoryCounts(['arco']);
  assert.equal(res.errorCode, 'inv.offline');
  assert.deepEqual(res.owned, {}, 'vazio com erro é diferente de vazio sem erro');
});

test('o manager inverte as posses por item e nomeia quem não foi lido', async () => {
  const manager = new LevelingHeadlessManager({ WebSocket: MockWebSocket, autoReconnect: false });
  manager.start(0, { username: 'u1', password: 'p' });
  await sleep(10);
  const ws0 = MockWebSocket.last;
  ws0.reply('login', 'auth_ok', { token: 't', account_id: 1, username: 'primeira' });
  await sleep(5);

  // A segunda conta não conecta: tem de aparecer como não consultada, nunca
  // como "não tem".
  manager.start(1, { username: 'u2', password: 'p' });
  const c1 = manager.getClient(1);
  c1.status = 'disconnected';
  c1.state.name = 'segunda';

  const promessa = manager.inventoryOwners(['arco']);
  await sleep(10);
  ws0.reply('inventory_page', 'inventory_page', { items: [inst(1, 'arco')], has_next: false });
  await sleep(5);
  ws0.reply('inventory_page', 'inventory_page', { items: [], has_next: false });

  const res = await promessa;
  assert.equal(res.byDef.arco.total, 1);
  assert.equal(res.byDef.arco.accounts.length, 1);
  assert.equal(res.byDef.arco.accounts[0].index, 0);
  assert.ok(res.offline.some(o => o.index === 1), 'a conta sem monitor é nomeada, não zerada');
  manager.stopAll();
});

test('a conta com mais unidades vem primeiro, não a de menor índice', async () => {
  // É a conta de onde vale a pena vender: a ordem é parte da resposta.
  const manager = new LevelingHeadlessManager({ WebSocket: MockWebSocket, autoReconnect: false });

  manager.start(0, { username: 'u1', password: 'p' });
  await sleep(10);
  const wsA = MockWebSocket.last;
  wsA.reply('login', 'auth_ok', { token: 't', account_id: 1, username: 'pouca' });
  await sleep(5);

  manager.start(1, { username: 'u2', password: 'p' });
  await sleep(10);
  const wsB = MockWebSocket.last;
  wsB.reply('login', 'auth_ok', { token: 't', account_id: 2, username: 'muita' });
  await sleep(5);

  const promessa = manager.inventoryOwners(['arco'], { scopes: [1] });
  await sleep(10);
  // A primeira conta tem uma peça; a segunda, três.
  wsA.reply('inventory_page', 'inventory_page', { items: [inst(1, 'arco')], has_next: false });
  wsB.reply('inventory_page', 'inventory_page', {
    items: [inst(2, 'arco'), inst(3, 'arco'), inst(4, 'arco')], has_next: false
  });

  const res = await promessa;
  assert.equal(res.byDef.arco.total, 4);
  assert.equal(res.byDef.arco.accounts[0].index, 1, 'quem tem mais vem primeiro');
  assert.equal(res.byDef.arco.accounts[0].qty, 3);
  manager.stopAll();
});

test('a varredura da bolsa vai sem filtro de def_ids', async () => {
  // A aba "Minha bolsa" pergunta "o que eu tenho", sem lista prévia. Mandar
  // um filtro vazio faria o servidor devolver nada.
  const { client, ws } = await conectado();
  const promessa = client.inventoryCounts([], { all: true, scopes: [1] });
  await sleep(5);
  const envio = [...ws.sent].reverse().find(m => m.inventory_page);
  assert.equal(envio.inventory_page.filter, undefined, 'sem filtro é a varredura');
  assert.equal(envio.inventory_page.page_size, 100);

  ws.reply('inventory_page', 'inventory_page', {
    items: [inst(1, 'arco'), inst(2, 'po-arcano', { qty: 617 })], has_next: false
  });
  const res = await promessa;
  assert.equal(res.owned.arco.qty, 1);
  assert.equal(res.owned['po-arcano'].qty, 617);
  client.disconnect();
});

test('pedir sem itens e sem all continua não varrendo nada', async () => {
  // A proteção contra varredura acidental tem de sobreviver à opção nova.
  const { client, ws } = await conectado();
  const antes = ws.sent.length;
  const res = await client.inventoryCounts([]);
  assert.deepEqual(res.owned, {});
  assert.equal(ws.sent.length, antes);
  client.disconnect();
});

test('a bolsa é lida por conta e nomeia quem ficou de fora', async () => {
  const manager = new LevelingHeadlessManager({ WebSocket: MockWebSocket, autoReconnect: false });
  manager.start(0, { username: 'u1', password: 'p' });
  await sleep(10);
  const ws0 = MockWebSocket.last;
  ws0.reply('login', 'auth_ok', { token: 't', account_id: 1, username: 'primeira' });
  await sleep(5);

  manager.start(1, { username: 'u2', password: 'p' });
  const c1 = manager.getClient(1);
  c1.status = 'disconnected';
  c1.state.name = 'segunda';

  const promessa = manager.inventoryBags();
  await sleep(10);
  ws0.reply('inventory_page', 'inventory_page', { items: [inst(1, 'arco')], has_next: false });
  await sleep(5);
  ws0.reply('inventory_page', 'inventory_page', { items: [], has_next: false });

  const res = await promessa;
  assert.equal(res.contas.length, 1);
  assert.equal(res.contas[0].name, 'primeira');
  assert.equal(res.contas[0].owned.arco.qty, 1);
  assert.ok(res.offline.some(o => o.name === 'segunda'),
    'conta sem monitor é nomeada: a bolsa dela é desconhecida, não vazia');
  manager.stopAll();
});

test('sem nenhuma conta em monitor a bolsa vem vazia, sem erro', async () => {
  // Vazio sem erro é a resposta honesta: a tela diz "ligue o monitor", não
  // "você não tem nada".
  const manager = new LevelingHeadlessManager({ WebSocket: MockWebSocket, autoReconnect: false });
  const res = await manager.inventoryBags();
  assert.deepEqual(res.contas, []);
  assert.deepEqual(res.offline, []);
  manager.stopAll();
});

// ------------------------------------------------------- nível das vendas

test('o enriquecedor pergunta o nível anúncio por anúncio e grava o que vem', async () => {
  // `MarketSale` não tem nível. Quem tem é `MarketListing` — e medido, `get`
  // num anúncio JÁ VENDIDO ainda responde, com o level intacto. Sem isto o
  // histórico diria "Topázio" sem dizer qual dos quatro.
  const manager = new LevelingHeadlessManager({ WebSocket: MockWebSocket, autoReconnect: false });
  manager.start(0, { username: 'u', password: 'p' });
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1, username: 'eu' });
  await sleep(5);

  const gravadas = [];
  manager.marketDb = {
    pendingLevels: () => [
      { listing_id: 700, def_id: 'gema-topazio', name: 'Topázio' },
      { listing_id: 701, def_id: 'gema-topazio', name: 'Topázio' }
    ],
    setLevels: linhas => { gravadas.push(...linhas); return linhas.length; }
  };

  const promessa = manager.enrichLevels(5);
  await sleep(10);
  assert.deepEqual(ws.lastMarket(), { get: { id: '700' } },
    'em série: o primeiro anúncio antes do segundo');
  ws.reply('market_request', 'market_response', {
    detail: { listing: { id: 700, level: 3, slot: '', status: 4 } }
  });
  await sleep(10);
  assert.deepEqual(ws.lastMarket(), { get: { id: '701' } },
    'só depois da resposta o segundo sai — centenas de pedidos de uma vez é o que faz um servidor recusar');
  ws.reply('market_request', 'market_response', {
    detail: { listing: { id: 701, level: 1, slot: '' } }
  });

  assert.equal(await promessa, 2);
  assert.deepEqual(gravadas.map(g => g.level), [3, 1]);
  assert.equal(manager.getMarketStats().levels.achados, 2);
  manager.stopAll();
});

test('anúncio que já expirou é marcado com 0, para não ser perguntado para sempre', async () => {
  const manager = new LevelingHeadlessManager({ WebSocket: MockWebSocket, autoReconnect: false });
  manager.start(0, { username: 'u', password: 'p' });
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1, username: 'eu' });
  await sleep(5);

  const gravadas = [];
  manager.marketDb = {
    pendingLevels: () => [{ listing_id: 900, def_id: 'arco', name: 'Arco' }],
    setLevels: linhas => { gravadas.push(...linhas); return linhas.length; }
  };

  const promessa = manager.enrichLevels(5);
  await sleep(10);
  // O erro vem no envelope, não dentro de `market_response`: é assim que o
  // servidor recusa um anúncio que já não existe.
  ws.reply('market_request', 'error', { code: 'market.notFound' });

  await promessa;
  assert.deepEqual(gravadas, [{ listing_id: 900, level: 0 }],
    'insistir num id que o servidor já esqueceu gastaria tráfego sem resposta possível');
  assert.equal(manager.getMarketStats().levels.falhas, 1);
  assert.equal(manager.getMarketStats().levels.achados, 0);
  manager.stopAll();
});

test('sem banco, sem conta, ou já rodando, o enriquecedor não faz nada', async () => {
  // Reentrância importa: o coletor dispara isto a cada tique, e dois lotes
  // sobrepostos perguntariam duas vezes a mesma coisa.
  const manager = new LevelingHeadlessManager({ WebSocket: MockWebSocket, autoReconnect: false });
  assert.equal(await manager.enrichLevels(), 0, 'sem banco não há fila');

  manager.marketDb = { pendingLevels: () => [{ listing_id: 1 }], setLevels: () => 0 };
  assert.equal(await manager.enrichLevels(), 0, 'sem conta em monitor não há quem perguntar');

  manager.levelBusy = true;
  assert.equal(await manager.enrichLevels(), 0, 'um lote por vez');
  manager.stopAll();
});

test('o enriquecedor sob demanda pergunta só os anúncios pedidos', async () => {
  // A aba "Ao vivo" pergunta pelo que está na tela. Sem o repasse da lista,
  // ela gastaria o orçamento na fila de fundo e o nível apareceria no banco
  // para depois, não na tela aberta.
  const manager = new LevelingHeadlessManager({ WebSocket: MockWebSocket, autoReconnect: false });
  manager.start(0, { username: 'u', password: 'p' });
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1, username: 'eu' });
  await sleep(5);

  const pedidos = [];
  manager.marketDb = {
    pendingLevels: (n, ids) => { pedidos.push({ n, ids }); return [{ listing_id: 772, def_id: 'gema-topazio' }]; },
    setLevels: () => 1
  };

  const promessa = manager.enrichLevels(2, [771, 772]);
  await sleep(10);
  assert.deepEqual(pedidos, [{ n: 2, ids: [771, 772] }],
    'a lista da tela tem de chegar ao banco, senão a fila de fundo responde outra pergunta');
  ws.reply('market_request', 'market_response', { detail: { listing: { id: 772, level: 2 } } });
  await promessa;
  manager.stopAll();
});

// ------------------------------------------------------------------- sniper

/**
 * O sniper é a única escrita de mercado do launcher. Estes testes cobrem o que
 * o domínio puro não alcança: que a busca sai com os filtros certos, que a
 * compra sai com o id convertido, que o log distingue "comprei" de "outra
 * pessoa levou", e que o contador do alvo é gravado — sem isso, reabrir o
 * launcher soltaria o limite de compra.
 */

/** Um `MarketListing` ativo, como a busca devolve. */
const anuncio = (id, defId, preco, extra = {}) => ({
  id,
  kind: 1,
  status: 1,
  currency: 1,
  unit_price: preco,
  quantity: 1,
  total: preco,
  name: defId,
  category: 'materiais',
  def_id: defId,
  ...extra
});

const regra = patch => ({ defId: 'topazio', maxGold: 1000, account: 0, ...patch });

/** Manager com uma conta conectada e o sniper já configurado. */
async function comSniper(sniperConfig, opts = {}) {
  const mgr = new LevelingHeadlessManager({
    WebSocket: MockWebSocket,
    autoReconnect: false,
    requestTimeoutMs: 200,
    sniperConfig,
    ...opts
  });
  mgr.start(0, { username: 'a', password: 'b' });
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1, username: 'eu' });
  await sleep(5);
  return { mgr, ws };
}

test('a busca do sniper manda o teto de preço e a moeda pelo número do enum', async () => {
  // `verify` recusa o nome do enum na codificação, medido: "enum value
  // expected". Mandar o teto ao servidor é o que faz a pechincha caber na
  // primeira página em vez de obrigar a paginar o mercado inteiro.
  const { mgr, ws } = await comSniper({ enabled: true, rules: [regra({ minLevel: 2 })] });

  const promessa = mgr.pollSniper();
  await sleep(5);
  assert.deepEqual(ws.lastMarket(), {
    search: {
      def_id: 'topazio',
      currency: 'MARKET_CURRENCY_GOLD',
      price_max: '1000',
      level_min: 2,
      sort: 'preco-asc',
      page: 1
    }
  });

  ws.reply('market_request', 'market_response', { page: { listings: [] } });
  await promessa;
  mgr.stopAll();
});

test('anúncio dentro do teto é comprado, e a compra sai com id e quantidade', async () => {
  const gravadas = [];
  const { mgr, ws } = await comSniper(
    { enabled: true, rules: [regra({ target: 5 })] },
    { sniperSink: cfg => gravadas.push(cfg) }
  );

  const promessa = mgr.pollSniper();
  await sleep(5);
  ws.reply('market_request', 'market_response', {
    page: { listings: [anuncio(501, 'topazio', 900, { quantity: 2, total: 1800 })] }
  });
  await sleep(5);

  assert.deepEqual(ws.lastMarket(), { buy: { id: '501', quantity: '2' } });
  ws.reply('market_request', 'market_response', {
    bought: { id: 501, currency: 1, total: 1800, quantity: 2, remaining: 0 }
  });

  assert.equal(await promessa, 2);
  const [log] = mgr.getSniperLog();
  assert.equal(log.status, 'bought');
  assert.equal(log.mine, true);
  assert.equal(log.quantity, 2);
  assert.equal(log.total, 1800);
  assert.ok(log.closedAtMs > 0, 'o horário da compra fica no log');
  assert.equal(mgr.getSniperStats().spentGold, 1800);
  // O contador do alvo é gravado: só em memória, reabrir o launcher zeraria o
  // limite e a compra aconteceria de novo.
  assert.equal(gravadas.length, 1);
  assert.equal(gravadas[0].rules[0].bought, 2);
  mgr.stopAll();
});

test('a quantidade comprada é a do servidor, não a pedida', async () => {
  // Compra parcial: contar o pedido inflaria o alvo e pararia a caça antes.
  const { mgr, ws } = await comSniper({ enabled: true, rules: [regra({ target: 10 })] });

  const promessa = mgr.pollSniper();
  await sleep(5);
  ws.reply('market_request', 'market_response', {
    page: { listings: [anuncio(502, 'topazio', 100, { quantity: 8, total: 800 })] }
  });
  await sleep(5);
  ws.reply('market_request', 'market_response', {
    bought: { id: 502, currency: 1, total: 300, quantity: 3, remaining: 5 }
  });

  assert.equal(await promessa, 3);
  assert.equal(mgr.getSniperConfig().rules[0].bought, 3);
  mgr.stopAll();
});

test('anúncio acima do teto não gera compra nenhuma', async () => {
  const { mgr, ws } = await comSniper({ enabled: true, rules: [regra({ maxGold: 500 })] });

  const promessa = mgr.pollSniper();
  await sleep(5);
  // O servidor pode devolver o que quiser: o filtro local não confia na
  // resposta, e é ele que impede a compra de um preço fora do teto.
  ws.reply('market_request', 'market_response', {
    page: { listings: [anuncio(503, 'topazio', 9000)] }
  });

  assert.equal(await promessa, 0);
  assert.deepEqual(mgr.getSniperLog(), [], 'o que não casa não entra no log');
  assert.equal(mgr.getSniperStats().buys, 0);
  mgr.stopAll();
});

test('perder a corrida é registrado como "outra pessoa levou", não como erro', async () => {
  const { mgr, ws } = await comSniper({ enabled: true, rules: [regra()] });

  const promessa = mgr.pollSniper();
  await sleep(5);
  ws.reply('market_request', 'market_response', {
    page: { listings: [anuncio(504, 'topazio', 100)] }
  });
  await sleep(5);
  ws.reply('market_request', 'error', { code: 'market.notFound' });

  assert.equal(await promessa, 0);
  const [log] = mgr.getSniperLog();
  assert.equal(log.status, 'lost');
  assert.equal(log.mine, false);
  assert.equal(log.error, 'market.notFound');
  // Não é falha do launcher: ocupar `lastError` com isso faria a tela acusar
  // erro a cada item disputado.
  assert.equal(mgr.getSniperStats().lastError, '');
  mgr.stopAll();
});

test('recusa por ouro insuficiente é falha, e aparece como tal', async () => {
  const { mgr, ws } = await comSniper({ enabled: true, rules: [regra()] });

  const promessa = mgr.pollSniper();
  await sleep(5);
  ws.reply('market_request', 'market_response', {
    page: { listings: [anuncio(505, 'topazio', 100)] }
  });
  await sleep(5);
  ws.reply('market_request', 'error', { code: 'market.gold' });

  await promessa;
  assert.equal(mgr.getSniperLog()[0].status, 'failed');
  assert.equal(mgr.getSniperStats().lastError, 'market.gold');
  mgr.stopAll();
});

test('o anúncio que sumiu é investigado, e o comprador vai para o log', async () => {
  // Sumir da busca não diz o quê: vendido, expirado ou cancelado. Só
  // `market_request{get}` traz `buyer_name`, e sem a pergunta o log diria
  // "desapareceu" em vez de dar o aviso que o usuário pediu.
  const { mgr, ws } = await comSniper({ enabled: true, rules: [regra({ maxGold: 50 })] });

  // Primeira rodada: o item aparece, mas acima do teto não entra no log nem
  // em observação — então forçamos a observação com um casamento de verdade.
  mgr.sniperSeen.set('506', { rule: mgr.getSniperConfig().rules[0].id, account: 0, atMs: Date.now() });
  mgr.sniperLogEntry({ id: '506', status: 'announced', name: 'Topázio' });

  const promessa = mgr.pollSniper();
  await sleep(5);
  ws.reply('market_request', 'market_response', { page: { listings: [] } });
  await sleep(5);
  assert.deepEqual(ws.lastMarket(), { get: { id: '506' } }, 'o anúncio sumido é perguntado');
  ws.reply('market_request', 'market_response', {
    detail: { listing: { id: 506, status: 2, buyer_name: 'OutroJogador', closed_at_ms: 1700 } }
  });
  await promessa;

  const log = mgr.getSniperLog().find(e => e.id === '506');
  assert.equal(log.status, 'lost');
  assert.equal(log.buyer, 'OutroJogador');
  assert.equal(log.mine, false);
  // A linha é a mesma do anúncio, não uma segunda: os dois horários só se
  // comparam quando estão lado a lado.
  assert.equal(log.name, 'Topázio');
  assert.equal(mgr.getSniperLog().filter(e => e.id === '506').length, 1);
  mgr.stopAll();
});

test('salvar a configuração não ressuscita o alvo já cumprido', async () => {
  // O bug: alvo 1, uma compra feita, e a regra comprava de novo "depois de um
  // tempo". A tela do sniper guarda a configuração de quando abriu; quem
  // incrementa o contador é o laço aqui, então a cópia da tela fica com
  // `bought: 0`. Qualquer gravação posterior — mexer no intervalo, ligar e
  // desligar, editar outra regra — mandava esse zero de volta, o alvo voltava
  // a ter vaga e a compra acontecia outra vez.
  const { mgr, ws } = await comSniper({ enabled: true, rules: [regra({ target: 1 })] });

  const promessa = mgr.pollSniper();
  await sleep(5);
  ws.reply('market_request', 'market_response', {
    page: { listings: [anuncio(520, 'topazio', 100)] }
  });
  await sleep(5);
  ws.reply('market_request', 'market_response', {
    bought: { id: 520, currency: 1, total: 100, quantity: 1, remaining: 0 }
  });
  await promessa;
  assert.equal(mgr.getSniperConfig().rules[0].bought, 1);

  // A tela salva a sua cópia velha. É o caso real: ela não sabe da compra.
  mgr.setSniperConfig({ enabled: true, intervalMs: 9000, rules: [regra({ target: 1 })] });
  assert.equal(mgr.getSniperConfig().rules[0].bought, 1,
    'o contador é do serviço: a tela não pode abaixá-lo com uma cópia velha');
  assert.equal(mgr.getSniperConfig().intervalMs, 9000, 'o resto da gravação vale normalmente');

  // E a regra realmente não compra mais: nenhum pedido sai.
  assert.equal(await mgr.pollSniper(), 0);
  mgr.stopAll();
});

test('zerar a contagem é um pedido explícito, e funciona', async () => {
  // O contador só desce quando o usuário clica em "zerar". Sem isso o botão
  // teria sido quebrado pela proteção acima — e a proteção não pode custar a
  // única forma legítima de recomeçar a caça.
  const { mgr, ws } = await comSniper({ enabled: true, rules: [regra({ target: 1 })] });

  const promessa = mgr.pollSniper();
  await sleep(5);
  ws.reply('market_request', 'market_response', {
    page: { listings: [anuncio(521, 'topazio', 100)] }
  });
  await sleep(5);
  ws.reply('market_request', 'market_response', {
    bought: { id: 521, currency: 1, total: 100, quantity: 1, remaining: 0 }
  });
  await promessa;

  mgr.setSniperConfig({
    enabled: true,
    rules: [regra({ target: 1, bought: 0, resetBought: true })]
  });
  assert.equal(mgr.getSniperConfig().rules[0].bought, 0);
  mgr.stopAll();
});

test('regra apontada para conta offline não busca nem compra', async () => {
  const { mgr, ws } = await comSniper({ enabled: true, rules: [regra({ account: 3 })] });

  assert.equal(await mgr.pollSniper(), 0);
  assert.equal(ws.lastMarket(), null, 'nenhum pedido sai sem conta para pagar');
  assert.equal(mgr.getSniperStats().lastError, 'sniper.accountOffline');
  mgr.stopAll();
});

test('sniper desligado não gera tráfego nenhum', async () => {
  const { mgr, ws } = await comSniper({ enabled: false, rules: [regra()] });
  assert.equal(await mgr.pollSniper(), 0);
  assert.equal(ws.lastMarket(), null);
  assert.equal(mgr.startSniperPoll(), false, 'o laço não liga desligado');
  mgr.stopAll();
});

test('uma rodada por vez: o tique seguinte não entra no meio da anterior', async () => {
  const { mgr, ws } = await comSniper({ enabled: true, rules: [regra()] });

  const primeira = mgr.pollSniper();
  await sleep(5);
  assert.equal(await mgr.pollSniper(), 0, 'a segunda desiste em vez de duplicar a busca');

  ws.reply('market_request', 'market_response', { page: { listings: [] } });
  await primeira;
  mgr.stopAll();
});

test('mudar o intervalo com o laço em curso recria o temporizador', async () => {
  const { mgr, ws } = await comSniper({ enabled: true, intervalMs: 30000, rules: [regra()] });

  assert.equal(mgr.startSniperPoll(), true);
  await sleep(5);
  ws.reply('market_request', 'market_response', { page: { listings: [] } });
  await sleep(5);

  mgr.setSniperConfig({ enabled: true, intervalMs: 2000, rules: [regra()] });
  assert.equal(mgr.getSniperStats().intervalMs, 2000);
  assert.equal(mgr.getSniperStats().running, true);

  mgr.stopSniperPoll();
  assert.equal(mgr.getSniperStats().running, false);
  mgr.stopAll();
});

test('o log tem teto e pode ser limpo', async () => {
  const { mgr } = await comSniper({ enabled: true, rules: [regra()] });
  for (let i = 0; i < 350; i++) mgr.sniperLogEntry({ id: String(i), status: 'announced' });
  assert.equal(mgr.getSniperLog().length, 300);
  assert.equal(mgr.getSniperLog()[0].id, '349', 'o mais recente em cima');
  mgr.clearSniperLog();
  assert.deepEqual(mgr.getSniperLog(), []);
  mgr.stopAll();
});

test('o log é entregue a quem grava, a cada linha e também ao limpar', async () => {
  const { mgr } = await comSniper({ enabled: true, rules: [regra()] });
  const escritas = [];
  mgr.sniperLogSink = entries => escritas.push(entries.length);

  mgr.sniperLogEntry({ id: '601', status: 'announced', name: 'Topázio' });
  mgr.sniperLogEntry({ id: '602', status: 'bought', name: 'Rubi' });
  // Mesmo anúncio outra vez é atualização no lugar, não linha nova: o log
  // continua com duas, e a gravação acontece de novo.
  mgr.sniperLogEntry({ id: '601', status: 'lost' });
  assert.deepEqual(escritas, [1, 2, 2]);

  mgr.clearSniperLog();
  assert.deepEqual(escritas, [1, 2, 2, 0], 'limpar também grava, senão o arquivo ressuscitaria');
  mgr.stopAll();
});

test('uma falha ao gravar não derruba o log', async () => {
  const { mgr } = await comSniper({ enabled: true, rules: [regra()] });
  mgr.sniperLogSink = () => { throw new Error('disco cheio'); };
  // A linha é o que o usuário quer ver; o arquivo é conveniência. Uma exceção
  // aqui subiria pela compra e a abortaria depois do ouro já ter saído.
  assert.doesNotThrow(() => mgr.sniperLogEntry({ id: '610', status: 'bought' }));
  assert.equal(mgr.getSniperLog().length, 1);
  mgr.stopAll();
});

test('o log gravado volta, com o teto e sem desfecho pendente', async () => {
  const { mgr } = await comSniper({ enabled: true, rules: [regra()] });

  assert.equal(mgr.setSniperLog([
    { id: 701, status: 'bought', name: 'Topázio' },
    { id: '702', status: 'announced', name: 'Rubi' },
    null,
    { status: 'bought', name: 'sem id' }
  ]), true);

  const log = mgr.getSniperLog();
  assert.equal(log.length, 2, 'linha sem id não volta: ela é a chave do anúncio');
  assert.equal(log[0].id, '701', 'o id volta como texto, como o resto do log usa');
  assert.equal(log[0].status, 'bought');
  // `sniperSeen` é de sessão: ninguém mais vai resolver aquele anúncio, e
  // deixá-lo em "anunciado" prometeria uma resposta que não vem.
  assert.equal(log[1].status, 'unknown');

  assert.equal(mgr.setSniperLog('nada disso'), false, 'o que não é lista é recusado');
  assert.equal(mgr.getSniperLog().length, 2, 'e o log em memória fica como estava');

  mgr.setSniperLog(Array.from({ length: 400 }, (_, i) => ({ id: i, status: 'bought' })));
  assert.equal(mgr.getSniperLog().length, 300, 'o teto vale também para o que vem do disco');

  mgr.stopAll();
});

test('mochila cheia é dita no log: o item foi para o correio', async () => {
  const { mgr, ws } = await comSniper({ enabled: true, rules: [regra()] });

  const promessa = mgr.pollSniper();
  await sleep(5);
  ws.reply('market_request', 'market_response', {
    page: { listings: [anuncio(507, 'topazio', 100)] }
  });
  await sleep(5);
  ws.reply('market_request', 'market_response', {
    bought: { id: 507, currency: 1, total: 100, quantity: 1, to_mail: true }
  });
  await promessa;

  assert.equal(mgr.getSniperLog()[0].toMail, true);
  mgr.stopAll();
});
