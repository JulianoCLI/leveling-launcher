/**
 * @file leveling-sniper.js
 * Regras do sniper de mercado. Decide, não compra.
 *
 * Mesma separação do `leveling-refill.js`, e pelo mesmo motivo: a parte que
 * precisa de teste é a regra ("este anúncio está abaixo do meu teto e ainda
 * falta quantidade para o alvo?"), e a parte que precisa de socket é o
 * serviço. Aqui não há rede, nem tempo, nem estado global.
 *
 * O que uma regra diz:
 *   - qual item (`defId` do catálogo, ou `name` quando o usuário digitou sem
 *     escolher da lista);
 *   - teto de **preço unitário**, um por moeda: `maxGold` e `maxDiamond`.
 *     Zero desliga aquela moeda — um teto de zero significaria "compre de
 *     graça", que não é um pedido possível;
 *   - `target`: quantas unidades comprar ao todo. **Zero é infinito**, o que
 *     o usuário pediu explicitamente: "vai comprar sempre";
 *   - `account`: qual conta paga. Por regra, não global: a conta que tem ouro
 *     para material barato não é a que o usuário quer gastando em equipamento;
 *   - `bought`: quanto já foi comprado. Fica gravado junto da regra de
 *     propósito — se o contador vivesse só em memória, reabrir o launcher
 *     zeraria o alvo e a compra aconteceria de novo.
 */

'use strict';

/** Mínimo e máximo do intervalo de verificação, em milissegundos. */
const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 60000;
const DEFAULT_INTERVAL_MS = 5000;

/** Teto de regras. Cada regra é uma busca por tique; a lista é o tráfego. */
const MAX_RULES = 30;

const int = (value, fallback = 0) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const str = v => (typeof v === 'string' ? v.trim() : '');

/**
 * Câmbio: os dois anúncios que o mercado tem e que o catálogo do jogo não.
 *
 * `content_catalog` lista 180 itens e nenhum deles é diamante — câmbio é
 * `MARKET_KIND_EXCHANGE`, uma oferta de moeda por moeda, não um `ItemDef`.
 * Por isso digitar "diamante" no sniper não sugeria nada: não havia o que
 * sugerir. As duas entradas são fixas porque o servidor não as publica em
 * lugar nenhum; os `def_id` são os que o feed de vendas usa, medidos.
 *
 * A moeda é a do anúncio, e é cruzada: quem vende diamante cobra ouro.
 */
const EXCHANGE_DEFS = {
  'cambio:diamante': { name: 'Diamante (câmbio)', currency: 'gold' },
  'cambio:gold': { name: 'Ouro (câmbio)', currency: 'diamond' }
};

/** O anúncio é câmbio? Vale pelo `kind` do servidor e pelo `def_id`. */
function isExchange(target) {
  const t = target || {};
  if (String(t.kind || '').endsWith('_EXCHANGE')) return true;
  return String(t.def_id || t.defId || '').startsWith('cambio:');
}

/**
 * Preço por unidade de um anúncio.
 *
 * Em `MARKET_KIND_EXCHANGE` o `unit_price` do servidor é o preço do **lote**:
 * medido, um pacote de 10 diamantes por 3.780.000 chega com `unit_price` e
 * `total` ambos em 3.780.000. Comparar isso contra um teto por diamante faria
 * o sniper recusar todo pacote e só comprar unidade avulsa — justamente a
 * forma mais cara.
 */
function unitPriceOf(listing) {
  const l = listing || {};
  const unit = int(l.unit_price);
  if (!isExchange(l)) return unit;
  const total = int(l.total);
  const qty = int(l.quantity);
  if (total <= 0 || qty <= 1) return unit;
  return Math.max(1, Math.round(total / qty));
}

/**
 * Moeda do anúncio, normalizada.
 *
 * proto3 omite o enum zero, então um anúncio em ouro chega **sem** o campo
 * `currency` — é o mesmo cuidado que o banco de vendas já toma. Tratar a
 * ausência como diamante faria o sniper comparar o preço contra o teto errado.
 */
