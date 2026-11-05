/**
 * @file leveling-autosell.js
 * Regras do auto-anunciar: o que vender, por quanto, e o que recusar.
 *
 * Mesma separação de `leveling-sniper.js` e `leveling-boss.js`: aqui não há
 * rede nem tempo. O laço, os sockets e o relógio ficam no serviço; o que
 * precisa de teste é a decisão, e decisão é uma função de dados para dados.
 *
 * ## O preço
 *
 * Há duas referências, e elas servem a propósitos opostos:
 *
 *   mediana   o que o item **vale**, das vendas que de fato aconteceram;
 *   rival     o anúncio ativo mais barato, o que a concorrência **pede**.
 *
 * Anunciar pela mediana ignora a concorrência e o item não vende: quem compra
 * olha a primeira página ordenada por preço. Anunciar pelo rival sem piso
 * entrega o controle a um estranho — basta alguém despejar estoque a 10% para
 * o launcher acompanhar a queda e liquidar o inventário por nada.
 *
 * Daí os dois modos, e a escolha é do usuário porque o objetivo é dele:
 *
 *   `rival`    anuncia **um ouro abaixo do rival**, com um **piso**
 *              proporcional à mediana. Se o rival está abaixo do piso, não
 *              anuncia nada e diz por quê. É o padrão: é o que vende.
 *   `average`  anuncia pela **média ponderada** das vendas do nível exato e
 *              ignora a concorrência. Afirma um preço e espera.
 *
 * Um item não vendido continua sendo seu; um item vendido a um décimo não
 * volta. É por isso que o modo `rival` tem piso e o `average` não precisa de
 * um: a média já é o próprio piso.
 *
 * ## A moeda
 *
 * Ouro ou diamante, e em diamante o preço tem duas origens. Quando o item já
 * foi vendido em diamante naquele nível, as vendas respondem direto. Quando
 * não, o preço em ouro é convertido pela **cotação do câmbio** — a mediana de
 * `cambio:diamante`, que o banco local acumula.
 *
 * A taxa de venda do jogo é 10% nas duas moedas e o teto de preço é o mesmo,
 * então a conversão é proporcional e não compensa nada. O que ela não resolve
 * é a granularidade: o diamante é grosso, e um lote que vale meio diamante não
 * tem preço inteiro que o represente. Esses são recusados, não arredondados.
 *
 * ## O nível é parte da identidade do item
 *
 * Um citrino nv. 2 vale perto de três vezes um nv. 1, e os dois têm o mesmo
 * `def_id`. Qualquer preço calculado por `def_id` sozinho está errado por uma
 * margem que supera qualquer refinamento de média ou de descarte de anormais —
 * e erra para baixo quando o inventário tem o item bom, que é o caso que
 * importa.
 *
 * Por isso a chave de preço é `defId@level+enchant`, e a exigência é de dado
 * **exato**: sem vendas daquele nível, o item é pulado com motivo explícito.
 * `marketPriceHint` existe e seria um fallback cômodo, mas ignora o nível —
 * usá-lo reintroduziria o erro de 3x com cara de resposta.
 *
 * ## Tesouro sim, equipamento nunca
 *
 * Material e material de imbuição — gema, pedra, fragmento — são estoque: o
 * jogo os produz sem parar e vendê-los é a fonte de ouro. Arma e armadura não:
 * uma peça solta no depósito costuma ser reserva, troca de atributo ou algo
 * que o usuário esqueceu ali, e nenhuma dessas é "estoque para liquidar".
 *
 * Equipamento fica fora por tipo, não por estado, e sem catálogo nada é
 * classificado — portanto nada é anunciado. Preferir o dado ausente ao palpite
 * é o que torna uma automação de venda confiável.
 *
 * ## A lista de bloqueio
 *
 * Categoria e preço decidem bem no geral e erram no particular: o material de
 * imbuição que o usuário está juntando para forjar é, pelas regras acima,
 * exatamente o melhor candidato a anunciar — tesouro, caro, com mercado. Não
 * existe sinal no item que separe "estoque" de "reserva"; isso é intenção, e
 * intenção só o usuário tem.
 *
 * Por isso a lista é por `defId`, vale para **todas as contas** e vence todo o
 * resto. Por item inteiro, não por nível: bloquear o citrino nv. 2 e deixar o
 * nv. 1 vendável é a forma de descobrir, tarde, que o que ele guardava era o
 * conjunto. Uma lista de bloqueio que precisa de manutenção a cada nível novo
 * não protege nada.
 */

