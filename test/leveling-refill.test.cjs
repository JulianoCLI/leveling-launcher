const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ITEMS,
  defaultConfig,
  normalizeConfig,
  isConfigured,
  plan,
  readCatalog
} = require('../src/domain/leveling-refill');

/** Catálogo mínimo: preço de cada tier mais a oferta de essência. */
const catalog = {
  prices: {
    'CONSUMABLE_KIND_HP_POTION|POTION_TIER_PEQUENA': { price: 10, minLevel: 0 },
    'CONSUMABLE_KIND_HP_POTION|POTION_TIER_MEDIA': { price: 50, minLevel: 20 },
    'CONSUMABLE_KIND_HP_POTION|POTION_TIER_GRANDE': { price: 200, minLevel: 40 },
    'CONSUMABLE_KIND_MANA_POTION|POTION_TIER_PEQUENA': { price: 12, minLevel: 0 },
    'CONSUMABLE_KIND_REVIVE|POTION_TIER_PEQUENA': { price: 500, minLevel: 0 }
  },
  essence: { defId: 'essencia', price: 100, minLevel: 0, currency: 'CURRENCY_GOLD' }
};

/**
 * Preços já aprendidos do servidor. Medido contra ele, o preço do catálogo não
 * é o cobrado — a poção pequena de vida tem base 2 e custou 11 — então o plano
 * só compra lote quando conhece o preço real. Nos testes de quantidade esse
 * preço é fornecido igual ao do catálogo, para a aritmética ficar legível; o
 * comportamento de sondagem tem testes próprios.
 */
const learned = {};
for (const [key, def] of Object.entries(catalog.prices)) {
  const [kind, tier] = key.split('|');
  const k = { CONSUMABLE_KIND_HP_POTION: 'hp', CONSUMABLE_KIND_MANA_POTION: 'mana', CONSUMABLE_KIND_REVIVE: 'revive' }[kind];
  const t = tier.replace('POTION_TIER_', '').toLowerCase();
  learned[k + t[0].toUpperCase() + t.slice(1)] = def.price;
}
learned.essence = catalog.essence.price;

const config = patch => normalizeConfig({ enabled: true, ...patch });

const stock = over => ({
  hp: { pequena: 0, media: 0, grande: 0 },
  mana: { pequena: 0, media: 0, grande: 0 },
  revives: { pequena: 0, media: 0, grande: 0 },
  essence: 0,
  ...over
});

test('a configuração padrão não compra nada', () => {
  const cfg = defaultConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(isConfigured(cfg), false);

  const result = plan({ stock: stock(), config: cfg, gold: 1e9, level: 50, catalog, learned });
  assert.deepEqual(result.orders, []);
});

test('ligado mas sem nenhum mínimo continua sem comprar', () => {
  // Marcar a caixa mestre não deve esvaziar a conta por si só.
  assert.equal(isConfigured(config({})), false);
  assert.deepEqual(plan({ stock: stock(), config: config({}), gold: 1e6, level: 50, catalog, learned }).orders, []);
});

test('abaixo do mínimo compra até o alvo', () => {
  const result = plan({
    stock: stock({ hp: { pequena: 7, media: 0, grande: 0 } }),
    config: config({ items: { hpPequena: { min: 20, target: 100 } } }),
    gold: 1e6,
    level: 50,
    catalog,
    learned
  });

  assert.equal(result.orders.length, 1);
  // Enum pelo número: é o que `codec.encode` aceita; o nome é recusado pelo
  // `verify` do protobufjs.
  assert.deepEqual(result.orders[0].value, { kind: 1, tier: 1, qty: 93 });
  assert.equal(result.orders[0].caseName, 'buy_consumable');
  assert.equal(result.orders[0].cost, 930);
  assert.equal(result.spend, 930);
});

