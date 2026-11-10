const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getCodec } = require('../src/domain/leveling-codec');
const { LevelingHeadlessManager } = require('../src/domain/leveling-headless-service');

const codec = getCodec();

/**
 * O laço do auto-anunciar contra um servidor de mentira.
 *
 * O domínio puro (`leveling-autosell.test.cjs`) já cobre o que decidir. O que
 * só aparece aqui é a **ordem** e o **tráfego**: recolher o correio antes de
 * ler as vagas, não ler a bolsa quando não há vaga, não buscar preço para
 * equipamento que nunca vai ser anunciado, e parar quando a bolsa enche. Cada
 * um desses é um erro que o teste de unidade não enxerga porque não existe
 * socket nele.
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

  /** Os `market_request` enviados, já desembrulhados, na ordem. */
  markets() {
    return this.sent.filter(m => m.market_request).map(m => m.market_request);
  }

  /** Os `mail_request` enviados, na ordem. */
  mails() {
    return this.sent.filter(m => m.mail_request).map(m => m.mail_request);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Catálogo recortado: é ele que separa tesouro de equipamento. */
const catalog = {
  items: {
    citrino: { name: 'Citrino', category: 'materials' },
    espada: { name: 'Espada', category: 'weapons' }
  }
};

/** Uma `ItemInstance` como `inventory_page` entrega. */
const inst = (uid, defId, extra = {}) => ({
  uid, def_id: defId, rarity: 'raro', level: 1, qty: 1,
  power: 10, enchant: 0, ...extra
});

/** Um `MarketListing` ativo de outra pessoa, como a busca devolve. */
const rival = (id, preco, extra = {}) => ({
  id, kind: 1, status: 1, currency: 1, def_id: 'citrino', name: 'Citrino',
  unit_price: preco, quantity: 1, total: preco, level: 1, enchant: 0, ...extra
});

/**
 * Banco de mentira com duas vendas do nível exato.
 *
 * Duas é o mínimo que `suggestPrice` aceita: uma venda só não é referência de
 * mercado, e o auto-anunciar recusa em vez de estimar.
 */
const bancoCom = (precos, registro) => ({
  salesForPricing: (defId, opts) => {
    if (registro) registro.push({ defId, level: opts && opts.level });
    return precos.map(p => ({ unit_price: p }));
  },
  exchangeRate: () => ({ rate: 0, samples: 0, days: 7 })
});

/**
 * Banco de mentira que responde por moeda e por encanto, e conta as consultas.
 *
 * Separado de `bancoCom` porque os testes antigos comparam o registro com
 * `deepEqual` numa forma de dois campos — ampliá-la ali quebraria todos eles
 * por uma razão que não é a do teste.
 *
 * `vendas` é indexado por `"<moeda>"` e devolve a lista daquela moeda;
 * `encantadas` responde quando o encanto exato é pedido.
 */
const bancoDetalhado = (vendas, opts = {}) => {
  const registro = opts.registro || [];
  const cotacoes = opts.cotacoes || [];
  return {
    registro,
    cotacoes,
    salesForPricing: (defId, o = {}) => {
      registro.push({ defId, level: o.level, enchant: o.enchant, currency: o.currency });
      const moeda = o.currency === 'diamond' ? 'diamond' : 'gold';
      // Encanto pedido e sem resposta própria: a lista fica vazia, que é o que
      // força o segundo degrau do serviço.
      if (o.enchant != null && !(opts.encantadas || {})[moeda]) return [];
      const fonte = o.enchant != null ? opts.encantadas[moeda] : vendas[moeda];
      return (fonte || []).map(p => ({ unit_price: p, quantity: 1 }));
    },
    exchangeRate: o => {
      cotacoes.push(o);
      return { rate: opts.rate || 0, samples: opts.rate ? 5 : 0, days: 7 };
    }
  };
};

/** Manager com uma conta conectada e o auto-anunciar configurado. */
async function comAutosell(autosellConfig, opts = {}) {
  const mgr = new LevelingHeadlessManager({
    WebSocket: MockWebSocket,
    autoReconnect: false,
    requestTimeoutMs: 200,
    marketCatalog: catalog,
    autosellConfig: { enabled: true, ...autosellConfig },
    ...opts
  });
  mgr.start(0, { username: 'a', password: 'b' });
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1, username: 'eu' });
  await sleep(5);
  return { mgr, ws };
}

// ------------------------------------------------------------ rodada inteira