'use strict';

const listing = require('./leveling-listing');

/**
 * Intervalo entre rodadas. Dez minutos, e o mínimo é um minuto.
 *
 * O mercado não muda em segundos, e cada rodada custa uma leitura de
 * inventário, uma de `mine` e uma busca por item candidato. O sniper corre a
 * cada segundo porque disputa uma pechincha; aqui não há corrida nenhuma — a
 * vaga de anúncio continua vaga.
 */
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Quantos itens uma rodada pode anunciar.
 *
 * Teto baixo de propósito: é escrita irreversível sem cancelar, e um erro de
 * preço com dois itens é um prejuízo pequeno e visível no relatório, enquanto
 * o mesmo erro com dez vagas liquida o inventário antes de alguém notar.
 */
const DEFAULT_MAX_PER_ROUND = 2;
const MAX_PER_ROUND_CAP = 10;

/**
 * Piso de preço, em por cento da mediana.
 *
 * 70% deixa espaço para a oscilação real do mercado — um item de fato vale
 * menos num dia de muita oferta — sem permitir que um despejo defina o preço.
 */
const DEFAULT_FLOOR_PCT = 70;
const MIN_FLOOR_PCT = 10;
const MAX_FLOOR_PCT = 200;

/**
 * Quanto abaixo do rival anunciar.
 *
 * Um ouro basta para ficar na frente na ordenação por preço, que é o que
 * decide a venda. Descontos maiores só entregam margem de graça.
 */
const DEFAULT_UNDERCUT = 1;

/**
 * Como o preço é decidido.
 *
 *   `rival`    um pouco abaixo do anúncio mais barato, com piso na mediana.
 *              É o modo original e continua o padrão: é o que de fato vende,
 *              porque quem compra olha a primeira página ordenada por preço.
 *   `average`  pela média ponderada das vendas do nível exato, ignorando a
 *              concorrência por completo.
 *
 * O modo `average` não é "o mesmo com outra conta": ele troca o objetivo.
 * `rival` persegue a venda rápida e aceita o preço que o mercado está
 * pedindo hoje; `average` afirma um preço e espera. Por isso `floorPct` e
 * `undercut` não se aplicam nele — piso proporcional à própria referência é
 * tautologia, e descontar do rival é exatamente o que o modo recusa fazer.
 */
const PRICE_MODES = ['rival', 'average'];

/** Em que moeda o anúncio sai. */
const CURRENCIES = ['gold', 'diamond'];

/**
 * Preço mínimo, em diamantes, para um anúncio em diamante valer a pena.
 *
 * O diamante é uma moeda grossa: com a cotação na casta dos 380 mil de ouro,
 * um lote que vale 500 mil dá 1,3 diamante. Arredondar para 2 é pedir 53% a
 * mais e não vender; para 1 é dar 24% de desconto, irreversível. Nenhum dos
 * dois é o preço do item.
 *
 * Três é o menor valor em que o passo de um diamante custa menos de um terço
 * do preço. Abaixo disso o anúncio é recusado com motivo próprio, e isso é a
 * regra, não uma limitação: em diamante só vai o que é caro.
 */
const MIN_DIAMOND_PRICE = 3;

/** Vendas mínimas do nível exato para o preço ser levado a sério. */
const MIN_SAMPLES = listing.MIN_SAMPLES;

/**
 * Categorias que o auto-anunciar vende, em ordem de preferência.
 *
 * Os nomes são o rabo do enum `ITEM_CATEGORY_` como o catálogo os entrega
 * (`leveling-market-catalog.js`), em minúsculas.
 */
const TREASURE_CATEGORIES = ['materials', 'imbue_materials'];

/**
 * Categorias que o auto-anunciar nunca vende, nem com vaga sobrando.
 *
 * Por tipo, não por estado: a armadura no depósito é tão equipamento quanto a
 * vestida. Era essa a distinção que faltava quando a lista escondia só o que
 * estava no corpo e a peça reserva aparecia como estoque.
 */
const GEAR_CATEGORIES = new Set(['weapons', 'armor', 'accessories']);

const str = value => String(value == null ? '' : value).trim();