test('no mínimo ou acima dele não compra', () => {
  const rule = config({ items: { hpPequena: { min: 20, target: 100 } } });

  const igual = plan({ stock: stock({ hp: { pequena: 20 } }), config: rule, gold: 1e6, level: 50, catalog, learned });
  assert.deepEqual(igual.orders, [], 'no limite ainda não está abaixo dele');

  const acima = plan({ stock: stock({ hp: { pequena: 99 } }), config: rule, gold: 1e6, level: 50, catalog, learned });
  assert.deepEqual(acima.orders, []);
});

test('a reserva de ouro é intocável', () => {
  const result = plan({
    stock: stock(),
    config: config({ reserveGold: 5000, items: { hpPequena: { min: 10, target: 1000 } } }),
    gold: 5300,
    level: 50,
    catalog,
    learned
  });

  // Só 300 de ouro livre a 10 cada: trinta poções, nunca encostando na reserva.
  assert.equal(result.orders[0].qty, 30);
  assert.equal(result.spend, 300);
});

test('ouro insuficiente para uma única unidade registra o motivo', () => {
  const result = plan({
    stock: stock(),
    config: config({ items: { revivePequena: { min: 5, target: 5 } } }),
    gold: 499,
    level: 50,
    catalog,
    learned
  });

  assert.deepEqual(result.orders, []);
  assert.deepEqual(result.skipped, [{ key: 'revivePequena', reason: 'ouro', need: 2500 }]);
});

test('nível abaixo do exigido descarta o item sem gastar', () => {
  const result = plan({
    stock: stock(),
    config: config({
      items: {
        hpPequena: { min: 10, target: 10 },
        hpGrande: { min: 10, target: 10 }
      }
    }),
    gold: 1e6,
    level: 20,
    catalog,
    learned
  });

  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].key, 'hpPequena');
  assert.deepEqual(result.skipped, [{ key: 'hpGrande', reason: 'nivel', minLevel: 40 }]);
});

test('sem catálogo nada é comprado às cegas', () => {
  const result = plan({
    stock: stock(),
    config: config({ items: { hpPequena: { min: 10, target: 10 } } }),
    gold: 1e6,
    level: 50,
    catalog: null
  });

  assert.deepEqual(result.orders, []);
  assert.deepEqual(result.skipped, [{ key: 'hpPequena', reason: 'sem-preco' }]);
});

test('essência usa buy_essence e conta só a quantidade', () => {
  const result = plan({
    stock: stock({ essence: 3 }),
    config: config({ items: { essence: { min: 50, target: 200 } } }),
    gold: 1e6,
    level: 50,
    catalog,
    learned
  });

  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].caseName, 'buy_essence');
  assert.deepEqual(result.orders[0].value, { qty: 197 });
  assert.equal(result.orders[0].cost, 19700);
});

test('essência paga em diamante não consome o orçamento de ouro', () => {
  const premium = {
    ...catalog,
    essence: { defId: 'essencia', price: 5, minLevel: 0, currency: 'CURRENCY_DIAMONDS' }
  };
  const result = plan({
    stock: stock(),
    config: config({ reserveGold: 999999, items: { essence: { min: 10, target: 10 } } }),
    gold: 0,
    level: 50,
    catalog: premium,
    learned,
  });

  assert.equal(result.orders.length, 1, 'a reserva de ouro não governa compra em diamante');
  assert.equal(result.orders[0].cost, 0);
  assert.equal(result.spend, 0);
});

test('vários itens dividem um orçamento único, na ordem da lista', () => {
  const result = plan({
    stock: stock(),
    config: config({
      items: {
        hpPequena: { min: 100, target: 100 },  // 1000 de ouro
        manaPequena: { min: 100, target: 100 } // 1200 de ouro
      }
    }),
    gold: 1500,
    level: 50,
    catalog,
    learned
  });

  assert.equal(result.orders.length, 2);
  assert.equal(result.orders[0].qty, 100, 'o primeiro item é atendido por inteiro');
  assert.equal(result.orders[1].qty, 41, 'o segundo leva o que restou do orçamento');
  assert.ok(result.spend <= 1500);
});