function currencyOf(listing) {
  const raw = String((listing && listing.currency) || '');
  if (raw.includes('DIAMOND')) return 'diamond';
  if (raw.includes('TOKEN')) return 'token';
  return 'gold';
}

/** Configuração vazia: desligada, sem regra nenhuma. */
function defaultConfig() {
  return { enabled: false, intervalMs: DEFAULT_INTERVAL_MS, rules: [] };
}

/**
 * Chave estável de uma regra.
 *
 * Serve para o contador de comprados sobreviver a uma reordenação da lista na
 * tela: o índice não serve, porque apagar a primeira regra deslocaria o
 * contador de todas as outras.
 */
function ruleId(rule) {
  const id = str(rule && rule.id);
  if (id) return id;
  const alvo = str(rule && rule.defId) || str(rule && rule.name).toLowerCase();
  return `r:${alvo}`;
}

/**
 * Normaliza uma regra vinda do disco ou da interface.
 *
 * Devolve `null` para o que não dá para executar — sem item não há busca, e
 * sem nenhum teto de preço não há critério de compra. Descartar é melhor que
 * guardar uma regra que nunca dispara e que o usuário acha que está ligada.
 */
function normalizeRule(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const defId = str(source.defId);
  const name = str(source.name);
  if (!defId && !name) return null;

  const maxGold = int(source.maxGold);
  const maxDiamond = int(source.maxDiamond);
  if (!maxGold && !maxDiamond) return null;

  const minLevel = int(source.minLevel);
  const rule = {
    id: ruleId(source),
    defId,
    name,
    maxGold,
    maxDiamond,
    minLevel,
    // Um máximo menor que o mínimo é erro de digitação, não pedido: o teto
    // sobe para o piso em vez de a regra nunca casar com nada.
    maxLevel: (() => {
      const max = int(source.maxLevel);
      return max && max < minLevel ? minLevel : max;
    })(),
    /** Zero é infinito. */
    target: int(source.target),
    bought: int(source.bought),
    account: int(source.account),
    enabled: source.enabled === undefined ? true : !!source.enabled
  };
  return rule;
}

/**
 * Normaliza a configuração inteira.
 *
 * Regras repetidas no mesmo item são fundidas pela chave: duas linhas para o
 * mesmo item com tetos diferentes só dobrariam o tráfego de busca, e qual das
 * duas vence seria imprevisível.
 */
function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const lista = Array.isArray(source.rules) ? source.rules : [];

  const porChave = new Map();
  for (const bruta of lista) {
    const rule = normalizeRule(bruta);
    if (!rule) continue;
    porChave.set(rule.id, rule);
    if (porChave.size >= MAX_RULES) break;
  }

  return {
    enabled: !!source.enabled,
    intervalMs: Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS,
      int(source.intervalMs, DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS)),
    rules: [...porChave.values()]
  };
}

/** Vale ligar o loop? Sem regra ativa ele só geraria tráfego. */
function isConfigured(config) {
  const cfg = normalizeConfig(config);
  return cfg.enabled && cfg.rules.some(r => r.enabled && remainingOf(r) !== 0);
}

/**
 * Quantas unidades ainda faltam para o alvo. `Infinity` quando o alvo é zero,
 * que é como o usuário pede "sempre".
 */
function remainingOf(rule) {
  const target = int(rule && rule.target);
  if (!target) return Infinity;
  return Math.max(0, target - int(rule && rule.bought));
}

/** Teto de preço unitário da regra para a moeda do anúncio. */
function ceilingFor(rule, currency) {
  if (currency === 'gold') return int(rule && rule.maxGold);
  if (currency === 'diamond') return int(rule && rule.maxDiamond);
  // Token não tem campo próprio: nenhuma tela do launcher o oferece, e
  // adivinhar um teto para ele seria gastar uma moeda que ninguém configurou.
  return 0;
}