const int = (value, fallback = 0) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Configuração vazia: desligada, nenhuma conta excluída. */
function defaultConfig() {
  return {
    enabled: false,
    intervalMs: DEFAULT_INTERVAL_MS,
    maxPerRound: DEFAULT_MAX_PER_ROUND,
    /**
     * Como precificar. `rival` é o padrão porque é o comportamento que já
     * existia: uma configuração salva antes deste campo tem de continuar
     * anunciando do mesmo jeito depois da atualização.
     */
    priceMode: 'rival',
    /** Em que moeda anunciar. Ouro pelo mesmo motivo. */
    currency: 'gold',
    floorPct: DEFAULT_FLOOR_PCT,
    undercut: DEFAULT_UNDERCUT,
    /** Abaixo disto o item não vale a vaga de anúncio. Zero aceita tudo. */
    minGold: 0,
    /** Recolher do correio o ouro das vendas e os itens devolvidos. */
    claimMail: true,
    /**
     * Itens que nunca são anunciados, por `defId`, em todas as contas.
     *
     * Vazia por padrão, e a inclusão é explícita — o oposto de `excluded`, e
     * de propósito: lá o padrão protege o usuário de uma automação meio
     * ligada; aqui proteger por padrão seria não vender nada.
     */
    blocked: [],
    /**
     * Contas de fora, por índice. Como no auto-boss: todas participam por
     * padrão, e a exclusão é explícita — uma automação que precise ser ligada
     * conta por conta é uma automação que fica meio ligada para sempre.
     */
    excluded: []
  };
}

/** Normaliza a configuração vinda do disco ou da interface. */
function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const padrao = defaultConfig();

  const excluded = [...new Set(
    (Array.isArray(source.excluded) ? source.excluded : [])
      .map(n => int(n, -1))
      .filter(n => n >= 0)
  )].sort((a, b) => a - b);

  // `defId` é identificador do servidor, não texto livre: sem aparar e
  // deduplicar, um espaço colado numa colagem deixaria a linha na tela sem
  // bloquear nada — e uma lista de bloqueio que mente é pior que não ter.
  const blocked = [...new Set(
    (Array.isArray(source.blocked) ? source.blocked : []).map(str).filter(Boolean)
  )].sort();

  return {
    enabled: !!source.enabled,
    intervalMs: Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS,
      int(source.intervalMs, padrao.intervalMs) || padrao.intervalMs)),
    maxPerRound: Math.min(MAX_PER_ROUND_CAP, Math.max(1,
      int(source.maxPerRound, padrao.maxPerRound) || padrao.maxPerRound)),
    // Valor desconhecido cai no padrão, nunca passa adiante: um `prefs.json`
    // editado à mão com `priceMode: 'medio'` não pode produzir um modo que
    // nenhum `switch` trata — o resultado seria um preço indefinido num
    // anúncio irreversível.
    priceMode: PRICE_MODES.includes(str(source.priceMode)) ? str(source.priceMode) : padrao.priceMode,
    currency: CURRENCIES.includes(str(source.currency)) ? str(source.currency) : padrao.currency,
    floorPct: Math.min(MAX_FLOOR_PCT, Math.max(MIN_FLOOR_PCT,
      int(source.floorPct, padrao.floorPct) || padrao.floorPct)),
    // Zero é um desconto válido: anunciar empatado com o rival. Negativo é
    // recortado para zero, e não para o padrão: pedir desconto negativo é
    // pedir para anunciar **acima** do rival, e o mais próximo disso que o
    // auto-anunciar faz é empatar. Cair no padrão daria um desconto que o
    // usuário não pediu.
    undercut: (() => {
      const n = Math.floor(Number(source.undercut));
      if (!Number.isFinite(n)) return padrao.undercut;
      return Math.max(0, n);
    })(),
    minGold: Math.max(0, int(source.minGold, 0)),
    claimMail: source.claimMail === undefined ? true : !!source.claimMail,
    excluded,
    blocked
  };
}

/** Vale ligar o laço? */
function isConfigured(config) {
  return !!normalizeConfig(config).enabled;
}

/** Esta conta participa da rodada? */
function includesAccount(config, index) {
  const cfg = normalizeConfig(config);
  return cfg.enabled && !cfg.excluded.includes(int(index, -1));
}

/**
 * A categoria de um item, segundo o catálogo.
 *
 * Vazio quando o catálogo não chegou ou não conhece o item — e vazio é
 * suficiente para recusar: classificar por `def_id` adivinhado venderia
 * equipamento como se fosse gema.
 */
