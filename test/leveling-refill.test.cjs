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
const { getCodec } = require('../src/domain/leveling-codec');
const { LevelingHeadlessClient } = require('../src/domain/leveling-headless-service');

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

// ------------------------------------------------ regressão do ciclo de compra
//
// O planejamento acima é puro; o que segue cobre a execução, que é onde o
// ciclo travava. Dois modos de travamento, medidos contra o servidor real:
// `shop.npcRequired` quando o personagem é tirado do balcão no meio das duas
// passagens de compra, e o HUD preso em "Comprando na cidade…" quando o leg de
// volta nunca responde e a limpeza do estado não roda.

const codec = getCodec();
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Socket de mentira que fala o mesmo protobuf binário do servidor real. */
class MockWebSocket {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    this.replied = new Set();
    MockWebSocket.last = this;
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

  /** Responde o primeiro request ainda pendente daquele case. */
  reply(clientCase, caseName, value) {
    const match = this.sent.find(m => m[clientCase] !== undefined && !this.replied.has(m.request_id));
    assert.ok(match, `nenhum request de ${clientCase} pendente de resposta`);
    this.replied.add(match.request_id);
    this.push(caseName, value, Number(match.request_id));
  }
}

const HUNT = { gate_id: 'castelo-demonios', tier_min: 36, difficulty: 'normal' };

const SHOP_NPC = {
  entity: 2,
  npc_id: 'comerciante',
  name: 'Brok, o Comerciante',
  pos: { x: 13330, y: 15500 },
  service: 2 // NPC_SERVICE_SHOP
};

const catalogPush = {
  version: 'test',
  consumables: [{ kind: 1, tier: 1, price: 10 }],
  shop: [],
  rules: { city_scene_id: 'cidade-seul' }
};

const refillOn = items => ({ enabled: true, reserveGold: 0, items });

const sentCount = (ws, caseName) => ws.sent.filter(m => m[caseName] !== undefined).length;

/** Espera o cliente enviar um pacote, sem prazo fixo no caso de teste. */
async function waitSent(ws, caseName, afterCount = 0) {
  for (let i = 0; i < 200; i++) {
    if (sentCount(ws, caseName) > afterCount) return ws.sent.filter(m => m[caseName] !== undefined).pop();
    await sleep(5);
  }
  return null;
}

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

/** Conecta, autentica, entrega o catálogo e põe a conta na caçada. */
async function bootRefill(client) {
  client.connect();
  await sleep(10);
  const ws = MockWebSocket.last;
  ws.reply('login', 'auth_ok', { token: 't', account_id: 1 });
  await sleep(5);
  ws.push('content_catalog', catalogPush);
  ws.push('scene_enter', {
    scene_id: 'castelo-demonios',
    kind: 2, // SCENE_KIND_HUNT
    your_entity: 7,
    hunt: HUNT
  });
  await sleep(5);
  return ws;
}

/** Faz o papel do servidor na viagem: travel → cena → move_to → chegada → interact. */
async function serveTripToShop(ws, { npc = SHOP_NPC, cityPush } = {}) {
  assert.ok(await waitSent(ws, 'travel'), 'o refill precisa viajar para comprar');
  ws.push('scene_enter', cityPush || {
    scene_id: 'cidade-seul',
    kind: 1, // SCENE_KIND_CITY
    your_entity: 7,
    npcs: npc ? [npc] : []
  });
  await sleep(5);

  const antes = sentCount(ws, 'move_to') - 1;
  assert.ok(await waitSent(ws, 'move_to', antes), 'sem andar o servidor ignora o interact');
  ws.push('world_snapshot', { entities: [{ id: 7, x: npc.pos.x, y: npc.pos.y }] });
  await sleep(5);

  const antesI = sentCount(ws, 'interact') - 1;
  assert.ok(await waitSent(ws, 'interact', antesI), 'a loja abre pelo interact no NPC');
  ws.push('npc_interaction', { entity: npc.entity, npc_id: npc.npc_id, service: 2 });
  await sleep(5);
}

test('a loja também é achada em SceneEnter.interactions', async () => {
  // Medido no proto: `SceneInteraction` traz o mesmo `service` do NPC. Em cenas
  // em que a loja só chega por ali, o ciclo morria em `refill.noShopNpc`.
  const client = makeClient({
    refillConfig: refillOn({ hpPequena: { min: 20, target: 21 } }),
    refillBackoffMs: 60000
  });
  const ws = await bootRefill(client);

  ws.push('character_state', {
    progress: { level: 40 },
    wallet: { gold: 100000 },
    consumables: { hp_potions: { pequena: 5 } }
  });

  await serveTripToShop(ws, {
    cityPush: {
      scene_id: 'cidade-seul',
      kind: 1,
      your_entity: 7,
      npcs: [],
      interactions: [{ entity: 2, interaction_id: 'loja', pos: SHOP_NPC.pos, radius: 100, service: 2 }]
    }
  });

  assert.deepEqual(client.sceneInteractions.length, 1, 'as interações da cena são lidas');
  assert.ok(await waitSent(ws, 'buy_consumable'), 'a loja das interações serve para comprar');
  client.disconnect();
});

