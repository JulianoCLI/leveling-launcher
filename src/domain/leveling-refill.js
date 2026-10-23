/**
 * @file leveling-refill.js
 * Planejador de reposição de consumíveis. Decide, não envia.
 *
 * Separado do serviço de propósito: a regra ("abaixo do mínimo, comprar até o
 * alvo, sem furar a reserva de ouro") é a parte que precisa de teste, e o
 * serviço é a parte que precisa de socket. Esta função é pura — recebe estoque,
 * configuração, ouro e catálogo, devolve a lista de pacotes a enviar.
 *
 * Os pacotes seguem `shop.proto`:
 *   poções e revives → `buy_consumable {kind, tier, qty}`
 *   essência         → `buy_essence {qty}`
 *
 * Nada aqui toca caçada ou automação: só repõe o que a automação do servidor
 * consome sozinha.
 */

'use strict';

/**
 * Cada enum aparece duas vezes de propósito: o nome é como o catálogo chega
 * (`codec.decode` usa `enums: String`) e o número é o que `codec.encode` aceita
 * ao montar a compra — `verify` recusa o nome.
 */
const TIERS = [
  { id: 'pequena', enum: 'POTION_TIER_PEQUENA', num: 1, label: 'pequena' },
  { id: 'media', enum: 'POTION_TIER_MEDIA', num: 2, label: 'média' },
  { id: 'grande', enum: 'POTION_TIER_GRANDE', num: 3, label: 'grande' }
];

const KINDS = [
  { id: 'hp', enum: 'CONSUMABLE_KIND_HP_POTION', num: 1, stock: 'hp', label: 'Poção de vida' },
  { id: 'mana', enum: 'CONSUMABLE_KIND_MANA_POTION', num: 2, stock: 'mana', label: 'Poção de mana' },
  { id: 'revive', enum: 'CONSUMABLE_KIND_REVIVE', num: 3, stock: 'revives', label: 'Reviver' }
];

/**
 * Itens configuráveis, na ordem em que o modal os mostra. `key` é o que fica
 * gravado em `prefs.json`, então mudar um nome aqui invalida a configuração do
 * usuário — vale manter.
 */
const ITEMS = [];
for (const kind of KINDS) {
  for (const tier of TIERS) {
    ITEMS.push({
      key: kind.id + tier.id[0].toUpperCase() + tier.id.slice(1),
      label: `${kind.label} ${tier.label}`,
      group: kind.id,
      stockKey: kind.stock,
      tierKey: tier.id,
      kindEnum: kind.enum,
      tierEnum: tier.enum,
      kindNum: kind.num,
      tierNum: tier.num
    });
  }
}
ITEMS.push({
  key: 'essence',
  label: 'Essência',
  group: 'essence',
  essence: true
});

/** Configuração vazia: tudo desligado, nada comprado por acidente. */
function defaultConfig() {
  const items = {};
  for (const item of ITEMS) items[item.key] = { min: 0, target: 0 };
  return { enabled: false, reserveGold: 0, items };
}

const int = (value, fallback = 0) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Normaliza o que vem do disco ou da interface. Um `min` acima do `target` não
 * é erro de digitação punível: significa "mantenha pelo menos isto", então o
 * alvo sobe para o mínimo em vez de o item ser descartado.
 */
function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const items = source.items && typeof source.items === 'object' ? source.items : {};
  const next = { enabled: !!source.enabled, reserveGold: int(source.reserveGold), items: {} };
  for (const item of ITEMS) {
    const entry = items[item.key] || {};
    const min = int(entry.min);
    next.items[item.key] = { min, target: Math.max(min, int(entry.target)) };
  }
  return next;
}

/** Algum item pedido? Sem isto o serviço nem precisa ler o catálogo. */
function isConfigured(config) {
  const cfg = normalizeConfig(config);
  if (!cfg.enabled) return false;
  return ITEMS.some(item => cfg.items[item.key].min > 0);
}

/** Estoque do item, lido do estado do cliente. */
function stockOf(item, stock) {
  const safe = stock || {};
  if (item.essence) return int(safe.essence);
  const group = safe[item.stockKey] || {};
  return int(group[item.tierKey]);
}

/**
 * Preço unitário e nível mínimo do item.
 *
 * O preço do catálogo **não é o preço cobrado**: medido contra o servidor, a
 * poção pequena de vida tem base 2 e custa 11 no nível 46, enquanto a de mana
 * tem a mesma base 2 e custa 8. O fator não sai de `consumable_price_per_level`
 * nem da fórmula do cliente web — o servidor forma o preço a partir do efeito
 * da poção, que depende dos atributos do personagem.
 *
 * Então o catálogo serve para duas coisas e nenhuma delas é orçar: dizer que o
 * item existe e dizer o `min_level`. O preço real vem de `learned`, preenchido
 * com o `gold_cost` que o servidor devolveu na última compra daquele item. Sem
 * preço aprendido o item é comprado **uma unidade por vez**, justamente para
 * aprendê-lo — a compra é linear na quantidade (5 unidades custaram 5×11).
 */
function priceOf(item, catalog, learned) {
  const safe = catalog || {};
  const known = learned && learned[item.key];
  const unit = known > 0 ? int(known) : 0;

  if (item.essence) {
    const essence = safe.essence;
    if (!essence || !(essence.price > 0)) return null;
    return {
      price: unit || int(essence.price),
      known: !!unit,
      minLevel: int(essence.minLevel),
      // Essência comprada com diamante não pode respeitar reserva de ouro.
      gold: essence.currency === undefined || essence.currency === 'CURRENCY_GOLD'
    };
  }
  const prices = safe.prices || {};
  const def = prices[`${item.kindEnum}|${item.tierEnum}`];
  if (!def || !(def.price > 0)) return null;
  return { price: unit || int(def.price), known: !!unit, minLevel: int(def.minLevel), gold: true };
}

