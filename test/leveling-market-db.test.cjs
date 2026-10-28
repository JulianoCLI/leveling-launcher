const { test } = require('node:test');
const assert = require('node:assert/strict');

const { MarketDatabase, normalizeSale } = require('../src/domain/leveling-market-db');

/**
 * O banco existe porque o servidor esquece: `market_request{history}` devolve
 * 100 vendas cobrindo cerca de meia hora, e o que sai dessa janela não volta.
 * O launcher relê o mesmo feed de minuto em minuto, então a sobreposição é
 * deliberada e o banco tem de absorvê-la sem duplicar nada.
 *
 * Os valores abaixo imitam o formato real do protobuf, que entrega inteiros de
 * 64 bits como **string** — tratar isso é metade do trabalho de `normalizeSale`.
 */

const DIA = 86400000;

/** Uma `MarketSale` como o servidor manda: tudo em string. */
const venda = (id, defId, preco, qtd, quando, extra = {}) => ({
  id: String(id),
  listing_id: String(id * 7),
  kind: 'MARKET_KIND_ITEM',
  def_id: defId,
  name: extra.name || defId,
  category: extra.category || 'armas',
  rarity: extra.rarity || 'raro',
  enchant: extra.enchant || 0,
  currency: extra.currency || 'MARKET_CURRENCY_GOLD',
  quantity: String(qtd),
  unit_price: String(preco),
  total: String(preco * qtd),
  fee: String(Math.round(preco * qtd * 0.1)),
  net: String(preco * qtd - Math.round(preco * qtd * 0.1)),
  sold_at_ms: String(quando),
  seller_name: extra.seller || '',
  buyer_name: extra.buyer || ''
});

const abrir = () => {
  const db = new MarketDatabase(':memory:');
  assert.ok(db.open(), `banco não abriu: ${db.error}`);
  return db;
};

// ------------------------------------------------------------- normalização

test('converte os inteiros de 64 bits que chegam como string', () => {
  const linha = normalizeSale(venda(10, 'arco', 1300000, 3, 1700000000000));
  assert.equal(linha.id, 10);
  assert.equal(linha.unit_price, 1300000);
  assert.equal(linha.quantity, 3);
  assert.equal(linha.sold_at_ms, 1700000000000);
  assert.equal(typeof linha.id, 'number');
});

test('venda sem id não vira linha', () => {
  assert.equal(normalizeSale({ def_id: 'arco' }), null);
  assert.equal(normalizeSale(null), null);
  assert.equal(normalizeSale({ id: '0', def_id: 'arco' }), null);
});

test('sem def_id o nome serve de chave, e sem os dois a linha é descartada', () => {
  assert.equal(normalizeSale({ id: '1', name: 'Arco' }).def_id, 'Arco');
  assert.equal(normalizeSale({ id: '1' }), null);
});

test('quantidade ausente conta como uma unidade', () => {
  assert.equal(normalizeSale({ id: '1', def_id: 'x' }).quantity, 1);
});

// ------------------------------------------------------------- deduplicação

test('reler o mesmo feed não duplica nada', () => {
  const db = abrir();
  const feed = [venda(1, 'arco', 100, 1, 1), venda(2, 'arco', 200, 1, 2)];

  assert.equal(db.insertSales(feed), 2);
  assert.equal(db.insertSales(feed), 0, 'a segunda leitura do mesmo feed não acrescenta');
  assert.equal(db.insertSales(feed), 0);
  assert.equal(db.stats().vendas, 2);
});

test('o feed que anda guarda só a parte nova', () => {
  const db = abrir();
  db.insertSales([venda(1, 'arco', 100, 1, 1), venda(2, 'arco', 200, 1, 2)]);
  // Um minuto depois: duas linhas antigas ainda no feed, uma nova.
  const novas = db.insertSales([venda(2, 'arco', 200, 1, 2), venda(3, 'arco', 300, 1, 3)]);
  assert.equal(novas, 1);
  assert.equal(db.stats().vendas, 3);
});

test('lote vazio ou inválido não quebra nem conta', () => {
  const db = abrir();
  assert.equal(db.insertSales([]), 0);
  assert.equal(db.insertSales(null), 0);
  assert.equal(db.insertSales([null, {}, { id: '0' }]), 0);
});

// --------------------------------------------------------------- agregação

test('a média é ponderada pela quantidade, não pelo número de linhas', () => {
  const db = abrir();
  const agora = Date.now();
  // Uma venda de 1 unidade a 100 e uma de 9 unidades a 200. A média simples
  // seria 150; a ponderada é 190, que é o que o mercado realmente pagou.
  db.insertSales([
    venda(1, 'arco', 100, 1, agora),
    venda(2, 'arco', 200, 9, agora)
  ]);
  const item = db.summary({ days: 30 }).items[0];
  assert.equal(Math.round(item.media), 190);
});