function categoryOf(item, catalog) {
  const def = (catalog && catalog.items && catalog.items[str(item && item.defId)]) || {};
  return str(item && item.category) || str(def.category);
}

/** É equipamento? */
function isGear(item, catalog) {
  return GEAR_CATEGORIES.has(categoryOf(item, catalog));
}

/**
 * Este item está barrado?
 *
 * Existe separado de `skipReason` porque a tela precisa da resposta sem ter
 * catálogo nem item completo em mãos: o picker marca a caixinha a partir de um
 * `defId` só.
 */
function isBlocked(config, defId) {
  return normalizeConfig(config).blocked.includes(str(defId));
}

/**
 * Liga ou desliga o bloqueio de um item, devolvendo a configuração nova.
 *
 * Imutável, como o resto do módulo: quem guarda estado é o serviço. E por
 * `defId` explícito em vez de alternar — a tela sabe em que posição a caixinha
 * está, e um `toggle` cego erraria se duas telas mexessem na lista.
 */
function withBlocked(config, defId, blocked) {
  const cfg = normalizeConfig(config);
  const id = str(defId);
  if (!id) return cfg;
  const lista = new Set(cfg.blocked);
  if (blocked) lista.add(id);
  else lista.delete(id);
  return normalizeConfig({ ...cfg, blocked: [...lista] });
}

/** É tesouro — material ou material de imbuição? */
function isTreasure(item, catalog) {
  return TREASURE_CATEGORIES.includes(categoryOf(item, catalog));
}

/**
 * A chave de preço de um item: o que faz dele um produto distinto no mercado.
 *
 * `defId@level+enchant`, e os três entram porque os três mudam o preço. Um
 * citrino nv. 2 e um nv. 1 compartilham o `def_id` e não compartilham nada do
 * valor.
 */
function priceKeyOf(item) {
  const it = item || {};
  return `${str(it.defId)}@${int(it.level)}+${int(it.enchant)}`;
}

/**
 * Este item pode entrar numa rodada do auto-anunciar?
 *
 * Devolve `''` quando pode, ou o motivo da recusa. Motivo em vez de booleano
 * porque o relatório é a única coisa que o usuário vê de uma automação que
 * roda sozinha: "28 itens ignorados" não é informação, "28 equipamentos" é.
 *
 *   `blocked`    está na lista de bloqueio do usuário;
 *   `no_uid`     linha sem uid; `MarketCreate` o exige e anunciar sem ele
 *                venderia outro item;
 *   `equipped`   está no corpo — o servidor recusa;
 *   `gear`       é equipamento, e equipamento não é estoque;
 *   `noCategory` o catálogo não classifica; sem classificar não se vende;
 *   `notTreasure` é de uma categoria que o auto-anunciar não vende.
 *
 * O corte por valor mínimo **não** está aqui: ele depende do preço, e o preço
 * só existe depois da consulta ao banco e ao mercado. Testá-lo nesta função
 * obrigaria a adivinhar o valor pelo que o NPC paga, que é outro número.
 *
 * @param {object} item
 * @param {object} catalog
 * @param {Set<string>|Array<string>} [blocked] itens barrados pelo usuário
 */
function skipReason(item, catalog, blocked) {
  const it = item || {};

  // O bloqueio vem antes de tudo, inclusive do uid.
  //
  // Não é otimização: é a garantia de que nenhum caminho novo desta função
  // passe por cima de uma decisão explícita do usuário. Uma lista de bloqueio
  // que vale "a não ser que" não é uma lista de bloqueio.
  const barrados = blocked instanceof Set
    ? blocked
    : new Set((Array.isArray(blocked) ? blocked : []).map(str).filter(Boolean));
  if (barrados.size && barrados.has(str(it.defId))) return 'blocked';

  const base = listing.sellableReason({
    uid: it.uid,
    equipped_slot: it.equippedSlot || it.equipped_slot
  });
  if (base) return base;

  const cat = categoryOf(it, catalog);
  if (!cat) return 'noCategory';
  if (GEAR_CATEGORIES.has(cat)) return 'gear';
  if (!TREASURE_CATEGORIES.includes(cat)) return 'notTreasure';
  return '';
}

