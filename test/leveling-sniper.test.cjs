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