test('a mediana resiste a uma venda absurda que destrói a média', () => {
  const db = abrir();
  const agora = Date.now();
  db.insertSales([
    venda(1, 'arco', 100, 1, agora),
    venda(2, 'arco', 110, 1, agora),
    venda(3, 'arco', 120, 1, agora),
    venda(4, 'arco', 9000000, 1, agora)
  ]);
  const item = db.summary({ days: 30 }).items[0];
  assert.equal(item.mediana, 115, 'média dos dois do meio, com número par de vendas');
  assert.ok(item.media > 2000000, 'a média é arrastada pelo extremo — é por isso que as duas aparecem');
});

test('com número ímpar de vendas a mediana é o valor do meio', () => {
  const db = abrir();
  const agora = Date.now();
  db.insertSales([
    venda(1, 'arco', 10, 1, agora),
    venda(2, 'arco', 50, 1, agora),
    venda(3, 'arco', 900, 1, agora)
  ]);
  assert.equal(db.summary({ days: 30 }).items[0].mediana, 50);
});

test('o último preço é o da venda mais recente, não o maior', () => {
  const db = abrir();
  const agora = Date.now();
  db.insertSales([
    venda(1, 'arco', 900000, 1, agora - 2 * DIA),
    venda(2, 'arco', 1000, 1, agora - 60000)
  ]);
  const item = db.summary({ days: 30 }).items[0];
  assert.equal(item.ultimo_preco, 1000);
  assert.equal(item.maximo, 900000);
});

test('mínimo, máximo, unidades e volume saem da mesma passada', () => {
  const db = abrir();
  const agora = Date.now();
  db.insertSales([
    venda(1, 'arco', 100, 2, agora),
    venda(2, 'arco', 300, 5, agora)
  ]);
  const item = db.summary({ days: 30 }).items[0];
  assert.equal(item.minimo, 100);
  assert.equal(item.maximo, 300);
  assert.equal(item.unidades, 7);
  assert.equal(item.volume, 100 * 2 + 300 * 5);
  assert.equal(item.vendas, 2);
});

// ------------------------------------------------------------------ filtros

test('o período recorta pelo momento da venda', () => {
  const db = abrir();
  const agora = Date.now();
  db.insertSales([
    venda(1, 'arco', 100, 1, agora - 40 * DIA),
    venda(2, 'arco', 200, 1, agora - 60000)
  ]);
  assert.equal(db.summary({ days: 7 }).items[0].vendas, 1);
  assert.equal(db.summary({ days: 90 }).items[0].vendas, 2);
  assert.equal(db.summary({ days: 0 }).items[0].vendas, 2, 'sem período é tudo');
});

test('o câmbio fica fora por padrão: o preço dele não é comparável', () => {
  const db = abrir();
  const agora = Date.now();
  // Medido no servidor: "Ouro" vende 2.800.000 unidades a 10 de preço
  // unitário. Misturar isso com o preço de um item envenena qualquer média.
  db.insertSales([
    venda(1, 'arco', 100, 1, agora),
    venda(2, 'cambio:diamante', 10, 2800000, agora)
  ]);
  assert.deepEqual(db.summary({ days: 30 }).items.map(i => i.def_id), ['arco']);
  assert.equal(db.summary({ days: 30, includeExchange: true }).items.length, 2);
});

test('a busca casa por nome e por def_id, sem diferenciar maiúsculas', () => {
  const db = abrir();
  const agora = Date.now();
  db.insertSales([
    venda(1, 'arco-arqueiro', 100, 1, agora, { name: 'Arco de Arqueiro' }),
    venda(2, 'espada-guerreiro', 100, 1, agora, { name: 'Espada de Guerreiro' })
  ]);
  assert.deepEqual(db.summary({ search: 'ARQUEIRO' }).items.map(i => i.def_id), ['arco-arqueiro']);
  assert.deepEqual(db.summary({ search: 'espada-' }).items.map(i => i.def_id), ['espada-guerreiro']);
  assert.equal(db.summary({ search: 'nada' }).items.length, 0);
});

test('a categoria filtra, e "todos" não filtra', () => {
  const db = abrir();
  const agora = Date.now();
  db.insertSales([
    venda(1, 'arco', 100, 1, agora, { category: 'armas' }),
    venda(2, 'elmo', 100, 1, agora, { category: 'armadura' })
  ]);
  assert.deepEqual(db.summary({ category: 'armadura' }).items.map(i => i.def_id), ['elmo']);
  assert.equal(db.summary({ category: 'todos' }).items.length, 2);
  assert.deepEqual(db.categories(), ['armadura', 'armas']);
});