test('a rodada recolhe a venda, lê a vaga, precifica pelo nível e anuncia', async () => {
  const consultas = [];
  const { mgr, ws } = await comAutosell({ maxPerRound: 2 });
  mgr.marketDb = bancoCom([1000, 1000], consultas);

  const promessa = mgr.runAutosell(0);

  // 1. Correio primeiro: sem recolher, a vaga do anúncio vendido continua
  // ocupada e o ouro não entra.
  await sleep(5);
  // `page` é 0-based e o lote é 20: medido contra o servidor real. Pedir
  // `page:1, page_size:50` caía depois do fim da caixa e voltava vazio **sem
  // erro**, escondendo as cartas novas — que ficam todas na página zero.
  assert.deepEqual(ws.mails()[0], { list: { page_size: 20 } });
  ws.reply('mail_request', 'mail_response', {
    page: {
      entries: [
        { id: 10, kind: 'market', subject_key: 'market_sale', gold: 5000, claimed_at_ms: 0 },
        { id: 11, kind: 'reward', subject_key: 'daily_boss', gold: 90, claimed_at_ms: 0 }
      ],
      unclaimed: 2
    }
  });

  await sleep(5);
  assert.deepEqual(ws.mails()[1], { claim: { id: '10' } },
    'só a venda é recolhida: a recompensa do chefe diário fica onde está');
  ws.reply('mail_request', 'mail_response', { claimed: { claimed: [10], gold: 5000 } });

  // 2. As vagas, do servidor.
  await sleep(5);
  assert.deepEqual(ws.markets()[0], { mine: {} });
  ws.reply('market_request', 'market_response', { mine: { listings: [], active: 0, limit: 10 } });

  // 3. A bolsa, só o escopo 1.
  await sleep(5);
  const invio = ws.sent.find(m => m.inventory_page);
  assert.equal(invio.inventory_page.scope, 'INVENTORY_SCOPE_BAG',
    'o depósito fica de fora: lá está o que foi guardado de propósito');
  ws.reply('inventory_page', 'inventory_page', {
    items: [inst('1962493714927616001', 'citrino', { locked: true })], has_next: false
  });

  // 4. Preço: mediana do banco com o nível exato, e rival buscado na faixa.
  await sleep(5);
  assert.deepEqual(consultas, [{ defId: 'citrino', level: 1 }],
    'a mediana é pedida com o nível: um nv. 2 vale 3x um nv. 1');
  const busca = ws.markets()[1];
  assert.equal(busca.search.def_id, 'citrino');
  assert.equal(busca.search.level_min, 1);
  assert.equal(busca.search.level_max, 1, 'min e max iguais é o nível exato');
  assert.equal(busca.search.sort, 'preco-asc');
  ws.reply('market_request', 'market_response', {
    page: { listings: [rival(500, 900), rival(501, 1200)] }
  });

  // 5. Destrancar, porque o servidor recusa `create` em item com cadeado.
  await sleep(5);
  const trava = ws.sent.find(m => m.lock_item);
  assert.equal(String(trava.lock_item.uid), '1962493714927616001',
    'o uid grande vai intacto: arredondar destrancaria a peça vizinha');
  assert.equal(trava.lock_item.locked, undefined, 'destrancar é locked falso, omitido pelo proto3');
  ws.reply('lock_item', 'lock_item_result', { locked: false });

  // 6. `create`, um ouro abaixo do rival mais barato.
  await sleep(5);
  const criado = ws.markets()[2];
  assert.equal(criado.create.unit_price, '899', 'rival a 900, desconto de 1');
  assert.equal(String(criado.create.item_uid), '1962493714927616001');
  ws.reply('market_request', 'market_response', { created: { listing: { id: 777 } } });

  assert.equal(await promessa, 1);

  const log = mgr.getAutosellLog();
  const anunciado = log.find(l => l.action === 'list');
  assert.equal(anunciado.unitPrice, 899);
  assert.equal(anunciado.from.median, 1000, 'a conta do preço fica no relatório');
  assert.equal(anunciado.from.rival, 900);
  assert.equal(anunciado.from.floor, 700);
  assert.ok(log.some(l => l.action === 'claim' && l.gold === 5000));
  assert.equal(mgr.getAutosellStats().listed, 1);
  assert.equal(mgr.getAutosellStats().goldClaimed, 5000);
  mgr.stopAll();
});

// ----------------------------------------------------------------- as vagas

test('sem vaga nenhuma a bolsa não é nem lida', async () => {
  // Ler o inventário para descobrir que não há onde anunciar é tráfego por
  // nada, e são oito contas a cada rodada.
  const { mgr, ws } = await comAutosell({});
  mgr.marketDb = bancoCom([1000, 1000]);

  const promessa = mgr.runAutosell(0);
  await sleep(5);
  ws.reply('mail_request', 'mail_response', { page: { entries: [] } });
  await sleep(5);
  ws.reply('market_request', 'market_response', {
    mine: {
      listings: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, status: 1, def_id: 'citrino' })),
      active: 10, limit: 10
    }
  });

  assert.equal(await promessa, 0);
  assert.equal(ws.sent.some(m => m.inventory_page), false, 'nenhuma leitura de bolsa');
  mgr.stopAll();
});

