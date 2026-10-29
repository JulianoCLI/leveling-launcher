const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  defaultConfig,
  normalizeConfig,
  normalizeRule,
  isConfigured,
  remainingOf,
  currencyOf,
  searchesFor,
  matches,
  plan,
  isExchange,
  unitPriceOf,
  suggestCeiling,
  SNIPE_DISCOUNT,
  EXCHANGE_DEFS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_INTERVAL_MS
} = require('../src/domain/leveling-sniper');

/** Regra base: um item do catálogo, teto de ouro, alvo infinito. */
const rule = patch => normalizeRule({ defId: 'topazio', maxGold: 1000, ...patch });

/**
 * Anúncio como o servidor manda. `currency` fica de fora de propósito: proto3
 * omite o enum zero, então um anúncio em ouro chega sem o campo.
 */
const listing = patch => ({
  id: '501',
  def_id: 'topazio',
  name: 'Topázio',
  status: 'MARKET_STATUS_ACTIVE',
  unit_price: 900,
  quantity: 1,
  ...patch
});

// ------------------------------------------------------------- teto sugerido

test('o teto sugerido fica 20% abaixo da mediana', () => {
  // O sniper existe para pegar o que entra barato. Um teto *na* mediana
  // compraria metade do mercado — a metade de baixo é o preço normal, não
  // pechincha —, e a regra viraria uma torneira de ouro aberta.
  assert.equal(suggestCeiling(1000), 800);
  assert.equal(SNIPE_DISCOUNT, 0.2);
});

test('o teto arredonda para baixo', () => {
  // Um ouro a mais compra caro; um ouro a menos só deixa passar o anúncio
  // exatamente no limite. O erro barato é o de baixo.
  assert.equal(suggestCeiling(999), 799);
});

test('sem mediana não há teto: zero, e não um teto de zero', () => {
  // Zero é "não sei", e quem chama trata isso desligando o botão. Devolver 1
  // criaria uma regra que nunca compra e que o usuário acha que está armada.
  assert.equal(suggestCeiling(0), 0);
  assert.equal(suggestCeiling(null), 0);
});

test('mediana minúscula ainda produz um teto que existe', () => {
  // 20% de 1 arredondado para baixo é 0, e um teto de 0 seria uma regra
  // morta. O piso de 1 mantém a regra executável.
  assert.equal(suggestCeiling(1), 1);
});

test('um desconto fora de faixa cai no padrão', () => {
  // Desconto de 100% daria teto 0; negativo daria teto acima da mediana, que
  // é o oposto do que o botão promete.
  assert.equal(suggestCeiling(1000, 1), 800);
  assert.equal(suggestCeiling(1000, -1), 800);
  assert.equal(suggestCeiling(1000, 0.5), 500);
});

// ------------------------------------------------------------- configuração

test('a configuração padrão não compra nada', () => {
  const cfg = defaultConfig();
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.rules, []);
  assert.equal(isConfigured(cfg), false);
});

test('ligado mas sem regra nenhuma continua sem comprar', () => {
  assert.equal(isConfigured({ enabled: true, rules: [] }), false);
});

test('regra sem item é descartada: não há o que buscar', () => {
  assert.equal(normalizeRule({ maxGold: 100 }), null);
});

test('regra sem nenhum teto de preço é descartada: não há critério de compra', () => {
  assert.equal(normalizeRule({ defId: 'topazio' }), null);
  assert.equal(normalizeRule({ defId: 'topazio', maxGold: 0, maxDiamond: 0 }), null);
});

test('o intervalo é encaixado entre o piso e o teto', () => {
  assert.equal(normalizeConfig({ intervalMs: 10 }).intervalMs, MIN_INTERVAL_MS);
  assert.equal(normalizeConfig({ intervalMs: 999999 }).intervalMs, MAX_INTERVAL_MS);
  assert.equal(normalizeConfig({}).intervalMs, DEFAULT_INTERVAL_MS);
  assert.equal(normalizeConfig({ intervalMs: 'abc' }).intervalMs, DEFAULT_INTERVAL_MS);
});