test('cada ordenação devolve a ordem que promete', () => {
  const db = abrir();
  const agora = Date.now();
  db.insertSales([
    venda(1, 'barato', 10, 1, agora - DIA),
    venda(2, 'caro', 5000, 1, agora - 2 * DIA),
    venda(3, 'caro', 5000, 1, agora - 2 * DIA + 1),
    venda(4, 'recente', 100, 1, agora)
  ]);
  const ids = sort => db.summary({ sort }).items.map(i => i.def_id);
  assert.equal(ids('vendas')[0], 'caro', 'duas vendas contra uma');
  assert.equal(ids('recente')[0], 'recente');
  assert.equal(ids('preco-desc')[0], 'caro');
  assert.equal(ids('preco-asc')[0], 'barato');
  assert.deepEqual(ids('nome'), ['barato', 'caro', 'recente']);
});

test('o total conta itens distintos, não linhas da página', () => {
  const db = abrir();
  const agora = Date.now();
  for (let i = 1; i <= 12; i++) db.insertSales([venda(i, `item${i}`, 100, 1, agora)]);
  const res = db.summary({ limit: 5 });
  assert.equal(res.items.length, 5);
  assert.equal(res.total, 12);
  assert.equal(db.summary({ limit: 5, offset: 10 }).items.length, 2);
});

// ------------------------------------------------------------------ detalhe

test('o detalhe traz resumo, série diária e as vendas que a formaram', () => {
  const db = abrir();
  const agora = Date.now();
  db.insertSales([
    venda(1, 'arco', 100, 1, agora - 2 * DIA),
    venda(2, 'arco', 200, 1, agora - DIA),
    venda(3, 'arco', 300, 1, agora - DIA + 1000),
    venda(4, 'espada', 999, 1, agora)
  ]);
  const d = db.itemDetail('arco', { days: 30 });
  assert.equal(d.vendas, 3);
  assert.equal(d.mediana, 200);
  assert.equal(d.sales.length, 3, 'só as vendas deste item');
  assert.equal(d.series.length, 2, 'duas vendas no mesmo dia viram um ponto');
  assert.equal(d.series[1].vendas, 2);
  assert.equal(Math.round(d.series[1].media), 250);
});

test('a série vem em ordem crescente de data, para o gráfico ler da esquerda', () => {
  const db = abrir();
  const agora = Date.now();
  db.insertSales([
    venda(1, 'arco', 300, 1, agora),
    venda(2, 'arco', 100, 1, agora - 3 * DIA),
    venda(3, 'arco', 200, 1, agora - 2 * DIA)
  ]);
  const dias = db.itemDetail('arco', { days: 30 }).series.map(p => p.dia_ms);
  assert.deepEqual(dias, [...dias].sort((a, b) => a - b));
});

test('item sem venda no período não inventa detalhe', () => {
  const db = abrir();
  db.insertSales([venda(1, 'arco', 100, 1, Date.now() - 400 * DIA)]);
  assert.equal(db.itemDetail('arco', { days: 7 }), null);
  assert.equal(db.itemDetail('inexistente', { days: 30 }), null);
  assert.equal(db.itemDetail('', { days: 30 }), null);
});

// -------------------------------------------------------------------- saúde

test('o banco vazio responde sem quebrar', () => {
  const db = abrir();
  assert.deepEqual(db.summary({}).items, []);
  assert.deepEqual(db.recent({}), []);
  assert.deepEqual(db.categories(), []);
  assert.equal(db.stats().vendas, 0);
});

test('as estatísticas dizem desde quando o histórico existe', () => {
  const db = abrir();
  const agora = Date.now();
  db.insertSales([venda(1, 'arco', 100, 1, agora - 5 * DIA), venda(2, 'elmo', 100, 1, agora)]);
  const s = db.stats();
  assert.equal(s.ready, true);
  assert.equal(s.vendas, 2);
  assert.equal(s.itens, 2);
  assert.equal(s.desde_ms, agora - 5 * DIA);
  assert.equal(s.ate_ms, agora);
});

test('as vendas recentes vêm da mais nova para a mais velha', () => {
  const db = abrir();
  const agora = Date.now();
  db.insertSales([
    venda(1, 'a', 1, 1, agora - 3000),
    venda(2, 'b', 2, 1, agora - 1000),
    venda(3, 'c', 3, 1, agora - 2000)
  ]);
  assert.deepEqual(db.recent({ limit: 10 }).map(r => r.def_id), ['b', 'c', 'a']);
  assert.deepEqual(db.recent({ limit: 1 }).map(r => r.def_id), ['b']);
  assert.deepEqual(db.recent({ defId: 'a' }).map(r => r.def_id), ['a']);
});

