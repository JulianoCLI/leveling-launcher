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

/**
 * O escopo de inventário que é o depósito. Mochila é 1; o enum viaja como
 * número, igual em `inventory_page`.
 */
const WAREHOUSE_SCOPE = 3;

const int = (value, fallback = 0) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Um identificador uint64 do servidor, como **string**.
 *
 * `int()` não serve para uid nem para id de anúncio, e a diferença custou um
 * item: `Number('1962493714927616001')` devolve `...616000`, porque o ponto
 * flutuante não tem bits para o último dígito. O estrago não é um erro — é um
 * uid **vizinho que existe**, então o servidor aceita e anuncia outra peça.
 *
 * Por isso o uid nunca é convertido para número aqui. Ele atravessa o domínio
 * como texto e só vira `Long` na borda do codec, onde `uint64()` do serviço
 * cuida disso. Texto também é a forma em que `inventory_page` o entrega.
 *
 * Devolve `''` para qualquer coisa que não seja um inteiro positivo em
 * decimal: notação científica (`1e21`) e `-1` são recusadas junto com o lixo.
 */
const uid64 = value => {
  const texto = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(texto)) return '';
  // `0` e `000` são ausência de uid, não um uid. Sem zeros à esquerda a
  // comparação entre o rascunho e o inventário pode ser por igualdade crua.
  const limpo = texto.replace(/^0+(?=\d)/, '');
  return limpo === '0' ? '' : limpo;
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
 * ## Os dois modos
 *
 *   `top`      o maior dos preços saudáveis. É o padrão e é o que a aba
 *              Anunciar usa: o objetivo ali é vender caro, e o usuário
 *              confere item por item antes de confirmar.
 *   `average`  a média **ponderada por quantidade**. Serve a quem quer o
 *              preço que o item de fato vem fazendo, não o melhor que já fez.
 *
 * A ponderação não é detalhe: uma venda de 3.000 unidades diz muito mais sobre
 * o preço corrente que uma de 1, e a média aritmética daria peso igual às
 * duas. É também a conta que o resto do banco já faz
 * (`SUM(unit_price * quantity) / SUM(quantity)` em `leveling-market-db.js`),
 * e duas definições de "média" no mesmo launcher seriam duas respostas
 * diferentes para a mesma pergunta.
 *
 * O descarte de anormais vale nos **dois** modos, e importa mais no `average`:
 * no `top` a venda anormal é cortada e o que sobra é um preço real, mas na
 * média um zero digitado a mais contamina o resultado inteiro — com 1 M, 1 M e
 * 10 M a média crua é 4 M, um preço pelo qual o item nunca vai sair.
 *
 * @param {Array<{unit_price:number|string, quantity?:number, sold_at_ms?:number}>} sales
 * @param {{mode?:'top'|'average'}} [opts]
 * @returns {{price:number, samples:number, dropped:number, median:number, average:number, mode:string, reason:string}}
 */