/**
 * Filtros de busca da regra.
 *
 * `price_max` é mandado ao servidor em vez de filtrado aqui: a busca volta
 * ordenada por preço e já sem o que não interessa, e isso é a diferença entre
 * ler uma página e paginar o mercado inteiro atrás de uma pechincha. O filtro
 * local continua existindo — `matches` não confia na resposta.
 *
 * Uma moeda por busca, porque `MarketSearch.currency` é um campo só. Quando a
 * regra tem os dois tetos, saem duas buscas.
 */
function searchesFor(rule) {
  const base = {};
  if (rule.defId) base.defId = rule.defId;
  else base.name = rule.name;
  if (rule.minLevel) base.levelMin = rule.minLevel;
  if (rule.maxLevel) base.levelMax = rule.maxLevel;
  // Mais barato primeiro: a primeira linha da resposta é a que interessa, e
  // se ela já está acima do teto nenhuma das outras está abaixo.
  base.sort = 'preco-asc';
  base.page = 1;

  // Câmbio é um `kind` próprio, e sem ele a busca por `def_id` não alcança
  // nada: `cambio:diamante` não é um `ItemDef`, e o servidor separa os dois
  // conjuntos. `MARKET_KIND_ITEM` não é mandado no caso comum porque hoje a
  // regra pode mirar uma sombra, que também não é item.
  const cambio = isExchange(rule);
  if (cambio) base.kind = 'MARKET_KIND_EXCHANGE';

  const out = [];
  // `price_max` do servidor compara contra o `unit_price` cru — que em câmbio
  // é o preço do lote. Mandar o teto por diamante ali derrubaria todo pacote
  // e deixaria passar só a unidade avulsa. Em câmbio o corte fica com
  // `matches`, que divide pelo tamanho do lote antes de comparar.
  const teto = (max) => (cambio ? {} : { priceMax: max });
  if (rule.maxGold) {
    out.push({ ...base, currency: 'MARKET_CURRENCY_GOLD', ...teto(rule.maxGold) });
  }
  if (rule.maxDiamond) {
    out.push({ ...base, currency: 'MARKET_CURRENCY_DIAMOND', ...teto(rule.maxDiamond) });
  }
  return out;
}

/**
 * Este anúncio serve para esta regra?
 *
 * Devolve `{ok:false, reason}` em vez de um booleano porque o motivo é o que
 * o log precisa mostrar: "apareceu e eu não comprei" sem dizer por quê é a
 * informação inútil.
 */
function matches(listing, rule) {
  const l = listing || {};
  if (!rule || !rule.enabled) return { ok: false, reason: 'rule.off' };

  // Anúncio da própria conta: comprar de si mesmo é pagar a taxa de venda por
  // nada. O servidor recusa, mas o log ficaria cheio de erros.
  if (l.mine) return { ok: false, reason: 'listing.mine' };
  if (l.offer_only) return { ok: false, reason: 'listing.offerOnly' };

  const status = String(l.status || '');
  if (status && !status.endsWith('_ACTIVE') && !status.endsWith('_UNSPECIFIED')) {
    return { ok: false, reason: 'listing.closed' };
  }

  if (rule.defId) {
    if (String(l.def_id || '') !== rule.defId) return { ok: false, reason: 'item.other' };
  } else if (!String(l.name || '').toLowerCase().includes(rule.name.toLowerCase())) {
    return { ok: false, reason: 'item.other' };
  }

  const level = int(l.level);
  if (rule.minLevel && level < rule.minLevel) return { ok: false, reason: 'level.low' };
  if (rule.maxLevel && level > rule.maxLevel) return { ok: false, reason: 'level.high' };

  const currency = currencyOf(l);
  const ceiling = ceilingFor(rule, currency);
  if (!ceiling) return { ok: false, reason: 'currency.off' };

  const unit = unitPriceOf(l);
  if (!unit) return { ok: false, reason: 'price.unknown' };
  if (unit > ceiling) return { ok: false, reason: 'price.high' };

  const restante = remainingOf(rule);
  if (restante <= 0) return { ok: false, reason: 'target.done' };

  // Lote maior que o que falta: compra-se só o pedaço. `MarketBuy.quantity`
  // aceita compra parcial — `MarketBought.remaining` é o que sobra no anúncio.
  const disponivel = Math.max(1, int(l.quantity, 1));
  const quantity = restante === Infinity ? disponivel : Math.min(disponivel, restante);

  return { ok: true, currency, unitPrice: unit, quantity, total: unit * quantity };
}