test('anúncio vendido e expirado não ocupam vaga: a contagem é por status', async () => {
  // `mine` mistura os fechados na mesma lista. Contar o tamanho dela diria
  // "sem vagas" com dez anúncios que já saíram.
  const { mgr, ws } = await comAutosell({});
  mgr.marketDb = bancoCom([1000, 1000]);

  const promessa = mgr.runAutosell(0);
  await sleep(5);
  ws.reply('mail_request', 'mail_response', { page: { entries: [] } });
  await sleep(5);
  ws.reply('market_request', 'market_response', {
    mine: {
      listings: [
        { id: 1, status: 2, def_id: 'citrino' },
        { id: 2, status: 3, def_id: 'citrino' },
        { id: 3, status: 4, def_id: 'citrino' }
      ],
      active: 3, limit: 1
    }
  });

  // Com um limite de 1 e três anúncios fechados, ainda há a vaga.
  await sleep(5);
  assert.ok(ws.sent.some(m => m.inventory_page), 'a vaga existe, então a bolsa é lida');
  ws.reply('inventory_page', 'inventory_page', { items: [], has_next: false });
  assert.equal(await promessa, 0);
  mgr.stopAll();
});

// -------------------------------------------------------------- bolsa cheia

test('bolsa cheia interrompe a rodada em vez de insistir', async () => {
  // Anunciar exige destrancar e, às vezes, trazer do depósito. Os dois pioram
  // com a bolsa sem espaço, e o resgate do correio já saiu parcial.
  const { mgr, ws } = await comAutosell({});

  const promessa = mgr.runAutosell(0);
  await sleep(5);
  ws.reply('mail_request', 'mail_response', {
    page: { entries: [{ id: 10, kind: 'market', subject_key: 'market_sale', gold: 1, claimed_at_ms: 0 }] }
  });
  await sleep(5);
  ws.reply('mail_request', 'mail_response', { claimed: { claimed: [10], gold: 1, bag_full: true } });

  assert.equal(await promessa, 0);
  assert.equal(ws.markets().length, 0, 'nem as vagas foram lidas');
  assert.equal(mgr.getAutosellStats().lastError, 'autosell.bagFull');
  assert.ok(mgr.getAutosellLog().some(l => l.reason === 'bagFull'));
  mgr.stopAll();
});

// ------------------------------------------------------- equipamento de fora

test('equipamento não gera nem busca de preço', async () => {
  // O filtro de categoria vem antes do preço: uma busca por item varreria o
  // inventário inteiro atrás de preço para o que nunca vai ser anunciado.
  const consultas = [];
  const { mgr, ws } = await comAutosell({});
  mgr.marketDb = bancoCom([9000000, 9000000], consultas);

  const promessa = mgr.runAutosell(0);
  await sleep(5);
  ws.reply('mail_request', 'mail_response', { page: { entries: [] } });
  await sleep(5);
  ws.reply('market_request', 'market_response', { mine: { listings: [], active: 0, limit: 10 } });
  await sleep(5);
  ws.reply('inventory_page', 'inventory_page', {
    items: [inst('5', 'espada'), inst('6', 'desconhecido')], has_next: false
  });

  assert.equal(await promessa, 0);
  assert.deepEqual(consultas, [], 'nenhum preço consultado');
  assert.equal(ws.markets().length, 1, 'só o `mine`: nenhuma busca saiu');

  const vazia = mgr.getAutosellLog().find(l => l.action === 'none');
  assert.equal(vazia.skipped.gear, 1, 'a espada aparece recusada, não esquecida');
  assert.equal(vazia.skipped.noCategory, 1, 'e o item fora do catálogo também');
  mgr.stopAll();
});

test('item bloqueado não gera nem busca de preço', async () => {
  // O bloqueio é checado antes da precificação de propósito: sem isso, o item
  // barrado ainda custaria uma busca de mercado por rodada e por conta, para
  // ser recusado no passo seguinte.
  const consultas = [];
  const { mgr, ws } = await comAutosell({ blocked: ['citrino'] });
  mgr.marketDb = bancoCom([1000, 1000], consultas);

  const promessa = mgr.runAutosell(0);
  await sleep(5);
  ws.reply('mail_request', 'mail_response', { page: { entries: [] } });
  await sleep(5);
  ws.reply('market_request', 'market_response', { mine: { listings: [], active: 0, limit: 10 } });
  await sleep(5);
  ws.reply('inventory_page', 'inventory_page', { items: [inst('1', 'citrino')], has_next: false });

  assert.equal(await promessa, 0);
  assert.deepEqual(consultas, [], 'nenhuma mediana consultada');
  assert.equal(ws.markets().length, 1, 'só o `mine`: nenhuma busca saiu');
  const vazia = mgr.getAutosellLog().find(l => l.action === 'none');
  assert.equal(vazia.skipped.blocked, 1);
  mgr.stopAll();
});