test('duas regras para o mesmo item são fundidas, e a última vence', () => {
  const cfg = normalizeConfig({
    enabled: true,
    rules: [
      { defId: 'topazio', maxGold: 100 },
      { defId: 'topazio', maxGold: 500 }
    ]
  });
  assert.equal(cfg.rules.length, 1);
  assert.equal(cfg.rules[0].maxGold, 500);
});

test('nível máximo menor que o mínimo sobe para o mínimo', () => {
  const r = rule({ minLevel: 4, maxLevel: 1 });
  assert.equal(r.maxLevel, 4);
});

test('valores negativos ou inválidos não viram teto', () => {
  const r = normalizeRule({ defId: 'topazio', maxGold: -5, maxDiamond: 'abc' });
  assert.equal(r, null);
});

// ------------------------------------------------------------- alvo

test('alvo zero é infinito: compra sempre', () => {
  assert.equal(remainingOf(rule({ target: 0 })), Infinity);
  assert.equal(isConfigured({ enabled: true, rules: [{ defId: 'topazio', maxGold: 10 }] }), true);
});

test('alvo cumprido para de comprar', () => {
  const r = rule({ target: 5, bought: 5 });
  assert.equal(remainingOf(r), 0);
  assert.equal(matches(listing(), r).ok, false);
  assert.equal(matches(listing(), r).reason, 'target.done');
});

test('alvo cumprido em todas as regras desliga o laço', () => {
  const cfg = { enabled: true, rules: [{ defId: 'topazio', maxGold: 10, target: 2, bought: 2 }] };
  assert.equal(isConfigured(cfg), false);
});

// ------------------------------------------------------------- moeda

test('anúncio sem o campo currency é ouro, não diamante', () => {
  // proto3 omite o enum zero; tratar a ausência como diamante compararia o
  // preço contra o teto errado.
  assert.equal(currencyOf(listing()), 'gold');
  assert.equal(currencyOf(listing({ currency: 'MARKET_CURRENCY_GOLD' })), 'gold');
  assert.equal(currencyOf(listing({ currency: 'MARKET_CURRENCY_DIAMOND' })), 'diamond');
});

test('o teto é por moeda: diamante não é comprado com o teto de ouro', () => {
  const r = rule({ maxGold: 1000, maxDiamond: 0 });
  const v = matches(listing({ currency: 'MARKET_CURRENCY_DIAMOND', unit_price: 5 }), r);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'currency.off');
});

test('cada teto gera a sua busca, e nenhuma quando o teto é zero', () => {
  assert.equal(searchesFor(rule({ maxGold: 1000, maxDiamond: 0 })).length, 1);
  assert.equal(searchesFor(rule({ maxGold: 1000, maxDiamond: 20 })).length, 2);
});

test('a busca manda o teto de preço ao servidor, ordenado do mais barato', () => {
  const [busca] = searchesFor(rule({ maxGold: 1000 }));
  assert.equal(busca.priceMax, 1000);
  assert.equal(busca.currency, 'MARKET_CURRENCY_GOLD');
  assert.equal(busca.sort, 'preco-asc');
  assert.equal(busca.defId, 'topazio');
});

test('regra sem def_id busca por nome', () => {
  const [busca] = searchesFor(normalizeRule({ name: 'Topázio', maxGold: 10 }));
  assert.equal(busca.name, 'Topázio');
  assert.equal(busca.defId, undefined);
});

// ------------------------------------------------------------- câmbio
//
// Diamante não é um item: é `MARKET_KIND_EXCHANGE`, e o `content_catalog` não
// o lista. Dois problemas distintos saem daí — a regra não tinha como ser
// criada, e o preço unitário do servidor mente para lotes.