/**
 * Decide a lista de compras de uma rodada.
 *
 * Função pura: recebe os anúncios que a busca trouxe, devolve o que comprar e
 * em que ordem. O alvo é descontado aqui, enquanto a lista é montada, porque
 * duas linhas do mesmo item na mesma rodada não podem as duas pensar que o
 * alvo inteiro está livre.
 *
 * @param {object[]} listings Anúncios, já de uma regra só.
 * @param {object} rule Regra normalizada.
 * @returns {{buys: object[], skipped: object[]}}
 */
function plan(listings, rule) {
  const buys = [];
  const skipped = [];
  // Cópia: a regra de verdade só é alterada quando a compra confirma.
  const simulada = { ...rule };

  // Mais barato primeiro. A busca já devolve assim, mas a ordenação é do
  // servidor e aqui ela é o que decide quem leva a quantidade restante.
  const ordenados = [...(listings || [])].sort(
    (a, b) => unitPriceOf(a) - unitPriceOf(b)
  );

  for (const listing of ordenados) {
    const veredito = matches(listing, simulada);
    if (!veredito.ok) {
      skipped.push({ listing, reason: veredito.reason });
      continue;
    }
    buys.push({
      id: listing.id,
      quantity: veredito.quantity,
      unitPrice: veredito.unitPrice,
      total: veredito.total,
      currency: veredito.currency,
      listing,
      rule: simulada.id
    });
    simulada.bought = int(simulada.bought) + veredito.quantity;
    if (remainingOf(simulada) <= 0) break;
  }

  return { buys, skipped };
}

/**
 * Desconto do teto sugerido quando a regra nasce de um item do mercado.
 *
 * 20% abaixo da mediana. O sniper existe para pegar o que entra barato, e um
 * teto *na* mediana compraria metade do mercado — a metade de baixo é o preço
 * normal, não pechincha. Abaixo disso a compra só dispara quando alguém
 * anuncia errado ou com pressa, que é o caso que vale automatizar.
 *
 * O número é um ponto de partida visível e editável, não uma política: a
 * confirmação mostra o valor antes de gravar a regra.
 */
const SNIPE_DISCOUNT = 0.2;

/**
 * Teto sugerido a partir da mediana de um item.
 *
 * Arredonda para baixo: um teto acima do pretendido compra caro, um teto um
 * ouro abaixo só deixa passar um anúncio exatamente no limite.
 */
function suggestCeiling(median, discount = SNIPE_DISCOUNT) {
  const m = int(median);
  if (m <= 0) return 0;
  const d = Number(discount);
  const fator = Number.isFinite(d) && d >= 0 && d < 1 ? d : SNIPE_DISCOUNT;
  return Math.max(1, Math.floor(m * (1 - fator)));
}

module.exports = {
  defaultConfig,
  suggestCeiling,
  SNIPE_DISCOUNT,
  normalizeConfig,
  normalizeRule,
  isConfigured,
  remainingOf,
  ceilingFor,
  currencyOf,
  searchesFor,
  matches,
  plan,
  ruleId,
  isExchange,
  unitPriceOf,
  EXCHANGE_DEFS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  MAX_RULES
};