/**
 * O preço de anúncio **unitário**, dadas as referências.
 *
 * Devolve a conta inteira, não só o número: uma automação que anuncia sozinha
 * precisa poder explicar cada preço depois, e "1,4 M" sem "mediana 2 M, rival
 * 1,4 M, piso 1,4 M" é um número que não dá para auditar.
 *
 * ## A ordem das recusas, e por que ela é essa
 *
 * Tudo é decidido **em ouro** primeiro, e a conversão para diamante vem por
 * último. Não é conveniência de implementação: `npcPrice` é o que o balcão
 * paga, e o balcão paga em ouro. Comparar "4 diamantes" com "900 de ouro"
 * aprovaria como ótimo um anúncio que vale um décimo do que o NPC dá.
 *
 * ## Diamante
 *
 * Duas fontes, e a primeira é sempre melhor:
 *
 *   direta      houve venda em diamante no nível exato, e `median` já está
 *               nessa moeda. Nada a converter.
 *   convertida  não houve, e o preço em ouro é dividido pela cotação do
 *               câmbio. Depende de uma taxa que envelhece, então a taxa
 *               usada volta no resultado para o relatório poder mostrá-la.
 *
 * A taxa de venda do jogo é de 10% nas duas moedas e o teto de preço é o
 * mesmo, então a conversão é proporcional e não precisa compensar nada.
 *
 * @param {{median:number, average:number, samples:number, rival:number,
 *   floorPct:number, undercut:number, npcPrice:number,
 *   priceMode:string, currency:string, rate:number, directDiamond:boolean}} input
 * @returns {{price:number, floor:number, median:number, average:number, rival:number,
 *   goldPrice:number, currency:string, rate:number, mode:string, reason:string}}
 */
function priceFor(input) {
  const inp = input || {};
  const median = int(inp.median);
  const average = int(inp.average);
  const samples = int(inp.samples);
  const rival = int(inp.rival);
  const floorPct = Math.min(MAX_FLOOR_PCT, Math.max(MIN_FLOOR_PCT, int(inp.floorPct, DEFAULT_FLOOR_PCT)));
  const undercut = Math.max(0, int(inp.undercut, DEFAULT_UNDERCUT));
  const npc = int(inp.npcPrice);
  const mode = PRICE_MODES.includes(str(inp.priceMode)) ? str(inp.priceMode) : 'rival';
  const currency = CURRENCIES.includes(str(inp.currency)) ? str(inp.currency) : 'gold';
  const rate = int(inp.rate);
  // O preço veio de vendas em diamante de verdade? Então ele já está na moeda
  // final e a cotação do câmbio não entra na conta.
  const direta = currency === 'diamond' && !!inp.directDiamond;

  const base = { median, average, rival, currency, mode, rate: direta ? 0 : rate };
  const vazio = { ...base, price: 0, floor: 0, goldPrice: 0 };

  // Sem dado do nível exato não há referência de valor, e a decisão é recusar
  // em vez de estimar. Era o erro do citrino: `price_hint` responderia com a
  // média de todos os níveis e o nv. 2 sairia pelo preço do nv. 1.
  if (median <= 0 || samples < MIN_SAMPLES) {
    return { ...vazio, reason: 'price.noLevelData' };
  }

  // O modo média exige a própria média: ela sai da mesma amostra da mediana,
  // então faltar aqui significa que a amostra não tinha unidade nenhuma — e
  // cair na mediana calada entregaria um preço de outro modo com o nome deste.
  if (mode === 'average' && average <= 0) {
    return { ...vazio, reason: 'price.noLevelData' };
  }

  // A partir daqui tudo é ouro, exceto na venda direta em diamante — onde
  // "ouro" é só o nome da variável e a unidade é o diamante do começo ao fim.
  let alvo;
  let floor = 0;

  if (mode === 'average') {
    // A média é a referência e também a resposta. Sem piso proporcional e sem
    // desconto: os dois existem para negociar com o rival, e este modo não
    // negocia — é o que o usuário pediu ao escolhê-lo.
    alvo = average;
  } else {
    floor = Math.max(1, Math.round(median * floorPct / 100));

    // Ninguém anunciando: a mediana é a melhor referência que existe, e não há
    // concorrência para descontar.
    if (rival <= 0) {
      alvo = Math.max(median, floor);
    } else if (rival < floor) {
      // Rival abaixo do piso é despejo, não preço. Seguir a queda é o caminho
      // pelo qual uma automação liquida um inventário inteiro por nada.
      return { ...vazio, floor, reason: 'price.marketDumped' };
    } else {
      alvo = Math.max(floor, rival - undercut);
    }
  }

  // O NPC é o piso absoluto, e é o motivo de esta comparação vir antes de
  // qualquer conversão: anunciar abaixo do que o balcão paga é pagar taxa de
  // mercado para receber menos do que ele dá de graça. Só se aplica quando o
  // alvo está em ouro — num preço já em diamante os dois números não são
  // comparáveis sem a cotação, e usá-la aqui misturaria as duas fontes.
  if (!direta && npc > 0 && alvo <= npc) {
    return { ...vazio, floor, reason: 'price.belowNpc' };
  }

  if (currency === 'gold' || direta) {
    return { ...base, price: alvo, floor, goldPrice: direta ? 0 : alvo, reason: '' };
  }

  // Diamante por conversão. Sem cotação não há como converter, e inventar uma
  // taxa aqui produziria um anúncio irreversível em cima de um palpite.
  if (rate <= 0) {
    return { ...vazio, floor, goldPrice: alvo, reason: 'price.noRate' };
  }

  // `ceil`: o arredondamento tem de ser a favor de quem vende, como em
  // `normalizeDraft`. Para baixo, um lote sairia por menos do que o cálculo
  // pediu — e um anúncio barato demais some no primeiro comprador que passa.
  const diamantes = Math.ceil(alvo / rate);
  if (diamantes < MIN_DIAMOND_PRICE) {
    return { ...vazio, floor, goldPrice: alvo, reason: 'price.tooCheapForDiamond' };
  }

  return {
    ...base, price: diamantes, floor,
    /** O que o mesmo item valeria em ouro. É a única forma de julgar a conversão depois. */
    goldPrice: alvo,
    reason: ''
  };
}