/** Pacote de câmbio como o servidor manda: 10 diamantes por 3.780.000 de ouro. */
const cambio = patch => ({
  id: '900',
  def_id: 'cambio:diamante',
  name: 'Diamante',
  kind: 'MARKET_KIND_EXCHANGE',
  status: 'MARKET_STATUS_ACTIVE',
  quantity: 10,
  // Medido: nos anúncios de câmbio o servidor repete o preço do lote aqui.
  unit_price: 3780000,
  total: 3780000,
  ...patch
});

test('o câmbio tem entrada própria: o catálogo do jogo não traz diamante', () => {
  assert.ok(EXCHANGE_DEFS['cambio:diamante'], 'Diamante precisa ser oferecível como regra');
  // A moeda é cruzada, e errar isso mandaria o teto para o campo errado.
  assert.equal(EXCHANGE_DEFS['cambio:diamante'].currency, 'gold');
  assert.equal(EXCHANGE_DEFS['cambio:gold'].currency, 'diamond');
});

test('o câmbio é reconhecido pelo kind e pelo def_id', () => {
  assert.equal(isExchange(cambio()), true);
  assert.equal(isExchange({ def_id: 'cambio:gold' }), true);
  assert.equal(isExchange(listing()), false);
});

test('em câmbio o unitário é o lote dividido, não o que o servidor manda', () => {
  // Sem isto um pacote de 10 pareceria custar 3,78 M por diamante, dez vezes
  // o preço real — e o sniper recusaria justamente a oferta mais barata.
  assert.equal(unitPriceOf(cambio()), 378000);
  // Lote de um não tem o que dividir: o número do servidor já é o unitário.
  assert.equal(unitPriceOf(cambio({ quantity: 1, unit_price: 380000, total: 380000 })), 380000);
  // Item comum não é tocado: ali o unitário do servidor é verdade.
  assert.equal(unitPriceOf(listing({ unit_price: 900, total: 900, quantity: 1 })), 900);
});

test('o pacote de câmbio é comprado quando o preço por unidade cabe no teto', () => {
  const r = normalizeRule({ defId: 'cambio:diamante', maxGold: 400000 });
  const v = matches(cambio(), r);
  assert.equal(v.ok, true, 'O teto é por diamante, e 378 k cabe em 400 k');
  assert.equal(v.unitPrice, 378000);
  // O total é o do lote inteiro: é o que sai da conta.
  assert.equal(v.total, 3780000);
});

test('pacote de câmbio caro é recusado pelo preço por unidade', () => {
  const r = normalizeRule({ defId: 'cambio:diamante', maxGold: 300000 });
  assert.equal(matches(cambio(), r).reason, 'price.high');
});

test('a busca de câmbio manda o kind e omite o teto de preço', () => {
  const [busca] = searchesFor(normalizeRule({ defId: 'cambio:diamante', maxGold: 400000 }));
  assert.equal(busca.kind, 'MARKET_KIND_EXCHANGE',
    'Sem o kind a busca por def_id não alcança o câmbio');
  // `price_max` compara contra o unit_price cru, que em câmbio é o do lote:
  // mandá-lo derrubaria todo pacote e deixaria só a unidade avulsa.
  assert.equal(busca.priceMax, undefined);
});

test('o plano de câmbio ordena pelo preço por unidade, não pelo do lote', () => {
  const r = normalizeRule({ defId: 'cambio:diamante', maxGold: 400000 });
  // O avulso custa menos no total e mais por diamante. Ordenar pelo lote
  // poria o pior negócio em primeiro lugar.
  const avulso = cambio({ id: '901', quantity: 1, unit_price: 395000, total: 395000 });
  const { buys } = plan([avulso, cambio()], r);
  assert.equal(buys[0].id, '900', 'O pacote sai mais barato por diamante');
  assert.equal(buys[0].unitPrice, 378000);
});

// ------------------------------------------------------------- casamento

test('preço acima do teto não é comprado', () => {
  const v = matches(listing({ unit_price: 1001 }), rule({ maxGold: 1000 }));
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'price.high');
});

test('preço igual ao teto é comprado: o teto é inclusivo', () => {
  assert.equal(matches(listing({ unit_price: 1000 }), rule({ maxGold: 1000 })).ok, true);
});