test('o picker lista o que seria vendido, agregado, sem equipamento', async () => {
  // A pergunta do picker é "do que ele pode vender do meu, o que eu não quero
  // que saia" — então ele parte do inventário real, não do catálogo inteiro.
  const { mgr, ws } = await comAutosell({ blocked: ['citrino'] });

  const promessa = mgr.autosellCandidates();
  await sleep(5);
  const envio = ws.sent.find(m => m.inventory_page);
  assert.equal(envio.inventory_page.scope, 'INVENTORY_SCOPE_BAG', 'só a bolsa');
  ws.reply('inventory_page', 'inventory_page', {
    items: [
      inst('1', 'citrino', { qty: 5 }),
      inst('2', 'citrino', { qty: 3, level: 2 }),
      inst('3', 'espada'),
      inst('4', 'desconhecido')
    ],
    has_next: false
  });

  const res = await promessa;
  assert.deepEqual(res.items.map(i => i.defId), ['citrino'],
    'equipamento e item fora do catálogo não entram: bloqueá-los não teria efeito');
  assert.equal(res.items[0].qty, 8, 'os dois níveis somam na mesma linha');
  assert.deepEqual(res.items[0].levels, [1, 2]);
  assert.equal(res.items[0].name, 'Citrino');
  mgr.stopAll();
});

test('o picker continua mostrando o que já está bloqueado', async () => {
  // Esconder o item barrado tornaria impossível desmarcá-lo pela própria tela
  // que o marcou.
  const { mgr, ws } = await comAutosell({ blocked: ['citrino'] });
  const promessa = mgr.autosellCandidates();
  await sleep(5);
  ws.reply('inventory_page', 'inventory_page', { items: [inst('1', 'citrino')], has_next: false });
  const res = await promessa;
  assert.equal(res.items.length, 1);
  mgr.stopAll();
});

test('o picker sem catálogo diz que não sabe, em vez de listar vazio', async () => {
  const { mgr } = await comAutosell({}, { marketCatalog: null });
  const res = await mgr.autosellCandidates();
  assert.equal(res.errorCode, 'autosell.noCatalog');
  assert.deepEqual(res.items, []);
  mgr.stopAll();
});

test('sem catálogo nada é anunciado', async () => {
  // Classificar por `def_id` adivinhado venderia equipamento como se fosse
  // gema. A rodada espera a próxima leitura do catálogo.
  const { mgr, ws } = await comAutosell({}, { marketCatalog: null });
  const promessa = mgr.runAutosell(0);
  assert.equal(await promessa, 0);
  assert.equal(ws.mails().length, 0, 'nem o correio é tocado');
  assert.equal(mgr.getAutosellStats().lastError, 'autosell.noCatalog');
  mgr.stopAll();
});

// ------------------------------------------------------------ preço e cache

test('o preço é consultado uma vez por nível, não uma vez por item', async () => {
  // Três citrinos nv. 1 na bolsa são um produto só no mercado. Sem o cache
  // seriam três buscas idênticas por conta, por rodada.
  const consultas = [];
  const { mgr, ws } = await comAutosell({ maxPerRound: 1 });
  mgr.marketDb = bancoCom([1000, 1000], consultas);

  const promessa = mgr.runAutosell(0);
  await sleep(5);
  ws.reply('mail_request', 'mail_response', { page: { entries: [] } });
  await sleep(5);
  ws.reply('market_request', 'market_response', { mine: { listings: [], active: 0, limit: 10 } });
  await sleep(5);
  ws.reply('inventory_page', 'inventory_page', {
    items: [inst('1', 'citrino'), inst('2', 'citrino'), inst('3', 'citrino')], has_next: false
  });
  await sleep(5);
  ws.reply('market_request', 'market_response', { page: { listings: [rival(500, 900)] } });
  await sleep(5);
  ws.reply('market_request', 'market_response', { created: { listing: { id: 1 } } });

  assert.equal(await promessa, 1, 'o teto da rodada é um');
  assert.equal(consultas.length, 1, 'uma consulta de mediana');
  assert.equal(ws.markets().filter(m => m.search).length, 1, 'uma busca de rival');
  mgr.stopAll();
});