/**
 * O menor preço unitário entre os anúncios ativos de um item **do mesmo
 * nível**, ignorando os próprios.
 *
 * Os próprios saem porque incluí-los cria uma espiral: o launcher anuncia a
 * 1 M, na rodada seguinte lê o próprio anúncio como rival, desconta um ouro, e
 * repete. Ninguém mais no mercado precisa estar envolvido.
 *
 * `currency` escolhe de quem é a concorrência. Anunciando em diamante, o rival
 * é o anúncio em diamante — e o em ouro passa a ser o incomparável. Era por
 * isso que a moeda tinha de virar parâmetro: a função descartava diamante
 * sempre, o que estava certo enquanto ouro era a única opção e viraria "nenhum
 * rival encontrado" em todo anúncio de diamante.
 *
 * @param {Array} listings
 * @param {object} item
 * @param {string} [currency] `'gold'` (padrão) ou `'diamond'`
 */
function lowestRival(listings, item, currency) {
  const alvo = int(item && item.level);
  const enchant = int(item && item.enchant);
  const diamante = str(currency) === 'diamond';
  let menor = 0;
  for (const l of Array.isArray(listings) ? listings : []) {
    if (!l || l.mine) continue;
    const status = str(l.status);
    if (status && status !== 'MARKET_STATUS_ACTIVE' && status !== 'MARKET_STATUS_UNSPECIFIED') continue;
    // Moeda diferente não é comparável: um anúncio em diamante não concorre
    // em preço com um em ouro. `TOKEN` fica fora nas duas, sempre.
    const moeda = str(l.currency);
    if (moeda.includes('TOKEN')) continue;
    // Ouro chega com o campo **ausente**: `MARKET_CURRENCY_GOLD` é o 1 e
    // proto3 omite o zero, mas o enum nomeado só aparece quando o servidor o
    // preenche. "Não é diamante" é o teste que de fato casa com as vendas
    // reais, o mesmo que `SQL_OURO` faz no banco.
    if (diamante !== moeda.includes('DIAMOND')) continue;
    // Nível e encanto exatos. Um nv. 1 barato não é concorrência de um nv. 2.
    if (int(l.level) !== alvo) continue;
    if (int(l.enchant) !== enchant) continue;
    const unit = int(l.unit_price);
    if (unit <= 0) continue;
    if (!menor || unit < menor) menor = unit;
  }
  return menor;
}

