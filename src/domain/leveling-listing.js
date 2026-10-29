/**
 * @file leveling-listing.js
 * Preço de anúncio e seleção de itens vendáveis. Decide, não anuncia.
 *
 * Mesma separação de `leveling-sniper.js`: aqui não há rede nem tempo. O que
 * precisa de teste é "por quanto anunciar", e essa é uma pergunta sobre uma
 * lista de números.
 *
 * O problema do preço automático é que a média mente e o máximo mente mais.
 * Nas últimas dez vendas de um item quase sempre há uma que não é preço de
 * mercado — alguém digitou um zero a mais, ou vendeu uma peça encantada que o
 * feed não distingue da comum. Anunciar pelo máximo cru copiaria esse erro; e
 * como o objetivo do usuário é vender *caro*, anunciar pela mediana jogaria
 * dinheiro fora no caso normal.
 *
 * O que se faz: joga fora o que está acima de `OUTLIER_FACTOR` vezes a
 * mediana, e usa o maior do que sobrou. Com 1M, 1M e 10M a mediana é 1M, o
 * corte é 2,5M, a de 10M sai, e o anúncio sai por 1M. Sem nenhuma venda
 * anormal nada é descartado e o preço é o topo real.
 */

'use strict';

/**
 * Quantas vendas recentes o automático olha.
 *
 * Dez é o que o usuário pediu, e também o que o banco costuma ter de um item
 * comum numa janela curta. Mais do que isso começaria a misturar o preço de
 * ontem com o de hoje em item volátil.
 */
const SAMPLE_SIZE = 10;

/**
 * Acima de quantas vezes a mediana uma venda é considerada anormal.
 *
 * 2,5 é folgado de propósito. O preço de um item oscila de verdade — uma
 * venda legítima a 2x a mediana acontece —, e um corte apertado descartaria
 * justamente os preços bons, que é o oposto do que o automático serve.
 */
const OUTLIER_FACTOR = 2.5;

/** Mínimo de vendas para o automático arriscar um preço. */
const MIN_SAMPLES = 2;

/** Duração do anúncio, em horas. */
const LISTING_HOURS = 48;

const int = (value, fallback = 0) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Mediana de uma lista já ordenada. Par devolve a média dos dois do meio. */
function medianOf(ordenados) {
  const n = ordenados.length;
  if (!n) return 0;
  const meio = Math.floor(n / 2);
  return n % 2 ? ordenados[meio] : (ordenados[meio - 1] + ordenados[meio]) / 2;
}

/**
 * Preço sugerido a partir de uma lista de vendas.
 *
 * Devolve sempre a conta inteira, não só o número: a tela de verificação
 * mostra de onde o preço saiu, e "1,2 M" sem dizer "de 8 vendas, 2
 * descartadas" é um número que o usuário não tem como julgar.
 *
 * @param {Array<{unit_price:number|string, sold_at_ms?:number}>} sales
 * @returns {{price:number, samples:number, dropped:number, median:number, reason:string}}
 */
function suggestPrice(sales) {
  const precos = (Array.isArray(sales) ? sales : [])
    .map(s => int(s && s.unit_price))
    .filter(n => n > 0)
    // Mais recente primeiro é a ordem em que o banco entrega; o corte das dez
    // tem de acontecer antes da ordenação por preço, senão a amostra seria
    // "as dez mais baratas de sempre" em vez de "as dez últimas".
    .slice(0, SAMPLE_SIZE);

  if (precos.length < MIN_SAMPLES) {
    return { price: 0, samples: precos.length, dropped: 0, median: 0, reason: 'price.fewSales' };
  }

  const ordenados = [...precos].sort((a, b) => a - b);
  const mediana = medianOf(ordenados);
  const teto = mediana * OUTLIER_FACTOR;

  const sadios = ordenados.filter(p => p <= teto);
  // Tudo descartado só aconteceria com uma mediana de zero, que a filtragem
  // acima já impede. A guarda fica porque devolver preço zero seria anunciar
  // de graça, e isso não pode depender de nenhuma invariante.
  if (!sadios.length) {
    return { price: 0, samples: precos.length, dropped: precos.length, median: mediana, reason: 'price.allOutliers' };
  }

  return {
    price: Math.round(sadios[sadios.length - 1]),
    samples: precos.length,
    dropped: precos.length - sadios.length,
    median: Math.round(mediana),
    reason: ''
  };
}