test('o cache de preço não sobrevive à rodada', async () => {
  // O anúncio rival é o dado que mais envelhece aqui: um preço de dez minutos
  // atrás faria o launcher anunciar abaixo de um mercado que já subiu.
  const { mgr } = await comAutosell({});
  mgr.autosellPrices.set('citrino@1+0', { median: 1, samples: 9, rival: 1 });
  await mgr.pollAutosell();
  assert.equal(mgr.autosellPrices.size, 0);
  mgr.stopAll();
});

test('rival despejando estoque não anuncia, e o relatório diz o piso furado', async () => {
  const { mgr, ws } = await comAutosell({});
  mgr.marketDb = bancoCom([2000000, 2000000]);

  const promessa = mgr.runAutosell(0);
  await sleep(5);
  ws.reply('mail_request', 'mail_response', { page: { entries: [] } });
  await sleep(5);
  ws.reply('market_request', 'market_response', { mine: { listings: [], active: 0, limit: 10 } });
  await sleep(5);
  ws.reply('inventory_page', 'inventory_page', { items: [inst('1', 'citrino')], has_next: false });
  await sleep(5);
  // Alguém a 9% da mediana. Acompanhar a queda liquidaria o inventário.
  ws.reply('market_request', 'market_response', { page: { listings: [rival(500, 180000)] } });

  assert.equal(await promessa, 0);
  assert.equal(ws.markets().some(m => m.create), false, 'nada foi anunciado');
  const vazia = mgr.getAutosellLog().find(l => l.action === 'none');
  assert.equal(vazia.skipped['price.marketDumped'], 1);
  mgr.stopAll();
});

test('sem mediana do nível exato, não há nem busca de rival', async () => {
  // O item vai ser pulado de qualquer forma; buscar seria tráfego por um
  // preço que não vai ser usado. `price_hint` responderia, mas ignora o nível.
  const { mgr, ws } = await comAutosell({});
  mgr.marketDb = { salesForPricing: () => [{ unit_price: 1000 }] };

  const promessa = mgr.runAutosell(0);
  await sleep(5);
  ws.reply('mail_request', 'mail_response', { page: { entries: [] } });
  await sleep(5);
  ws.reply('market_request', 'market_response', { mine: { listings: [], active: 0, limit: 10 } });
  await sleep(5);
  ws.reply('inventory_page', 'inventory_page', { items: [inst('1', 'citrino')], has_next: false });

  assert.equal(await promessa, 0);
  assert.equal(ws.markets().filter(m => m.search).length, 0, 'uma venda só não é referência');
  const vazia = mgr.getAutosellLog().find(l => l.action === 'none');
  assert.equal(vazia.skipped['price.noLevelData'], 1);
  mgr.stopAll();
});

// ------------------------------------------------------- modo média e moeda

/** Leva a rodada até o ponto em que a bolsa já respondeu. */
async function ateBolsa(ws, items) {
  await sleep(5);
  ws.reply('mail_request', 'mail_response', { page: { entries: [] } });
  await sleep(5);
  ws.reply('market_request', 'market_response', { mine: { listings: [], active: 0, limit: 10 } });
  await sleep(5);
  ws.reply('inventory_page', 'inventory_page', { items, has_next: false });
  await sleep(5);
}

test('o modo média não gasta busca de rival: o rival não entra na conta', async () => {
  // É o que torna o modo média mais barato por rodada que o original. Buscar
  // seria tráfego por um número que ninguém lê.
  const { mgr, ws } = await comAutosell({ priceMode: 'average' });
  mgr.marketDb = bancoDetalhado({ gold: [1000000, 1400000] });

  const promessa = mgr.runAutosell(0);
  await ateBolsa(ws, [inst('1', 'citrino')]);

  assert.equal(ws.markets().filter(m => m.search).length, 0, 'nenhuma busca saiu');
  const criado = ws.markets().find(m => m.create);
  assert.equal(criado.create.unit_price, '1200000', 'a média das duas vendas');
  ws.reply('market_request', 'market_response', { created: { listing: { id: 1 } } });
  assert.equal(await promessa, 1);
  mgr.stopAll();
});