test('anúncio da própria conta não é comprado', () => {
  assert.equal(matches(listing({ mine: true }), rule()).reason, 'listing.mine');
});

test('anúncio só de oferta não é comprado: não tem preço de compra direta', () => {
  assert.equal(matches(listing({ offer_only: true }), rule()).reason, 'listing.offerOnly');
});

test('anúncio já fechado não é comprado', () => {
  assert.equal(matches(listing({ status: 'MARKET_STATUS_SOLD' }), rule()).reason, 'listing.closed');
});

test('regra pausada não casa com nada', () => {
  assert.equal(matches(listing(), rule({ enabled: false })).reason, 'rule.off');
});

test('item diferente não casa, mesmo dentro do teto', () => {
  assert.equal(matches(listing({ def_id: 'rubi' }), rule()).reason, 'item.other');
});

test('regra por nome casa por conteúdo, sem diferenciar maiúsculas', () => {
  const r = normalizeRule({ name: 'topázio', maxGold: 1000 });
  assert.equal(matches(listing({ def_id: 'outro', name: 'Topázio Bruto' }), r).ok, true);
  assert.equal(matches(listing({ def_id: 'outro', name: 'Rubi' }), r).reason, 'item.other');
});

test('a faixa de nível é respeitada', () => {
  const r = rule({ minLevel: 2, maxLevel: 3 });
  assert.equal(matches(listing({ level: 1 }), r).reason, 'level.low');
  assert.equal(matches(listing({ level: 4 }), r).reason, 'level.high');
  assert.equal(matches(listing({ level: 3 }), r).ok, true);
});

test('preço unitário ausente não é comprado às cegas', () => {
  assert.equal(matches(listing({ unit_price: 0 }), rule()).reason, 'price.unknown');
});

// ------------------------------------------------------------- plano

test('o lote é limitado ao que falta para o alvo', () => {
  const { buys } = plan([listing({ quantity: 10 })], rule({ target: 3 }));
  assert.equal(buys.length, 1);
  assert.equal(buys[0].quantity, 3);
  assert.equal(buys[0].total, 2700);
});

test('alvo infinito leva o lote inteiro', () => {
  const { buys } = plan([listing({ quantity: 10 })], rule({ target: 0 }));
  assert.equal(buys[0].quantity, 10);
});

test('o mais barato primeiro, e o alvo é descontado entre os anúncios da rodada', () => {
  const anuncios = [
    listing({ id: '1', unit_price: 900, quantity: 2 }),
    listing({ id: '2', unit_price: 100, quantity: 2 })
  ];
  const { buys } = plan(anuncios, rule({ target: 3 }));
  assert.equal(buys.length, 2);
  assert.equal(buys[0].id, '2');
  assert.equal(buys[0].quantity, 2);
  // O segundo só leva o que sobrou do alvo, não o lote inteiro: sem o
  // desconto, duas linhas da mesma rodada comprariam 4 para um alvo de 3.
  assert.equal(buys[1].quantity, 1);
});

test('o plano para quando o alvo se cumpre, sem olhar o resto', () => {
  const anuncios = [
    listing({ id: '1', unit_price: 100, quantity: 5 }),
    listing({ id: '2', unit_price: 200, quantity: 5 })
  ];
  const { buys } = plan(anuncios, rule({ target: 2 }));
  assert.equal(buys.length, 1);
  assert.equal(buys[0].quantity, 2);
});

test('o motivo da recusa fica registrado, para o log poder explicar', () => {
  const { buys, skipped } = plan([listing({ unit_price: 5000 })], rule({ maxGold: 1000 }));
  assert.equal(buys.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'price.high');
});

test('a regra recebida não é alterada pelo plano', () => {
  const r = rule({ target: 5 });
  plan([listing({ quantity: 5 })], r);
  // O contador só sobe quando o servidor confirma a compra.
  assert.equal(r.bought, 0);
});