/**
 * O preço sugerido **do lote**: o unitário multiplicado pela quantidade.
 *
 * É a única conversão entre as duas unidades que convivem na aba, e por isso
 * existe como função em vez de uma multiplicação espalhada pela tela.
 * `suggestPrice` trabalha sobre `unit_price`, a coluna das vendas, logo
 * devolve preço por unidade; o campo que o usuário preenche é o do pacote,
 * porque foi assim que ele pediu.
 *
 * Confundir as duas foi um bug de verdade: um lote de 10 com sugestão de
 * 380 000 a unidade entrava no campo como 380 000 pelas dez, e o anúncio saía
 * a 38 000 cada — um décimo do preço, para o primeiro comprador que passasse.
 */
function lotPrice(unitSuggestion, quantity) {
  const unit = int(unitSuggestion);
  const qty = Math.max(1, int(quantity, 1));
  return unit * qty;
}

/**
 * Um item do inventário pode ser anunciado?
 *
 * Três recusas, e cada uma é uma pergunta diferente que a tela precisa
 * responder em vez de simplesmente esconder a linha:
 *
 *   `equipped` está no corpo — o servidor recusa, e o usuário pode querer
 *                tirar e tentar de novo;
 *   `locked`     o próprio usuário trancou dentro do jogo, de propósito;
 *   `no_uid`     linha sem `uid`, que `MarketCreate` exige. Não deve
 *                acontecer, mas uma linha sem uid anunciada às cegas
 *                venderia outro item.
 */
function sellableReason(item) {
  const it = item || {};
  if (!int(it.uid)) return 'no_uid';
  if (it.locked) return 'locked';
  const slot = String(it.equipped_slot || '');
  if (slot && slot !== 'EQUIP_SLOT_UNSPECIFIED') return 'equipped';
  return '';
}

/**
 * Normaliza uma linha de anúncio vinda da tela.
 *
 * `quantity` é o lote inteiro e não é escolhível: o usuário pediu que um item
 * com mais de uma unidade seja anunciado como pacote. O preço digitado,
 * então, é o do **pacote**, não o da unidade — e é `unit_price` que
 * `MarketCreate` recebe, então a divisão acontece aqui, uma vez, em vez de em
 * cada lugar que monta o pedido.
 */
function normalizeDraft(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const uid = int(source.uid);
  if (!uid) return null;

  const quantity = Math.max(1, int(source.quantity, 1));
  const total = int(source.total);
  if (total <= 0) return null;

  return {
    uid,
    defId: String(source.defId || ''),
    name: String(source.name || ''),
    level: int(source.level),
    quantity,
    /** O que o usuário digitou: o preço do pacote. */
    total,
    /** O que o servidor recebe. Arredondado para cima para o lote nunca sair por menos que o pedido. */
    unitPrice: Math.max(1, Math.ceil(total / quantity)),
    currency: source.currency === 'diamond' ? 'diamond' : 'gold',
    hours: LISTING_HOURS,
    auto: !!source.auto
  };
}

/**
 * A lista de anúncios a confirmar.
 *
 * Separa o que está pronto do que falta preço, porque são dois pedidos
 * diferentes ao usuário: um é "confirma?" e o outro é "digita o valor". Uma
 * lista só, com linhas inválidas no meio, levaria a confirmar sem ver.
 */
function planListings(drafts) {
  const ready = [];
  const blocked = [];
  for (const bruto of Array.isArray(drafts) ? drafts : []) {
    const draft = normalizeDraft(bruto);
    if (!draft) {
      blocked.push({
        uid: int(bruto && bruto.uid),
        name: String((bruto && bruto.name) || ''),
        reason: int(bruto && bruto.uid) ? 'price.missing' : 'no_uid'
      });
      continue;
    }
    ready.push(draft);
  }
  return {
    ready,
    blocked,
    totalGold: ready.filter(d => d.currency === 'gold').reduce((s, d) => s + d.total, 0),
    totalDiamond: ready.filter(d => d.currency === 'diamond').reduce((s, d) => s + d.total, 0)
  };
}

module.exports = {
  suggestPrice,
  lotPrice,
  sellableReason,
  normalizeDraft,
  planListings,
  medianOf,
  SAMPLE_SIZE,
  OUTLIER_FACTOR,
  MIN_SAMPLES,
  LISTING_HOURS
};