test('a mediana é pedida com o encanto exato, e só depois sem ele', async () => {
  // A chave do cache é `defId@level+enchant`: filtrar só por nível fazia a
  // peça +3 sair pelo preço da +0, e o `lowestRival` sempre exigiu os dois.
  const banco = bancoDetalhado({ gold: [1000000, 1400000] });
  const { mgr, ws } = await comAutosell({ priceMode: 'average' });
  mgr.marketDb = banco;

  const promessa = mgr.runAutosell(0);
  await ateBolsa(ws, [inst('1', 'citrino', { enchant: 3 })]);

  assert.deepEqual(banco.registro, [
    { defId: 'citrino', level: 1, enchant: 3, currency: 'gold' },
    { defId: 'citrino', level: 1, enchant: undefined, currency: 'gold' }
  ], 'primeiro o encanto exato; a queda para o nível só por falta de amostra');

  const criado = ws.markets().find(m => m.create);
  ws.reply('market_request', 'market_response', { created: { listing: { id: 1 } } });
  await promessa;
  assert.equal(mgr.getAutosellLog().find(l => l.action === 'list').from.enchantApprox, true,
    'a aproximação é dita em voz alta, não estimada calada');
  assert.ok(criado);
  mgr.stopAll();
});

test('com amostra do encanto exato, não há segundo degrau', async () => {
  const banco = bancoDetalhado(
    { gold: [10, 10] },
    { encantadas: { gold: [2000000, 2000000] } }
  );
  const { mgr, ws } = await comAutosell({ priceMode: 'average' });
  mgr.marketDb = banco;

  const promessa = mgr.runAutosell(0);
  await ateBolsa(ws, [inst('1', 'citrino', { enchant: 3 })]);

  assert.equal(banco.registro.length, 1, 'uma consulta só');
  const criado = ws.markets().find(m => m.create);
  assert.equal(criado.create.unit_price, '2000000', 'o preço é o do encanto, não o do nível');
  ws.reply('market_request', 'market_response', { created: { listing: { id: 1 } } });
  await promessa;
  assert.equal(mgr.getAutosellLog().find(l => l.action === 'list').from.enchantApprox, false);
  mgr.stopAll();
});

test('em diamante o anúncio sai na moeda escolhida, convertido pela cotação', async () => {
  // Era `'gold'` cravado no `create`: o preço seria calculado em diamante e o
  // anúncio sairia em ouro, três ordens de grandeza abaixo do valor.
  const banco = bancoDetalhado({ gold: [3800000, 3800000] }, { rate: 380000 });
  const { mgr, ws } = await comAutosell({ priceMode: 'average', currency: 'diamond' });
  mgr.marketDb = banco;

  const promessa = mgr.runAutosell(0);
  await ateBolsa(ws, [inst('1', 'citrino')]);

  // Diamante primeiro, sem resposta; o ouro é a volta que faz o modo vender.
  assert.deepEqual(banco.registro.map(r => r.currency),
    ['diamond', 'diamond', 'gold', 'gold']);

  const criado = ws.markets().find(m => m.create);
  assert.equal(criado.create.currency, 'MARKET_CURRENCY_DIAMOND');
  assert.equal(criado.create.unit_price, '10', '3,8 M a 380 k por diamante');
  ws.reply('market_request', 'market_response', { created: { listing: { id: 1 } } });
  assert.equal(await promessa, 1);

  const linha = mgr.getAutosellLog().find(l => l.action === 'list');
  assert.equal(linha.currency, 'diamond');
  assert.equal(linha.from.rate, 380000, 'a taxa usada fica para auditar');
  assert.equal(linha.from.goldPrice, 3800000);
  mgr.stopAll();
});

test('a cotação é consultada uma vez por rodada, e só em diamante', async () => {
  // A taxa não depende do item: consultá-la por linha de inventário seria a
  // mesma resposta repetida centenas de vezes.
  const banco = bancoDetalhado({ gold: [3800000, 3800000] }, { rate: 380000 });
  const { mgr, ws } = await comAutosell({ priceMode: 'average', currency: 'diamond', maxPerRound: 2 });
  mgr.marketDb = banco;

  const promessa = mgr.runAutosell(0);
  await ateBolsa(ws, [inst('1', 'citrino'), inst('2', 'citrino', { level: 2 })]);
  for (let i = 0; i < 2; i++) {
    ws.reply('market_request', 'market_response', { created: { listing: { id: i + 1 } } });
    await sleep(5);
  }
  await promessa;
  assert.equal(banco.cotacoes.length, 1, 'uma cotação para dois itens de níveis diferentes');
  mgr.stopAll();
});

test('em ouro a cotação não é nem consultada', async () => {
  // Um banco sem histórico de câmbio não paga uma consulta por rodada à toa.
  const banco = bancoDetalhado({ gold: [1000000, 1000000] }, { rate: 380000 });
  const { mgr, ws } = await comAutosell({ priceMode: 'average' });
  mgr.marketDb = banco;

  const promessa = mgr.runAutosell(0);
  await ateBolsa(ws, [inst('1', 'citrino')]);
  ws.reply('market_request', 'market_response', { created: { listing: { id: 1 } } });
  await promessa;
  assert.deepEqual(banco.cotacoes, []);
  mgr.stopAll();
});