test('scene_enter no meio da compra não colhe shop.npcRequired e limpa o estado', async () => {
  // Um puxão de grupo ou troca de canal invalida a cena e zera `trip.pos`.
  // Antes o ciclo seguia comprando às cegas e o servidor respondia
  // `shop.npcRequired`; agora ele reafirma o balcão antes de cada compra.
  const client = makeClient({
    refillConfig: refillOn({ hpPequena: { min: 20, target: 50 } }),
    refillBackoffMs: 60000
  });
  const ws = await bootRefill(client);

  const events = [];
  client.on('refill', e => events.push(e));

  ws.push('character_state', {
    progress: { level: 40 },
    wallet: { gold: 100000 },
    consumables: { hp_potions: { pequena: 5 } }
  });

  await serveTripToShop(ws);

  // Sonda: uma unidade, para aprender o preço real.
  assert.ok(await waitSent(ws, 'buy_consumable'));

  // O puxão chega antes da resposta da sonda: é exatamente o caso real, em que
  // o `scene_enter` de outra cena cai no meio das duas passagens de compra.
  ws.push('scene_enter', { scene_id: 'outra-cacada', kind: 2, your_entity: 7, hunt: HUNT });
  ws.reply('buy_consumable', 'buy_consumable_result', { qty: 1, gold_cost: 11, owned: 6 });
  await sleep(30);

  // Fora da cidade não há balcão para reencontrar: o ciclo desiste com nome
  // próprio em vez de insistir e colher o erro do servidor.
  assert.equal(sentCount(ws, 'buy_consumable'), 1, 'nenhuma compra sai fora do balcão');

  const volta = await waitSent(ws, 'start_hunt');
  assert.ok(volta, 'a conta volta à caçada mesmo assim');
  ws.reply('start_hunt', 'start_hunt_result', { ...HUNT, scene_id: 'castelo-demonios' });
  await sleep(5);
  ws.push('scene_enter', { scene_id: 'castelo-demonios', kind: 2, your_entity: 7, hunt: HUNT });
  await sleep(20);

  const erros = events.filter(e => !e.ok).map(e => e.error);
  assert.ok(!erros.includes('shop.npcRequired'), `não pode colher npcRequired: ${erros}`);
  assert.ok(erros.includes('refill.leftShop'), `erro nomeado esperado, veio ${erros}`);

  assert.equal(client.trip, null, 'a viagem encerrou');
  assert.equal(client.state.refillTrip, false, 'o HUD para de avisar a compra');
  assert.equal(client.refillBusy, false, 'e o próximo refill pode partir');
  client.disconnect();
});

test('falha no leg de volta ainda limpa refillBusy e refillTrip', async () => {
  // O pior travamento: o `start_hunt` da volta não responde, e sem prazo
  // próprio as linhas de limpeza nunca rodavam — o HUD ficava em "Comprando na
  // cidade…" para sempre, sem viagem nenhuma em curso.
  const client = makeClient({
    refillConfig: refillOn({ hpPequena: { min: 20, target: 21 } }),
    refillBackoffMs: 60000,
    requestTimeoutMs: 100
  });
  const ws = await bootRefill(client);

  const events = [];
  client.on('refill', e => events.push(e));

  ws.push('character_state', {
    progress: { level: 40 },
    wallet: { gold: 100000 },
    consumables: { hp_potions: { pequena: 5 } }
  });

  await serveTripToShop(ws);
  assert.ok(await waitSent(ws, 'buy_consumable'));
  ws.reply('buy_consumable', 'buy_consumable_result', { qty: 1, gold_cost: 11, owned: 21 });

  // O `start_hunt` da volta sai e fica sem resposta de propósito.
  assert.ok(await waitSent(ws, 'start_hunt'), 'a volta é tentada');
  for (let i = 0; i < 100 && client.refillBusy; i++) await sleep(10);

  assert.equal(client.refillBusy, false, 'o ciclo não pode ficar preso');
  assert.equal(client.state.refillTrip, false, 'nem o aviso de compra no HUD');
  assert.equal(client.trip, null);
  const erros = events.filter(e => !e.ok).map(e => e.error);
  assert.ok(erros.some(e => /volta falhou/.test(e)), `a falha da volta precisa aparecer: ${erros}`);
  client.disconnect();
});

test('rejeição dentro de runRefill não deixa o HUD preso na cidade', async () => {
  // Sem o `.catch()` em `maybeRefill` a rejeição era engolida pelo runtime e
  // `refillTrip` ficava ligado para sempre.
  const client = makeClient({ refillConfig: refillOn({ hpPequena: { min: 20, target: 50 } }) });
  const ws = await bootRefill(client);

  const events = [];
  client.on('refill', e => events.push(e));

  // Rejeita antes de qualquer `try` interno: é a rejeição que ninguém tratava.
  client.runRefill = async () => { throw new Error('plano explodiu'); };
  client.state.refillTrip = true;
  client.trip = { pos: null, startedAt: Date.now() };

  // Estoque abaixo do mínimo: é o que faz o refill partir.
  ws.push('character_state', {
    progress: { level: 40 },
    wallet: { gold: 100000 },
    consumables: { hp_potions: { pequena: 5 } }
  });
  await sleep(30);

  assert.equal(client.refillBusy, false);
  assert.equal(client.state.refillTrip, false, 'o estado de viagem é zerado defensivamente');
  assert.equal(client.trip, null);
  assert.ok(events.some(e => !e.ok && /plano explodiu/.test(e.error)), 'o erro precisa aparecer');
  assert.equal(sentCount(ws, 'travel'), 0);
  client.disconnect();
});

test('NPC_REACH tem margem sobre o limite medido de 700', async () => {
  const { NPC_REACH } = require('../src/domain/leveling-headless-service');
  assert.ok(NPC_REACH < 700, '700 cru não deixa margem para uma snapshot atrasada');
  assert.ok(NPC_REACH >= 500, 'margem exagerada obrigaria a andar sem necessidade');
});