/**
 * Monta a lista de compras.
 *
 * @param {object} input
 * @param {object} input.stock  `{hp:{pequena,media,grande}, mana:{…}, revives:{…}, essence}`
 * @param {object} input.config configuração normalizada ou crua
 * @param {number} input.gold   ouro disponível na conta
 * @param {number} input.level  nível do personagem, para `min_level`
 * @param {object} input.catalog `{prices:{'KIND|TIER':{price,minLevel}}, essence:{price,…}}`
 * @param {object} [input.learned] preço unitário real por `key`, aprendido das
 *   compras anteriores. Ausente, o item sai com `probe: true` e quantidade 1.
 * @returns {{orders:Array, spend:number, skipped:Array}}
 */
function plan({ stock, config, gold = 0, level = 0, catalog, learned } = {}) {
  const cfg = normalizeConfig(config);
  const orders = [];
  const skipped = [];
  if (!cfg.enabled) return { orders, spend: 0, skipped };

  // A reserva é intocável: o usuário a definiu para o jogo ter ouro para
  // encantar, consertar e evoluir sem o refill drenar a conta.
  let budget = Math.max(0, int(gold) - cfg.reserveGold);
  let spend = 0;

  for (const item of ITEMS) {
    const rule = cfg.items[item.key];
    if (!rule.min) continue;

    const have = stockOf(item, stock);
    if (have >= rule.min) continue;

    const want = Math.max(0, rule.target - have);
    if (!want) continue;

    const price = priceOf(item, catalog, learned);
    if (!price) {
      skipped.push({ key: item.key, reason: 'sem-preco' });
      continue;
    }
    if (price.minLevel && int(level) < price.minLevel) {
      skipped.push({ key: item.key, reason: 'nivel', minLevel: price.minLevel });
      continue;
    }

    // Sem preço aprendido, uma unidade só. O do catálogo é otimista por um
    // fator de ~5, então comprar o lote por ele estouraria a reserva de ouro.
    // Essa unidade devolve o `gold_cost` real e o resto vem no plano seguinte.
    let qty = price.known ? want : 1;

    // Sem ouro para o lote inteiro, compra o que cabe: meio refill ainda tira
    // a conta do zero, e esperar o preço baixar não é uma estratégia.
    if (price.gold) {
      qty = Math.min(qty, Math.floor(budget / price.price));
      if (qty <= 0) {
        skipped.push({ key: item.key, reason: 'ouro', need: want * price.price });
        continue;
      }
    }

    const cost = price.gold ? qty * price.price : 0;
    if (price.gold) budget -= cost;
    spend += cost;

    orders.push({
      key: item.key,
      label: item.label,
      qty,
      cost,
      // O que ainda falta depois deste pedido. Com o preço desconhecido isto é
      // quase tudo, e é o que diz ao serviço que vale replanejar no balcão.
      want,
      probe: !price.known,
      caseName: item.essence ? 'buy_essence' : 'buy_consumable',
      value: item.essence
        ? { qty }
        : { kind: item.kindNum, tier: item.tierNum, qty }
    });
  }

  return { orders, spend, skipped };
}

/**
 * Extrai do `ContentCatalog` só o que o planejador usa. O catálogo inteiro
 * passa de 1 MB por login; guardar o objeto todo por conta seria o maior custo
 * fixo do monitor.
 */
function readCatalog(value) {
  const safe = value || {};
  const prices = {};
  // O codec resolve enums por nome; o zero de proto3 chega como `UNSPECIFIED`,
  // que é verdadeiro e passaria por uma checagem de presença.
  const named = v => typeof v === 'string' && v && !v.endsWith('_UNSPECIFIED');
  for (const def of Array.isArray(safe.consumables) ? safe.consumables : []) {
    if (!def || !named(def.kind) || !named(def.tier)) continue;
    prices[`${def.kind}|${def.tier}`] = {
      price: int(def.price),
      minLevel: int(def.min_level)
    };
  }

  // Essência não tem campo de estoque nem de preço próprio no schema: ela é um
  // material comum, e o que a identifica é a oferta da loja na categoria dela.
  // O `item_def_id` dessa oferta é o que permite achar o saldo em
  // `InventorySummary.materials`, que vem por id e não por nome.
  let essence = null;
  for (const offer of Array.isArray(safe.shop) ? safe.shop : []) {
    if (!offer || offer.category !== 'SHOP_CATEGORY_ESSENCE') continue;
    // A oferta pode ser um lote; `buy_essence` conta unidades, então o preço
    // precisa ser por unidade para a reserva de ouro fechar.
    const lote = int(offer.qty, 1) || 1;
    essence = {
      defId: offer.item_def_id || '',
      price: Math.ceil(int(offer.price) / lote),
      minLevel: int(offer.min_level),
      currency: offer.currency || 'CURRENCY_GOLD'
    };
    break;
  }

  // A cidade onde a loja existe. Vem das regras do servidor em vez de ficar
  // fixa no código: é ela o destino do `travel` no ciclo de reposição.
  const citySceneId = (safe.rules && safe.rules.city_scene_id) || '';

  return { prices, essence, citySceneId };
}

module.exports = {
  ITEMS,
  TIERS,
  KINDS,
  defaultConfig,
  normalizeConfig,
  isConfigured,
  plan,
  readCatalog
};