test('item com histórico em diamante usa aquele preço, sem converter', async () => {
  // `median` já está na moeda final: converter por cima multiplicaria o preço
  // pela cotação e o anúncio sairia em dezenas de milhares de diamantes.
  const banco = bancoDetalhado({ diamond: [40, 40], gold: [100, 100] }, { rate: 380000 });
  const { mgr, ws } = await comAutosell({ priceMode: 'average', currency: 'diamond' });
  mgr.marketDb = banco;

  const promessa = mgr.runAutosell(0);
  await ateBolsa(ws, [inst('1', 'citrino')]);

  const criado = ws.markets().find(m => m.create);
  assert.equal(criado.create.unit_price, '40');
  assert.equal(criado.create.currency, 'MARKET_CURRENCY_DIAMOND');
  ws.reply('market_request', 'market_response', { created: { listing: { id: 1 } } });
  await promessa;
  assert.equal(mgr.getAutosellLog().find(l => l.action === 'list').from.rate, 0,
    'a cotação não entrou na conta');
  mgr.stopAll();
});

test('a cotação também não sobrevive à rodada', async () => {
  const { mgr } = await comAutosell({});
  mgr.autosellRateCache = { rate: 1, samples: 1, days: 7 };
  await mgr.pollAutosell();
  assert.equal(mgr.autosellRateCache, null);
  mgr.stopAll();
});

// ------------------------------------------------------------------- falhas

test('a recusa de um item não derruba a rodada, e vira linha no relatório', async () => {
  const { mgr, ws } = await comAutosell({ maxPerRound: 2 });
  mgr.marketDb = bancoCom([1000, 1000]);

  const promessa = mgr.runAutosell(0);
  await sleep(5);
  ws.reply('mail_request', 'mail_response', { page: { entries: [] } });
  await sleep(5);
  ws.reply('market_request', 'market_response', { mine: { listings: [], active: 0, limit: 10 } });
  await sleep(5);
  ws.reply('inventory_page', 'inventory_page', {
    items: [inst('1', 'citrino', { qty: 5 }), inst('2', 'citrino')], has_next: false
  });
  await sleep(5);
  ws.reply('market_request', 'market_response', { page: { listings: [rival(500, 900)] } });

  // O primeiro é recusado pelo servidor; o segundo tem de sair igual.
  await sleep(5);
  ws.reply('market_request', 'error', { code: 'market.limit' });
  await sleep(5);
  ws.reply('market_request', 'market_response', { created: { listing: { id: 2 } } });

  assert.equal(await promessa, 1, 'um anunciado de dois tentados');
  const log = mgr.getAutosellLog();
  assert.ok(log.some(l => l.action === 'fail' && l.error === 'market.limit'));
  assert.ok(log.some(l => l.action === 'list'));
  mgr.stopAll();
});

test('item que não destranca não é anunciado', async () => {
  // `create` em item trancado é recusado pelo servidor. Mandar de todo jeito
  // trocaria uma linha clara do relatório por um código de erro do jogo.
  const { mgr, ws } = await comAutosell({});
  mgr.marketDb = bancoCom([1000, 1000]);

  const promessa = mgr.runAutosell(0);
  await sleep(5);
  ws.reply('mail_request', 'mail_response', { page: { entries: [] } });
  await sleep(5);
  ws.reply('market_request', 'market_response', { mine: { listings: [], active: 0, limit: 10 } });
  await sleep(5);
  ws.reply('inventory_page', 'inventory_page', {
    items: [inst('1', 'citrino', { locked: true })], has_next: false
  });
  await sleep(5);
  ws.reply('market_request', 'market_response', { page: { listings: [rival(500, 900)] } });
  await sleep(5);
  ws.reply('lock_item', 'error', { code: 'inv.locked' });

  assert.equal(await promessa, 0);
  assert.equal(ws.markets().some(m => m.create), false);
  assert.ok(mgr.getAutosellLog().some(l => l.action === 'fail' && l.error === 'inv.lockFailed'));
  mgr.stopAll();
});

test('conta desconectada é pulada sem tráfego', async () => {
  const { mgr } = await comAutosell({});
  mgr.getClient(0).status = 'disconnected';
  assert.equal(await mgr.runAutosell(0), 0);
  mgr.stopAll();
});

// -------------------------------------------------------------------- laço