// ------------------------------------------------------------- diamante

test('diamante e ouro são médias separadas, nunca somadas', () => {
  // São ordens de grandeza diferentes: milhares contra dezenas. A média das
  // duas juntas é um número que não corresponde a nenhuma venda real.
  const db = abrir();
  const agora = Date.now();
  db.insertSales([
    venda(1, 'arco', 50000, 1, agora - 1000),
    venda(2, 'arco', 70000, 1, agora - 2000),
    venda(3, 'arco', 80, 1, agora - 3000, { currency: "MARKET_CURRENCY_DIAMOND" }),
    venda(4, 'arco', 120, 1, agora - 4000, { currency: "MARKET_CURRENCY_DIAMOND" })
  ]);
  const i = db.summary({ days: 0 }).items[0];
  assert.equal(i.vendas, 4, 'o total de vendas conta as duas moedas');
  assert.equal(i.vendas_ouro, 2);
  assert.equal(i.vendas_dia, 2);
  assert.equal(i.media, 60000, 'a média de ouro ignora as vendas em diamante');
  assert.equal(i.media_dia, 100);
  assert.equal(i.minimo, 50000, 'o mínimo de ouro não pode ser um preço de diamante');
  assert.equal(i.maximo_dia, 120);
});

test('a mediana também é por moeda', () => {
  const db = abrir();
  const agora = Date.now();
  db.insertSales([
    venda(1, 'arco', 100, 1, agora - 1000),
    venda(2, 'arco', 200, 1, agora - 2000),
    venda(3, 'arco', 300, 1, agora - 3000),
    venda(4, 'arco', 10, 1, agora - 4000, { currency: "MARKET_CURRENCY_DIAMOND" }),
    venda(5, 'arco', 20, 1, agora - 5000, { currency: "MARKET_CURRENCY_DIAMOND" }),
    venda(6, 'arco', 60, 1, agora - 6000, { currency: "MARKET_CURRENCY_DIAMOND" })
  ]);
  const i = db.summary({ days: 0 }).items[0];
  assert.equal(i.mediana, 200, 'o preço do meio das vendas em ouro');
  assert.equal(i.mediana_dia, 20, 'e o do meio das vendas em diamante');
});

test('venda em ouro chega sem o campo currency e ainda conta como ouro', () => {
  // proto3 omite o valor zero, e `MARKET_CURRENCY_GOLD` é 1 — mas medido, o
  // campo costuma vir ausente. Tratar ouro como "é igual a GOLD" deixaria
  // quase todas as vendas reais fora da média.
  const db = abrir();
  db.insertSales([venda(1, 'arco', 500, 1, Date.now(), { currency: '' })]);
  const i = db.summary({ days: 0 }).items[0];
  assert.equal(i.vendas_ouro, 1);
  assert.equal(i.media, 500);
  assert.equal(i.vendas_dia, 0);
});

test('item nunca vendido em diamante não ganha preço em diamante', () => {
  // Zero diria que ele vale nada nessa moeda; o fato é que ninguém o vendeu.
  const db = abrir();
  db.insertSales([venda(1, 'arco', 500, 1, Date.now())]);
  const i = db.summary({ days: 0 }).items[0];
  assert.equal(i.vendas_dia, 0);
  assert.equal(i.mediana_dia, undefined, 'não é calculada quando não há venda');
  assert.equal(i.media_dia, null);
});

test('o detalhe separa as moedas e o gráfico usa só uma', () => {
  // Uma linha que alternasse entre as duas escalas pareceria um colapso de
  // preço que nunca aconteceu.
  const db = abrir();
  const agora = Date.now();
  db.insertSales([
    venda(1, 'arco', 1000, 1, agora - DIA),
    venda(2, 'arco', 50, 1, agora - 2 * DIA, { currency: "MARKET_CURRENCY_DIAMOND" })
  ]);
  const d = db.itemDetail('arco', { days: 30 });
  assert.equal(d.media, 1000);
  assert.equal(d.media_dia, 50);
  assert.equal(d.mediana_dia, 50);
  assert.equal(d.series_currency, 'gold');
  assert.equal(d.series.length, 1, 'só os dias com venda em ouro entram na série');
});

test('item só vendido em diamante tem o gráfico em diamante', () => {
  const db = abrir();
  db.insertSales([venda(1, 'gema', 40, 1, Date.now(), { currency: "MARKET_CURRENCY_DIAMOND" })]);
  const d = db.itemDetail('gema', { days: 30 });
  assert.equal(d.series_currency, 'diamond');
  assert.equal(d.series.length, 1, 'sem venda em ouro, o gráfico não pode ficar vazio');
  assert.equal(d.vendas_ouro, 0);
});