function suggestPrice(sales, opts) {
  const mode = (opts && opts.mode) === 'average' ? 'average' : 'top';

  const vendas = (Array.isArray(sales) ? sales : [])
    .map(s => ({
      // Quantidade ausente vale 1, não zero: zero removeria a venda do peso da
      // média e o lote de uma unidade é o caso mais comum do banco.
      price: int(s && s.unit_price),
      qty: Math.max(1, int(s && s.quantity, 1))
    }))
    .filter(v => v.price > 0)
    // Mais recente primeiro é a ordem em que o banco entrega; o corte das dez
    // tem de acontecer antes da ordenação por preço, senão a amostra seria
    // "as dez mais baratas de sempre" em vez de "as dez últimas".
    .slice(0, SAMPLE_SIZE);

  const vazio = { price: 0, samples: vendas.length, dropped: 0, median: 0, average: 0, mode };

  if (vendas.length < MIN_SAMPLES) {
    return { ...vazio, reason: 'price.fewSales' };
  }

  const ordenados = [...vendas].sort((a, b) => a.price - b.price);
  const mediana = medianOf(ordenados.map(v => v.price));
  const teto = mediana * OUTLIER_FACTOR;

  const sadios = ordenados.filter(v => v.price <= teto);
  // Tudo descartado só aconteceria com uma mediana de zero, que a filtragem
  // acima já impede. A guarda fica porque devolver preço zero seria anunciar
  // de graça, e isso não pode depender de nenhuma invariante.
  if (!sadios.length) {
    return {
      ...vazio, dropped: vendas.length,
      median: Math.round(mediana), reason: 'price.allOutliers'
    };
  }

  const unidades = sadios.reduce((s, v) => s + v.qty, 0);
  const media = unidades > 0
    ? sadios.reduce((s, v) => s + v.price * v.qty, 0) / unidades
    : 0;
  const topo = sadios[sadios.length - 1].price;

  return {
    price: Math.round(mode === 'average' ? media : topo),
    samples: vendas.length,
    dropped: vendas.length - sadios.length,
    median: Math.round(mediana),
    /** A média sempre acompanha, mesmo no modo `top`: o relatório compara as duas. */
    average: Math.round(media),
    mode,
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
 * Duas recusas, e cada uma é uma pergunta diferente que a tela precisa
 * responder em vez de simplesmente esconder a linha:
 *
 *   `equipped` está no corpo — o servidor recusa, e o usuário pode querer
 *                tirar e tentar de novo;
 *   `no_uid`     linha sem `uid`, que `MarketCreate` exige. Não deve
 *                acontecer, mas uma linha sem uid anunciada às cegas
 *                venderia outro item.
 *
 * O cadeado saiu da lista. Ele continua impedindo o `MarketCreate`, mas é
 * reversível por pedido — `lock_item` destranca — e o usuário pediu que
 * anunciar destrancasse sozinho. Esconder a linha fazia a aba afirmar que o
 * item não existia, quando bastava um pedido para ele poder ser vendido. A
 * marca `locked` segue na linha, para o preparo saber o que destrancar e para
 * a tela avisar antes de confirmar.
 */
function sellableReason(item) {
  const it = item || {};
  if (!uid64(it.uid)) return 'no_uid';
  const slot = String(it.equipped_slot || '');
  if (slot && slot !== 'EQUIP_SLOT_UNSPECIFIED') return 'equipped';
  return '';
}

/**
 * O que precisa acontecer antes de `MarketCreate` aceitar estes itens.
 *
 * Dois estados do inventário recusam o anúncio e ambos são desfazíveis sem o
 * usuário sair do launcher:
 *
 *   trancado   `market.locked` — `lock_item` tira o cadeado;
 *   depósito   `inventory.item_not_in_bag` — era a recusa que aparecia num
 *              item que o usuário via na conta: ele existe, só não está na
 *              mochila. `warehouse_move` o traz.
 *
 * O escopo 3 é o depósito; 1 é a mochila. A ordem importa no uso: mover
 * primeiro, destrancar depois, porque o depósito pode recusar por bolsa
 * cheia e destrancar o que nem chegou a sair de lá não serviria para nada.
 */
function prepareListings(drafts, items) {
  const porUid = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    // `uid64` nos dois lados, não `String()`: um uid que já passou por
    // `Number` em algum ponto chegaria como `1962493714927616000` e não
    // casaria com o do inventário — e o efeito do não-casamento é silencioso,
    // o item simplesmente não é destrancado nem trazido do depósito, e o
    // `MarketCreate` é recusado sem ninguém saber por quê.
    const chave = uid64(it && it.uid);
    if (chave) porUid.set(chave, it);
  }
  const unlock = [];
  const toBag = [];
  for (const d of Array.isArray(drafts) ? drafts : []) {
    const uid = uid64(d && d.uid);
    const it = uid ? porUid.get(uid) : null;
    if (!it) continue;
    if (it.locked) unlock.push(uid);
    if (int(it.scope) === WAREHOUSE_SCOPE) toBag.push(uid);
  }
  return { unlock, toBag };
}

/**
 * Normaliza uma linha de anúncio vinda da tela.
 *
 * `quantity` é o lote inteiro e não é escolhível: o usuário pediu que um item
 * com mais de uma unidade seja anunciado como pacote. O preço digitado,
 * então, é o do **pacote**, não o da unidade — e é `unit_price` que
 * `MarketCreate` recebe, então a divisão acontece aqui, uma vez, em vez de em
 * cada lugar que monta o pedido.
 *
 * O `uid` sai daqui como **string**. Era `int(source.uid)`, e esse era o
 * caminho do "anunciei um item e no jogo era outro": uids do servidor passam
 * de 2^53, e o arredondamento caía num uid vizinho que existe. O serviço já
 * converte com cuidado na borda do codec, mas recebia o número já estragado.
 */
function normalizeDraft(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const uid = uid64(source.uid);
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
 * Separa o que `mine` devolve em "ainda à venda" e "já saiu".
 *
 * `MarketListing.status` existe e tem quatro valores — `ACTIVE`, `SOLD`,
 * `EXPIRED`, `CANCELED` —, mas a aba ignorava o campo e punha tudo em "À
 * venda agora". O resultado era a confusão relatada: anúncio sem data de
 * expiração, que é justamente o já fechado, aparecia misturado ao que ainda
 * está de pé, e a aba "Vendidos" ficava vazia porque ela lia só o banco
 * local.
 *
 * `SOLD` volta como venda, e isso tapa um buraco real do histórico: o banco
 * local só registra o push `market_push`, que exige o launcher aberto na hora
 * exata da venda. O servidor sabe das outras, e `mine` as entrega — com
 * `buyer_name` e `closed_at_ms`, que é tudo o que a tabela de vendidos mostra.
 *
 * `EXPIRED` e `CANCELED` não são venda nem anúncio de pé: saem das duas
 * listas e viram contagem, porque o item voltou para a mochila e o que o
 * usuário precisa saber é que ele está lá.
 *
 * `UNSPECIFIED` conta como ativo. proto3 omite o zero, então um servidor que
 * não preencha o campo mandaria tudo para o lixo — e sumir com o anúncio de
 * pé é o pior erro possível aqui.
 */
function splitListings(listings) {
  const active = [];
  const sold = [];
  const closed = [];
  for (const l of Array.isArray(listings) ? listings : []) {
    if (!l) continue;
    const status = String(l.status || '');
    if (status === 'MARKET_STATUS_SOLD') sold.push(l);
    else if (status === 'MARKET_STATUS_EXPIRED' || status === 'MARKET_STATUS_CANCELED') closed.push(l);
    else active.push(l);
  }
  return { active, sold, closed };
}

/**
 * Um anúncio vendido na forma que a tabela de vendidos espera.
 *
 * As duas fontes do histórico têm formatos diferentes: o banco local grava o
 * push com `sold_at_ms`, `net` e `fee`; `mine` devolve um `MarketListing` com
 * `closed_at_ms` e nenhum líquido — a taxa é do jogo e não vem na mensagem.
 * Normalizar aqui é o que permite a tabela ter uma linha só.
 *
 * `net` fica em zero de propósito quando não se sabe. Estimá-lo pela taxa
 * daria um número com cara de exato que nenhuma fonte confirmou.
 */
function saleFromListing(listing) {
  const l = listing || {};
  return {
    listing_id: String(l.id || ''),
    def_id: String(l.def_id || ''),
    name: String(l.name || ''),
    rarity: String(l.rarity || ''),
    level: int(l.level),
    quantity: int(l.quantity, 1),
    currency: String(l.currency || ''),
    unit_price: int(l.unit_price),
    total: int(l.total),
    /** Desconhecido: `MarketListing` não traz o líquido nem a taxa. */
    net: 0,
    fee: 0,
    buyer_name: String(l.buyer_name || ''),
    sold_at_ms: int(l.closed_at_ms),
    /** De onde a linha veio. A tabela precisa poder explicar o líquido vazio. */
    source: 'server'
  };
}

/**
 * Junta o histórico do banco com o que o servidor ainda lembra.
 *
 * Por `listing_id`, e o banco ganha: ele tem o líquido e a taxa reais do
 * push, enquanto a versão do servidor só sabe o total pedido. Sem a chave —
 * anúncio sem id — a linha entra assim mesmo, porque perder uma venda é pior
 * que mostrá-la duas vezes.
 */
function mergeSales(local, fromServer) {
  const out = [];
  const vistos = new Set();
  for (const s of Array.isArray(local) ? local : []) {
    if (!s) continue;
    const id = String(s.listing_id || '');
    if (id) vistos.add(id);
    out.push(s);
  }
  for (const s of Array.isArray(fromServer) ? fromServer : []) {
    if (!s) continue;
    const id = String(s.listing_id || '');
    if (id && vistos.has(id)) continue;
    if (id) vistos.add(id);
    out.push(s);
  }
  return out.sort((a, b) => int(b.sold_at_ms) - int(a.sold_at_ms));
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
      const uid = uid64(bruto && bruto.uid);
      blocked.push({
        uid,
        name: String((bruto && bruto.name) || ''),
        reason: uid ? 'price.missing' : 'no_uid'
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
  prepareListings,
  splitListings,
  saleFromListing,
  mergeSales,
  normalizeDraft,
  planListings,
  medianOf,
  uid64,
  SAMPLE_SIZE,
  OUTLIER_FACTOR,
  MIN_SAMPLES,
  LISTING_HOURS,
  WAREHOUSE_SCOPE
};