/**
 * Escolhe e precifica o que anunciar nesta rodada.
 *
 * `prices` responde a chave de `priceKeyOf` com
 * `{median, average, samples, rival, directDiamond}`: quem consulta banco e
 * mercado é o serviço, porque isso é entrada e saída. Aqui só se decide.
 *
 * `rate` é a cotação do diamante em ouro, uma por rodada: ela não depende do
 * item, e buscá-la por item seria a mesma resposta repetida.
 *
 * Tesouro primeiro, depois valor do lote. A preferência é do usuário, e é
 * também a ordem que rende mais: as vagas são poucas e o material de imbuição
 * é o que tem mercado de verdade.
 *
 * @returns {{ready:Array, skipped:Array, slots:number}}
 */
function planRound(input) {
  const inp = input || {};
  const cfg = normalizeConfig(inp.config);
  const catalog = inp.catalog || null;
  const prices = inp.prices instanceof Map ? inp.prices : new Map();
  const itens = Array.isArray(inp.items) ? inp.items : [];
  const rate = int(inp.rate);

  // As vagas que o servidor diz existir, nunca um número nosso: o teto de
  // anúncios é do jogo e muda com progressão da conta.
  const limit = int(inp.limit);
  const active = int(inp.active);
  const vagas = Math.max(0, Math.min(limit - active, cfg.maxPerRound));

  const skipped = [];
  const candidatos = [];
  // Um `Set` só para a rodada inteira: a lista é varrida uma vez por item, e
  // o inventário de uma conta passa de 800 linhas.
  const barrados = new Set(cfg.blocked);

  for (const it of itens) {
    const motivo = skipReason(it, catalog, barrados);
    if (motivo) {
      skipped.push({ uid: listing.uid64(it && it.uid), defId: str(it && it.defId), reason: motivo });
      continue;
    }

    const ref = prices.get(priceKeyOf(it)) || {};
    const conta = priceFor({
      median: ref.median,
      average: ref.average,
      samples: ref.samples,
      rival: ref.rival,
      floorPct: cfg.floorPct,
      undercut: cfg.undercut,
      npcPrice: it.sellPrice,
      priceMode: cfg.priceMode,
      currency: cfg.currency,
      directDiamond: ref.directDiamond,
      rate
    });

    if (conta.reason) {
      skipped.push({
        uid: listing.uid64(it.uid),
        defId: str(it.defId),
        level: int(it.level),
        reason: conta.reason,
        median: conta.median,
        rival: conta.rival,
        floor: conta.floor
      });
      continue;
    }

    const qty = Math.max(1, int(it.qty, 1));
    const total = conta.price * qty;

    // `minGold` é um corte em **ouro**, e o nome diz isso. Num anúncio em
    // diamante o que se compara é o valor em ouro equivalente, senão um teto
    // de 50.000 recusaria todo anúncio de diamante — nenhum deles chega perto
    // desse número na própria moeda.
    const valorOuro = cfg.currency === 'diamond'
      ? (conta.goldPrice > 0 ? conta.goldPrice * qty : 0)
      : total;
    // Venda direta em diamante não tem equivalente em ouro conhecido, e
    // estimá-lo pela cotação misturaria as duas fontes de preço. Sem o número,
    // o corte não se aplica: recusar por um valor que não se sabe seria pior
    // que deixar passar.
    if (cfg.minGold > 0 && valorOuro > 0 && valorOuro < cfg.minGold) {
      skipped.push({ uid: listing.uid64(it.uid), defId: str(it.defId), reason: 'cheap', total: valorOuro });
      continue;
    }

    candidatos.push({
      uid: listing.uid64(it.uid),
      defId: str(it.defId),
      name: str(it.name) || str(it.defId),
      level: int(it.level),
      enchant: int(it.enchant),
      quantity: qty,
      unitPrice: conta.price,
      total,
      /** A moeda acompanha o rascunho: é ela que `marketCreate` recebe. */
      currency: conta.currency,
      treasure: isTreasure(it, catalog),
      /**
       * Em que unidade comparar dois candidatos pela vaga.
       *
       * Ouro, sempre que ele é conhecido. A ordenação por `total` daria certo
       * enquanto todos os itens da rodada estivessem na mesma moeda, mas um
       * lote de preço direto em diamante e um convertido convivem na mesma
       * lista — e 4 diamantes contra 1,5 M de ouro ordenaria pelo menor.
       */
      sortValue: valorOuro || total,
      /** De onde o preço saiu. O relatório precisa poder explicar cada anúncio. */
      from: {
        median: conta.median,
        average: conta.average,
        rival: conta.rival,
        floor: conta.floor,
        samples: int(ref.samples),
        mode: conta.mode,
        currency: conta.currency,
        /** Zero quando o preço veio de venda em diamante de verdade. */
        rate: conta.rate,
        /** O equivalente em ouro, para a conversão poder ser auditada depois. */
        goldPrice: conta.goldPrice,
        /** O encanto exato tinha amostra, ou o preço é do nível com encanto misturado? */
        enchantApprox: !!ref.enchantApprox
      }
    });
  }

  candidatos.sort((a, b) => {
    // Tesouro primeiro, mesmo valendo menos: foi o que o usuário pediu, e as
    // vagas são escassas o bastante para a ordem decidir o que de fato vende.
    if (a.treasure !== b.treasure) return a.treasure ? -1 : 1;
    return b.sortValue - a.sortValue;
  });

  const ready = candidatos.slice(0, vagas);
  for (const sobra of candidatos.slice(vagas)) {
    skipped.push({ uid: sobra.uid, defId: sobra.defId, reason: 'noSlot', total: sobra.sortValue });
  }

  return { ready, skipped, slots: vagas };
}