test('alvo menor que o mínimo sobe para o mínimo', () => {
  // "Mantenha pelo menos 50" com alvo 10 é digitação ruim, não motivo para
  // ignorar o item.
  const cfg = config({ items: { hpPequena: { min: 50, target: 10 } } });
  assert.equal(cfg.items.hpPequena.target, 50);

  const result = plan({ stock: stock(), config: cfg, gold: 1e6, level: 50, catalog, learned });
  assert.equal(result.orders[0].qty, 50);
});

test('valores negativos ou inválidos não viram compra', () => {
  const cfg = normalizeConfig({
    enabled: true,
    reserveGold: -5,
    items: { hpPequena: { min: -10, target: 'abc' } }
  });
  assert.equal(cfg.reserveGold, 0);
  assert.deepEqual(cfg.items.hpPequena, { min: 0, target: 0 });
  assert.deepEqual(plan({ stock: stock(), config: cfg, gold: 1e6, level: 50, catalog, learned }).orders, []);
});

test('os itens cobrem as tiers de hp, mana e revive, os de sombra e a essência', () => {
  assert.equal(ITEMS.length, 12);
  const keys = ITEMS.map(i => i.key);
  assert.deepEqual(keys, [
    'hpPequena', 'hpMedia', 'hpGrande',
    'manaPequena', 'manaMedia', 'manaGrande',
    'revivePequena', 'reviveMedia', 'reviveGrande',
    'shadowPotion', 'shadowRevive',
    'essence'
  ]);

  // Sombras não têm tier: o pacote de compra sai sem o campo, e o estoque é um
  // contador em vez de um grupo de tiers.
  for (const key of ['shadowPotion', 'shadowRevive']) {
    const item = ITEMS.find(i => i.key === key);
    assert.equal(item.noTier, true);
    assert.equal(item.tierNum, 0);
  }
});

test('consumível de sombra compra pelo contador, sem tier no pacote', () => {
  const catalog = readCatalog({
    consumables: [
      // Sem `tier`: proto3 omite o zero, e é assim que o item de sombra chega.
      { kind: 'CONSUMABLE_KIND_SHADOW_POTION', price: 100, min_level: 10 }
    ]
  });
  assert.deepEqual(catalog.prices['CONSUMABLE_KIND_SHADOW_POTION|POTION_TIER_UNSPECIFIED'],
    { price: 100, minLevel: 10 });

  const config = { enabled: true, items: { shadowPotion: { min: 5, target: 10 } } };
  const { orders } = plan({
    stock: { shadowPotions: 2 },
    config,
    gold: 100000,
    level: 50,
    catalog,
    learned: { shadowPotion: 100 }
  });

  assert.equal(orders.length, 1);
  assert.equal(orders[0].caseName, 'buy_consumable');
  assert.deepEqual(orders[0].value, { kind: 4, qty: 8 });
  assert.equal('tier' in orders[0].value, false);
});

test('sombra sem ConsumableDef pega o preço da oferta da loja', () => {
  const catalog = readCatalog({
    consumables: [],
    shop: [
      {
        category: 'SHOP_CATEGORY_CONSUMABLE',
        consumable: 'CONSUMABLE_KIND_SHADOW_REVIVE',
        price: 600, qty: 3, min_level: 25
      }
    ]
  });
  // Preço por unidade, não por lote: é o que a reserva de ouro precisa orçar.
  assert.deepEqual(catalog.prices['CONSUMABLE_KIND_SHADOW_REVIVE|POTION_TIER_UNSPECIFIED'],
    { price: 200, minLevel: 25 });
});