test('o laço pula a conta excluída e a conta dedicada do sniper', async () => {
  // O índice -1 é a sessão do sniper: ela não tem inventário para vender.
  const { mgr } = await comAutosell({ excluded: [0] });
  const visitadas = [];
  mgr.runAutosell = async index => { visitadas.push(index); return 0; };
  mgr.clients.set(-1, { status: 'connected', disconnect() {} });

  await mgr.pollAutosell();
  assert.deepEqual(visitadas, []);
  mgr.stopAll();
});

test('duas rodadas não correm juntas', async () => {
  // Elas leriam a mesma bolsa e anunciariam o mesmo item duas vezes.
  const { mgr } = await comAutosell({});
  let entradas = 0;
  mgr.runAutosell = async () => {
    entradas++;
    await sleep(20);
    return 0;
  };
  const a = mgr.pollAutosell();
  const b = mgr.pollAutosell();
  await Promise.all([a, b]);
  assert.equal(entradas, 1, 'a segunda desiste em vez de duplicar o anúncio');
  mgr.stopAll();
});

test('o laço desligado não roda, e o temporizador não prende o processo', async () => {
  const { mgr } = await comAutosell({});
  mgr.setAutosellConfig({ enabled: false });
  assert.equal(mgr.startAutosellPoll(), false);
  assert.equal(await mgr.pollAutosell(), 0);

  mgr.setAutosellConfig({ enabled: true, intervalMs: 60000 });
  assert.equal(mgr.startAutosellPoll(), true);
  assert(mgr.autosellTicker, 'o ticker deve existir depois de ligar');
  assert.equal(mgr.startAutosellPoll(), false, 'ligar duas vezes não cria dois temporizadores');
  assert.equal(mgr.stopAutosellPoll(), true);
  mgr.stopAll();
});

test('mudar o intervalo com o laço em curso recria o temporizador', async () => {
  // O `every` antigo continuaria no ritmo velho; é recriado.
  const { mgr } = await comAutosell({ intervalMs: 60000 });
  mgr.startAutosellPoll();
  const antes = mgr.autosellTicker;
  mgr.setAutosellConfig({ enabled: true, intervalMs: 300000 });
  assert.notEqual(mgr.autosellTicker, antes, 'o ticker foi recriado');
  assert(mgr.autosellTicker, 'ticker continua ligado');
  mgr.stopAutosellPoll();
  mgr.stopAll();
});

// --------------------------------------------------------------- relatório

test('a configuração e o relatório são entregues a quem grava em disco', async () => {
  const configs = [];
  const logs = [];
  const { mgr } = await comAutosell({}, {
    autosellSink: cfg => configs.push(cfg),
    autosellLogSink: entries => logs.push(entries.length)
  });

  mgr.setAutosellConfig({ enabled: true, maxPerRound: 3 });
  assert.equal(configs[0].maxPerRound, 3);

  mgr.autosellLogEntry({ account: 0, action: 'list' });
  mgr.autosellLogEntry({ account: 0, action: 'list' });
  mgr.clearAutosellLog();
  assert.deepEqual(logs, [1, 2, 0], 'limpar também grava, senão o arquivo ressuscitaria');
  mgr.stopAll();
});

test('uma falha ao gravar não derruba o relatório', async () => {
  // A linha é o que o usuário vê; o arquivo é conveniência. Uma exceção aqui
  // subiria pelo meio da rodada, depois do anúncio já ter saído.
  const { mgr } = await comAutosell({}, { autosellLogSink: () => { throw new Error('disco cheio'); } });
  assert.doesNotThrow(() => mgr.autosellLogEntry({ account: 0, action: 'list' }));
  assert.equal(mgr.getAutosellLog().length, 1);
  mgr.stopAll();
});

test('o relatório gravado volta, com o teto', async () => {
  const { mgr } = await comAutosell({});
  mgr.setAutosellLog(Array.from({ length: 400 }, (_, i) => ({ action: 'list', uid: String(i) })));
  assert.equal(mgr.getAutosellLog().length, 300);
  assert.equal(mgr.setAutosellLog('nada disso'), 0);
  mgr.stopAll();
});

test('cada linha do relatório é avisada por evento', async () => {
  // É o que faz a janela mostrar o anúncio no instante em que ele sai, em vez
  // de só na próxima abertura.
  const { mgr } = await comAutosell({});
  const vistos = [];
  mgr.on('autosell', payload => vistos.push(payload));
  mgr.autosellLogEntry({ account: 0, action: 'list', uid: '1' });
  assert.equal(vistos.length, 1);
  assert.equal(vistos[0].entry.uid, '1');
  assert.ok(vistos[0].entry.atMs > 0, 'o horário entra na linha');
  assert.equal(vistos[0].stats.enabled, true);
  mgr.stopAll();
});