/**
 * As entradas do correio que o auto-anunciar pode recolher.
 *
 * Só venda de mercado e devolução de anúncio, e por isso existe em vez de um
 * `claim_all`: a caixa também tem recompensa de evento, prêmio com prazo e
 * item que o usuário guarda de propósito. Com a bolsa cheia o resgate é
 * parcial, então um `claim_all` automático esvaziaria o que não devia e não
 * haveria volta.
 *
 * O casamento é por `subject_key`, e não por `kind`. Medido no cliente do jogo
 * (`locales/pt-BR/mail.json`): `kind` é a **categoria** da correspondência —
 * `market`, `return`, `reward`, `payment`, `system` — e quem diz o que a
 * entrada é de fato é `subject_key` (`market_sale`, `return`,
 * `market_offer_refund`). Casar por `kind` com nomes de evento nunca dava
 * verdadeiro, e o ouro das vendas ficava parado no correio.
 *
 * `market_purchase` e `market_offer_accepted` ficam de fora de propósito: são
 * item comprado entrando na bolsa, que não é trabalho do auto-anunciar e
 * gastaria o espaço que ele precisa para anunciar.
 *
 * O que não for reconhecido fica onde está: deixar ouro no correio custa um
 * clique, recolher um item errado custa o item.
 */
const MAIL_SUBJECTS = [
  // O ouro da venda, com a taxa já descontada.
  'market_sale',
  // Pacote de skins vendido: mesmo pagamento, chave própria.
  'look_sale',
  // Anúncio cancelado ou expirado devolvendo o item, e o que não cabe na bolsa.
  'return',
  // Proposta recusada ou retirada: o ouro reservado volta.
  'market_offer_refund'
];

/**
 * Categorias aceitas quando o servidor não manda `subject_key`.
 *
 * `market` e `return` são as duas em que tudo que chega é venda, devolução ou
 * reembolso do próprio mercado. Serve de rede de segurança para uma chave de
 * assunto nova que o launcher ainda não conheça.
 */
const MAIL_KINDS = ['market', 'return'];

function claimableMail(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter(e => {
      if (!e || e.claimed) return false;
      // Retida para análise: o servidor recusa o resgate até o prazo, e
      // insistir só gastaria um pedido por rodada para a mesma recusa.
      if (Number(e.heldUntil || e.held_until_ms) > Date.now()) return false;
      const assunto = str(e.subjectKey || e.subject_key);
      if (assunto) return MAIL_SUBJECTS.includes(assunto);
      return MAIL_KINDS.includes(str(e.kind));
    })
    .map(e => str(e.id))
    .filter(Boolean);
}

module.exports = {
  defaultConfig,
  normalizeConfig,
  isConfigured,
  includesAccount,
  categoryOf,
  isGear,
  isTreasure,
  isBlocked,
  withBlocked,
  priceKeyOf,
  skipReason,
  priceFor,
  lowestRival,
  planRound,
  claimableMail,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_PER_ROUND,
  MAX_PER_ROUND_CAP,
  DEFAULT_FLOOR_PCT,
  DEFAULT_UNDERCUT,
  PRICE_MODES,
  CURRENCIES,
  MIN_DIAMOND_PRICE,
  TREASURE_CATEGORIES,
  GEAR_CATEGORIES,
  MAIL_KINDS
};