test('readCatalog guarda só preço, nível, a oferta de essência e a cidade', () => {
  const extracted = readCatalog({
    version: '1.2.3',
    rules: { city_scene_id: 'cidade-seul', monster_curves: { hp: [1, 2, 3] } },
    // Mais de 1 MB de catálogo entra; nada além do necessário deve sair.
    monsters: Array.from({ length: 500 }, (_, i) => ({ id: 'm' + i })),
    consumables: [
      { kind: 'CONSUMABLE_KIND_HP_POTION', tier: 'POTION_TIER_MEDIA', price: 50, min_level: 20 },
      { kind: 'CONSUMABLE_KIND_UNSPECIFIED', tier: 'POTION_TIER_MEDIA', price: 1 }
    ],
    shop: [
      { category: 'SHOP_CATEGORY_CONSUMABLE', item_def_id: 'pocao', price: 10 },
      { category: 'SHOP_CATEGORY_ESSENCE', item_def_id: 'essencia-monstro', price: 500, qty: 5 }
    ]
  });

  assert.deepEqual(Object.keys(extracted), ['prices', 'essence', 'citySceneId']);
  // A cidade da loja vem das regras do servidor, não fixa no código: é o
  // destino do `travel` no ciclo de reposição.
  assert.equal(extracted.citySceneId, 'cidade-seul');
  assert.deepEqual(extracted.prices['CONSUMABLE_KIND_HP_POTION|POTION_TIER_MEDIA'], { price: 50, minLevel: 20 });
  assert.equal(Object.keys(extracted.prices).length, 1, 'entradas sem kind válido são ignoradas');
  assert.equal(extracted.essence.defId, 'essencia-monstro');
  assert.equal(extracted.essence.price, 100, 'o preço do lote vira preço unitário');
});

test('sem preço aprendido, compra uma unidade para descobrir o preço', () => {
  // O preço do catálogo erra por um fator de ~5, e o fator não é o mesmo entre
  // itens: medido no nível 46, poção de vida pequena (base 2) custou 11 e a de
  // mana (mesma base 2) custou 8. Orçar um lote por esse número estouraria a
  // reserva de ouro, então a primeira compra é de uma unidade só.
  const result = plan({
    stock: stock(),
    config: config({ items: { hpPequena: { min: 100, target: 100 } } }),
    gold: 1e6,
    level: 50,
    catalog
    // `learned` ausente de propósito.
  });

  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].qty, 1, 'uma unidade, para ler o gold_cost real');
  assert.equal(result.orders[0].probe, true);
  assert.equal(result.orders[0].want, 100, 'o que ainda falta fica registrado');
});

test('com o preço aprendido, o lote inteiro sai de uma vez', () => {
  const result = plan({
    stock: stock(),
    config: config({ items: { hpPequena: { min: 100, target: 100 } } }),
    gold: 1e6,
    level: 50,
    catalog,
    learned: { hpPequena: 11 }
  });

  assert.equal(result.orders[0].qty, 100);
  assert.equal(result.orders[0].probe, false);
  assert.equal(result.orders[0].cost, 1100, 'o preço aprendido substitui o do catálogo');
});

test('o preço aprendido governa a reserva de ouro, não o do catálogo', () => {
  // Com o preço do catálogo (10) caberiam 30 unidades nos 300 livres. O preço
  // real é 11, então cabem 27 — é essa a conta que não pode furar a reserva.
  const result = plan({
    stock: stock(),
    config: config({ reserveGold: 5000, items: { hpPequena: { min: 10, target: 1000 } } }),
    gold: 5300,
    level: 50,
    catalog,
    learned: { hpPequena: 11 }
  });

  assert.equal(result.orders[0].qty, 27);
  assert.ok(result.spend <= 300, 'a reserva continua intocada');
});

test('catálogo sem oferta de essência não inventa preço', () => {
  const extracted = readCatalog({ consumables: [], shop: [] });
  assert.equal(extracted.essence, null);

  const result = plan({
    stock: stock(),
    config: config({ items: { essence: { min: 10, target: 10 } } }),
    gold: 1e6,
    level: 50,
    catalog: extracted
  });
  assert.deepEqual(result.skipped, [{ key: 'essence', reason: 'sem-preco' }]);
});
