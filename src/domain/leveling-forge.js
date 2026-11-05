/**
 * @file leveling-forge.js
 * Regras da auto-forja: o que desmontar, o que fundir e em qual slot. Decide,
 * não envia.
 *
 * Mesma separação de `leveling-stats.js` e `leveling-autosell.js`: aqui mora a
 * parte que precisa de teste — "este inventário e estas regras dão qual
 * rodada?" — e nada de socket, de relógio global ou de estado mutável.
 *
 * O pedido que este módulo atende, em uma frase: **cada conta forja só o que
 * fortalece aquele personagem**.
 *
 * ## Por que não existe mais um alvo global
 *
 * A primeira versão pedia ao usuário um par `(nível, raridade)` e levava todas
 * as contas até ele. Na prática as contas não se parecem: uma está no nível 30
 * com peças raras, outra no 80 com épicas, e um alvo único ou deixa a primeira
 * forjando o que não consegue equipar ou deixa a segunda parada num alvo que já
 * ultrapassou.
 *
 * Agora o alvo é derivado, conta a conta, de duas leituras:
 *
 *   1. **o que está no corpo**: nível, raridade e `power` de cada slot;
 *   2. **o que está na bolsa**: as peças de cada slot, agrupadas por raridade e
 *      ordenadas por nível.
 *
 * A pergunta de cada slot deixa de ser "alcançou o alvo?" e passa a ser "existe
 * uma fusão que eu **consigo fazer agora** e que sai melhor do que a peça que
 * está equipada?". Se não existe, o slot não é tocado.
 *
 * ## O nível de saída é o **menor** dos insumos
 *
 * Medido no jogo: fundir quatro peças de nível 55 com uma de 52 devolve uma
 * peça de nível **52**. Isso muda a seleção de insumos inteira.
 *
 * A consequência não é óbvia: a janela certa de cinco peças **não é a das cinco
 * melhores**. É a das cinco mais baixas que ainda produzem um ganho. Pegar as
 * melhores arrastaria níveis altos para uma saída que o nível mais baixo da
 * janela já define, queimando material que serviria à fusão seguinte.
 *
 * Então o pool de cada slot é ordenado por nível crescente e as janelas de
 * cinco são varridas de baixo para cima, **parando na primeira que supera a
 * peça equipada**. É a política gulosa correta: o ganho cresce com a janela, e
 * a primeira que serve é a mais barata em níveis.
 *
 * ## Por que o desmonte vem primeiro
 *
 * Invertido em relação à primeira versão, e de propósito: sem pó arcano não há
 * fusão nenhuma, e o pó só vem do desmonte. Comuns e incomuns não são insumo de
 * nada que interesse nem peça que alguém equipe, então são moídos no começo da
 * rodada, sempre.
 *
 * O desmonte de raridades **acima** dessas é outra coisa: é condicional, entra
 * só quando falta pó para a fusão já escolhida, e é dimensionado — para no
 * primeiro item que fecha a conta. E nunca toca em peça de nível acima do nível
 * de saída da fusão, porque essa é insumo da próxima.
 *
 * ## O degrau de raridade é um só
 *
 * A fusão sobe **um** degrau. O módulo não encadeia degraus dentro de uma
 * rodada de propósito — cada fusão é uma escrita irreversível, e encadear
 * esconderia do relatório que a peça lendária custou vinte e cinco raras. Quem
 * encadeia é o tempo: a rodada seguinte vê o inventário novo e decide de novo.
 *
 * ## O que este módulo não faz
 *
 * Não encanta, não reforja, não engasta gema, não conserta. `Enchant`,
 * `Reforge`, `SocketGem` e `Repair` existem no protocolo e continuam fora: cada
 * um gasta um recurso diferente, com uma política própria, e misturá-los aqui
 * faria uma tela em que ligar "forjar" gastaria quatro coisas ao mesmo tempo.
 *
 * Não converte o custo de ouro. `fusion_gold_kills` é expresso em **kills**, e a
 * conversão para ouro depende de `gold_per_kill_poly` e `gold_level_scale`, cuja
 * ordem dos coeficientes não está documentada no schema. Em vez de adivinhar, o
 * número viaja como veio e a tela o mostra como kills — a mesma regra de
 * `leveling-autosell.js`: preferir o dado ausente ao palpite.
 */

'use strict';

/**
 * Os slots que a fusão **produz**, nos números do enum `EquipSlot` de
 * `common.proto`.
 *
 * Esta lista encolheu de onze para oito, e o motivo é o jogo: o seletor de slot
 * de saída da aba Fusão oferece Arma, Escudo, Capacete, Peitoral, Calça, Luvas,
 * Botas, Cinto e Capa — e mais nada. Colar, anel e brinco nunca saíram de uma
 * fusão; mantê-los aqui gerava candidatos impossíveis que a rodada tentava e o
 * servidor recusava.
 *
 * Escudo sai também, apesar de estar no seletor: é exclusivo de algumas classes
 * e o personagem de duas mãos nunca o preenche, o que deixaria um slot em falta
 * permanente consumindo material para sempre.
 *
 * Derivar o número da posição na lista daria `CAPACETE = 2` e erraria calado,
 * exatamente como o buraco de `StatId` em `leveling-stats.js`.
 */
const SLOTS = Object.freeze({
  ARMA: 1,
  CAPACETE: 3,
  PEITORAL: 4,
  CALCA: 5,
  LUVAS: 6,
  BOTAS: 7,
  CINTO: 8,
  CAPA: 9
});

/** Ordem de exibição, a mesma da ficha do personagem no jogo. */
const SLOT_ORDER = Object.freeze([
  'CAPACETE', 'PEITORAL', 'CALCA', 'BOTAS',
  'ARMA', 'CAPA', 'LUVAS', 'CINTO'
]);

/** Do número do enum de volta para a sigla. */
const SLOT_BY_ID = Object.freeze(
  Object.fromEntries(Object.entries(SLOTS).map(([k, v]) => [v, k]))
);

/** Nome em português, para a tela e para o relatório. */
const SLOT_NAMES = Object.freeze({
  ARMA: 'Arma',
  CAPACETE: 'Capacete',
  PEITORAL: 'Peitoral',
  CALCA: 'Calça',
  LUVAS: 'Luvas',
  BOTAS: 'Botas',
  CINTO: 'Cinto',
  CAPA: 'Capa'
});

/** Quantas peças a fusão consome, se o catálogo não informar. */
const DEFAULT_FUSION_INPUTS = 5;

/**
 * Quantas raridades de baixo são moídas sem perguntar, quando o usuário não
 * escolheu um teto.
 *
 * Duas: comum e incomum. São as que nunca entram numa fusão que valha a pena e
 * nunca ficam no corpo de ninguém — e é delas que sai o pó que paga todo o
 * resto. Contar duas a partir da `order` mais baixa, em vez de procurar os ids
 * "comum" e "incomum", mantém isto funcionando num servidor que renomeie as
 * raridades.
 */
const DEFAULT_JUNK_TIERS = 2;

/**
 * Recuo depois de uma recusa do servidor, em milissegundos.
 *
 * A rodada é disparada por `inventory_delta`, que chega a cada drop: sem recuo,
 * uma recusa que não muda o inventário faria o próximo drop tentar de novo, e o
 * seguinte, e assim por diante.
 */
const BACKOFF_MS = 300000;

/**
 * Espera mínima entre duas rodadas da mesma conta.
 *
 * Diferente do recuo: este vale também para a rodada bem-sucedida. Uma rodada
 * lê o inventário inteiro — doze páginas de cem — e um drop por segundo numa
 * caçada ativa faria essa varredura por segundo.
 *
 * Vinte segundos, e não um minuto: desde que a rodada passou a fundir em lote,
 * ela esvazia o que a bolsa tem de pronto em vez de consumir cinco peças por
 * vez, então a espera deixou de ser o que define o ritmo da forja e voltou a
 * ser só a guarda contra a varredura por drop.
 */
const MIN_GAP_MS = 20000;

/** Linhas guardadas no relatório. */
const LOG_MAX = 300;

/**
 * Teto de peças desmontadas numa rodada.
 *
 * `Dismantle` leva a lista inteira numa requisição só, então o teto nunca
 * economizou rede — ele só limitava o pó que a rodada conseguia levantar, e um
 * teto baixo estrangulava justamente a conta cheia de lixo, que é a que mais
 * tem a ganhar.
 */
const DEFAULT_MAX_DISMANTLE = 50;

/**
 * Teto de fusões numa rodada.
 *
 * Uma rodada passou a fundir em lote, e cinco fusões são vinte e cinco peças
 * destruídas de uma vez. O teto existe para o usuário que ligou a automação e
 * foi dormir não acordar com a bolsa derretida: o lote seguinte vem na rodada
 * seguinte, e o inventário entre as duas é relido.
 */
const DEFAULT_MAX_FUSIONS = 5;

const arr = v => (Array.isArray(v) ? v : []);
const int = (value, fallback = 0) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : fallback;
};
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = v => (typeof v === 'string' ? v.trim() : '');

/**
 * O número do enum para o que vier: número, sigla, ou o nome completo.
 *
 * O nome completo existe porque o codec desserializa com `enums: String`: todo
 * `ItemInstance` que **chega** do servidor traz `equipped_slot: 'EQUIP_SLOT_ARMA'`,
 * nunca 1. Só o que **sai** daqui usa número, porque o `verify` recusa o nome em
 * campo de enum. As duas pontas falam formas diferentes, e é esta função que as
 * junta — a mesma de `statId` em `leveling-stats.js`.
 *
 * Devolve 0 para tudo que a fusão não produz — escudo, tesouro, colar, anel,
 * brinco. Eles existem no enum e não neste módulo, e tratá-los como slot válido
 * os colocaria na busca de candidatos.
 */
function slotId(value) {
  if (typeof value === 'number') return SLOTS[SLOT_BY_ID[value]] || 0;
  const texto = str(value).toUpperCase();
  if (!texto) return 0;
  const sigla = texto.startsWith('EQUIP_SLOT_') ? texto.slice('EQUIP_SLOT_'.length) : texto;
  return SLOTS[sigla] || 0;
}

/** A sigla para qualquer das três formas, ou string vazia. */
function slotSigla(value) {
  return SLOT_BY_ID[slotId(value)] || '';
}

/** O nome em português, ou a sigla crua se o slot não for dos nossos. */
function slotName(value) {
  const sigla = slotSigla(value);
  return SLOT_NAMES[sigla] || sigla || str(value);
}

// ------------------------------------------------------------------ catálogo

/**
 * As regras de fusão, extraídas do recorte que `leveling-market-catalog.js` faz
 * do `content_catalog`.
 *
 * Devolve `null` quando falta o essencial. Sem `fusion_inputs` não há como
 * saber quantas peças uma fusão come, e chutar cinco gastaria peças de verdade
 * num palpite — a mesma recusa de `stats.noCatalog`.
 */
function readRules(catalog) {
  const fusion = catalog && catalog.fusion;
  if (!fusion) return null;
  const inputs = int(fusion.fusionInputs, 0);
  if (inputs <= 0) return null;
  return {
    dustItemId: str(fusion.dustItemId),
    inputs,
    swapInputs: int(fusion.swapInputs, 0) || inputs,
    dustCost: fusion.fusionDustCost || {},
    goldKills: fusion.fusionGoldKills || {},
    swapDustCost: fusion.swapDustCost || {},
    swapGoldKills: fusion.swapGoldKills || {},
    dustPerRarity: fusion.dustPerRarity || {},
    outputSlots: arr(fusion.outputSlots).map(slotId).filter(Boolean)
  };
}

/** O catálogo tem o mínimo para a tela se montar? */
function hasRules(catalog) {
  return !!readRules(catalog) && !!rarityList(catalog).length;
}

/**
 * As raridades conhecidas, da mais baixa para a mais alta.
 *
 * `RarityDef.order` é o campo que ordena; o id é string livre no protocolo
 * (`ItemInstance.rarity`), então comparar por nome não serviria.
 */
function rarityList(catalog) {
  const raras = (catalog && catalog.rarities) || {};
  return Object.entries(raras)
    .map(([id, def]) => ({
      id,
      name: str(def && def.name) || id,
      color: str(def && def.color),
      order: int(def && def.order, 0),
      statMult: num(def && def.statMult)
    }))
    .sort((a, b) => a.order - b.order);
}

/** A ordem de uma raridade, ou `null` se o catálogo não a conhece. */
function rarityOrder(catalog, id) {
  const chave = str(id);
  if (!chave) return null;
  const def = ((catalog && catalog.rarities) || {})[chave];
  if (!def) return null;
  return int(def.order, 0);
}

/**
 * O multiplicador de atributos de uma raridade, ou 0 quando ausente.
 *
 * Zero não é "sem bônus": é "o catálogo não disse". A diferença importa, e quem
 * decide o que fazer com a ausência é `windowGain`.
 */
function rarityMult(catalog, id) {
  const def = ((catalog && catalog.rarities) || {})[str(id)];
  return def ? num(def.statMult) : 0;
}

/** O nome de exibição de uma raridade, ou o próprio id. */
function rarityName(catalog, id) {
  const def = ((catalog && catalog.rarities) || {})[str(id)];
  return (def && str(def.name)) || str(id);
}

/**
 * A raridade imediatamente abaixo de outra — os insumos de uma fusão.
 *
 * "Imediatamente" pela `order`, e não pela posição na lista: o catálogo pode
 * numerar com buracos, e contar posições inventaria um degrau que não existe.
 */
function rarityBelow(catalog, id) {
  const ordem = rarityOrder(catalog, id);
  if (ordem === null) return null;
  let melhor = null;
  for (const r of rarityList(catalog)) {
    if (r.order >= ordem) continue;
    if (!melhor || r.order > melhor.order) melhor = r;
  }
  return melhor ? melhor.id : null;
}

/**
 * A raridade imediatamente acima — o que sai de uma fusão desta.
 *
 * É a direção que a nova política usa: antes o usuário dizia a raridade de
 * saída e o módulo descia um degrau para achar o insumo; agora o insumo é o que
 * a bolsa tem, e a saída é consequência.
 */
function rarityAbove(catalog, id) {
  const ordem = rarityOrder(catalog, id);
  if (ordem === null) return null;
  let melhor = null;
  for (const r of rarityList(catalog)) {
    if (r.order <= ordem) continue;
    if (!melhor || r.order < melhor.order) melhor = r;
  }
  return melhor ? melhor.id : null;
}

/**
 * Até onde o desmonte automático vai, em `order` de raridade.
 *
 * Sem escolha do usuário, as `DEFAULT_JUNK_TIERS` raridades mais baixas. Com
 * escolha, a dela — e aí a responsabilidade é de quem escolheu, com a trava de
 * `forge.dismantleClash` ainda valendo para o caso de o teto alcançar material
 * que a fusão planejada ia consumir.
 */
function junkCeiling(catalog, config) {
  const cfg = normalizeConfig(config);
  if (cfg.dismantleUpTo) return rarityOrder(catalog, cfg.dismantleUpTo);
  const lista = rarityList(catalog);
  if (!lista.length) return null;
  const corte = lista[Math.min(DEFAULT_JUNK_TIERS, lista.length) - 1];
  return corte ? corte.order : null;
}

// ------------------------------------------------------------- configuração

/**
 * Configuração vazia: **desligada**.
 *
 * Desmontar apaga a peça para sempre e fundir consome cinco delas. Das
 * automações do launcher esta é a que destrói mais coisa por rodada, então ela
 * nasce desligada — ligada por padrão ela começaria a derreter o inventário do
 * usuário no primeiro drop.
 *
 * O que sumiu em relação à primeira versão: `level` e `rarity`. Não há mais
 * alvo a configurar, porque o alvo é lido da conta.
 */
function defaultConfig() {
  return {
    enabled: false,
    dismantleUpTo: '',
    allowSlotSwap: false,
    equipBest: true,
    maxDismantle: DEFAULT_MAX_DISMANTLE,
    maxFusions: DEFAULT_MAX_FUSIONS,
    keep: [],
    slotsOff: [],
    disabled: []
  };
}

/**
 * Normaliza o que vem do disco ou da tela.
 *
 * Contas e slots são listados pelo que está **fora**, nunca pelo que está
 * dentro, pela mesma razão do boss e do status: uma aba nova traz contas novas,
 * e uma lista de permissões as deixaria de fora em silêncio.
 */
function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};

  const disabled = [...new Set(arr(source.disabled).map(i => int(i, -1)).filter(i => i >= 0))]
    .sort((a, b) => a - b);

  const slotsOff = [...new Set(arr(source.slotsOff).map(slotId).filter(Boolean))]
    .sort((a, b) => a - b);

  const keep = [...new Set(arr(source.keep).map(str).filter(Boolean))].sort();

  return {
    enabled: !!source.enabled,
    dismantleUpTo: str(source.dismantleUpTo),
    allowSlotSwap: !!source.allowSlotSwap,
    // Ligado por padrão, ao contrário da primeira versão: sem equipar, a peça
    // forjada fica na bolsa e a rodada seguinte mede o ganho contra a peça
    // velha — e forjaria a mesma coisa de novo, para sempre.
    equipBest: source.equipBest === undefined ? true : !!source.equipBest,
    maxDismantle: Math.max(1, Math.min(100, int(source.maxDismantle, DEFAULT_MAX_DISMANTLE))),
    maxFusions: Math.max(1, Math.min(50, int(source.maxFusions, DEFAULT_MAX_FUSIONS))),
    keep,
    slotsOff,
    disabled
  };
}

/**
 * Vale ligar o gatilho?
 *
 * Só o interruptor, agora. Não há mais alvo para exigir: a conta que não tem o
 * que forjar simplesmente não forja, e descobrir isso é trabalho de `plan`.
 */
function isConfigured(config) {
  return !!normalizeConfig(config).enabled;
}

/** Esta conta participa? */
function accountEnabled(config, index) {
  const cfg = normalizeConfig(config);
  if (!cfg.enabled) return false;
  return !cfg.disabled.includes(int(index, -1));
}

/** Os slots que a busca de candidatos cobre nesta configuração. */
function activeSlots(config) {
  const fora = new Set(normalizeConfig(config).slotsOff);
  return SLOT_ORDER.map(s => SLOTS[s]).filter(n => !fora.has(n));
}

// ----------------------------------------------------------------- leitura

/**
 * A peça pode ser tocada por esta automação?
 *
 * Três guardas, e todas são "o usuário já disse que não":
 *
 *   equipada  está no corpo. Desmontá-la deixaria o slot vazio, e ela é
 *             justamente a referência contra a qual o ganho é medido.
 *   trancada  o cadeado é do jogo, e é como o jogador diz "não toque". O
 *             auto-anunciar o destranca porque o usuário confirmou item por
 *             item na tela; aqui ninguém confirma nada, então ele vale.
 *   guardada  está na lista `keep`, escolhida à mão na janela.
 */
function touchable(item, keep) {
  if (!item) return false;
  if (slotId(item.equippedSlot)) return false;
  if (item.equipped) return false;
  if (str(item.equippedOnShadow) && str(item.equippedOnShadow) !== '0') return false;
  if (item.locked) return false;
  if (keep && keep.has(str(item.defId))) return false;
  return true;
}

/**
 * O slot de uma peça da bolsa.
 *
 * `ItemInstance.equipped_slot` só vale para o que está no corpo; o slot do tipo
 * mora em `ItemDef.slot`, que o recorte do catálogo guarda por `def_id`. Sem
 * catálogo não há slot, e sem slot a peça não entra em fusão nenhuma — fundir
 * sem saber o destino é exatamente o que `Fuse.slot` existe para evitar.
 */
function itemSlot(item, catalog) {
  if (!item) return 0;
  const doCorpo = slotId(item.equippedSlot);
  if (doCorpo) return doCorpo;
  const def = ((catalog && catalog.items) || {})[str(item.defId)];
  return def ? slotId(def.slot) : 0;
}

/** As peças equipadas, por número de slot. Slots fora da lista são ignorados. */
function equippedBySlot(items) {
  const out = {};
  for (const item of arr(items)) {
    if (!item) continue;
    const slot = slotId(item.equippedSlot);
    if (!slot) continue;
    out[slot] = item;
  }
  return out;
}

/** A forma reduzida de uma peça, a que viaja no plano e na tela. */
function brief(item) {
  if (!item) return null;
  return {
    uid: str(item.uid),
    defId: str(item.defId),
    level: int(item.level),
    rarity: str(item.rarity),
    power: num(item.power)
  };
}

/**
 * O retrato de uma conta: o que está no corpo e o que está na bolsa, pronto
 * para a busca de candidatos.
 *
 * O pool é indexado por **slot e depois raridade**, e cada lista vem ordenada
 * por **nível crescente**. A ordem não é cosmética: é ela que faz a varredura
 * de janelas achar a mais barata primeiro, porque o nível de saída da fusão é o
 * menor nível da janela.
 */
function profile({ items, catalog = null, config } = {}) {
  const cfg = normalizeConfig(config);
  const keep = new Set(cfg.keep);
  const equipado = equippedBySlot(items);

  const pool = {};
  let total = 0;

  for (const item of arr(items)) {
    if (!touchable(item, keep)) continue;
    const slot = itemSlot(item, catalog);
    if (!slot) continue;
    const raridade = str(item.rarity);
    if (!raridade) continue;
    // Raridade desconhecida não entra no pool: sem a `order` não há como saber
    // qual é o degrau acima, e fundir sem saber o que sai é o palpite que este
    // módulo não dá.
    if (rarityOrder(catalog, raridade) === null) continue;
    const porSlot = pool[slot] || (pool[slot] = {});
    (porSlot[raridade] || (porSlot[raridade] = [])).push(item);
    total++;
  }

  for (const porSlot of Object.values(pool)) {
    for (const lista of Object.values(porSlot)) {
      lista.sort((a, b) => int(a.level) - int(b.level) || num(a.power) - num(b.power));
    }
  }

  const slots = {};
  for (const slot of activeSlots(cfg)) {
    const peca = equipado[slot] || null;
    slots[slot] = {
      slot,
      sigla: SLOT_BY_ID[slot],
      name: SLOT_NAMES[SLOT_BY_ID[slot]],
      current: brief(peca),
      level: peca ? int(peca.level) : 0,
      rarity: peca ? str(peca.rarity) : '',
      power: peca ? num(peca.power) : 0
    };
  }

  return { slots, pool, total, equipped: equipado };
}

// --------------------------------------------------------------- candidatos

/**
 * O ganho estimado de uma janela de insumos, contra a peça equipada.
 *
 * O problema é que a peça que sai da fusão **ainda não existe**: não há `power`
 * para ler. A estimativa é a única saída, e ela é construída sobre o fato de o
 * nível de saída ser o do insumo mais baixo — ou seja, a peça que sai é
 * essencialmente aquele insumo um degrau de raridade acima:
 *
 *     poder ≈ power(insumo mais baixo) × statMult(saída) / statMult(entrada)
 *
 * Quando o catálogo não traz `stat_mult`, a política é **permissiva**: um
 * degrau de raridade é assumido como melhoria desde que o nível de saída
 * alcance o da peça equipada. A alternativa — recusar — travaria a conta
 * inteira por um campo ausente do servidor, e a rede de segurança existe do
 * outro lado: `equip_best_preview` mede o ganho de verdade depois da fusão, e
 * uma forja sem ganho vira `forge.noGain` com recuo em vez de virar um laço.
 */
function windowGain({ catalog, janela, rarity, outRarity, current }) {
  const base = janela[0];
  const outLevel = int(base.level);
  const temPoder = num(current && current.power);
  const temNivel = int(current && current.level);

  const mIn = rarityMult(catalog, rarity);
  const mOut = rarityMult(catalog, outRarity);

  if (mIn > 0 && mOut > 0) {
    const estimado = num(base.power) * (mOut / mIn);
    return { outLevel, power: estimado, gain: estimado - temPoder, assumed: false };
  }

  // Sem multiplicador: o nível de saída decide. Slot vazio (`temNivel` 0) passa
  // sempre, que é o caso mais claro de melhoria que existe.
  return {
    outLevel,
    power: 0,
    gain: outLevel >= temNivel ? 1 : -1,
    assumed: true
  };
}

/**
 * O melhor candidato de um slot, ou `null`.
 *
 * A varredura é de janelas deslizantes sobre o pool ordenado por nível
 * crescente, e cada janela positiva vira um candidato. Achada uma, o cursor
 * **salta as cinco peças dela** em vez de deslizar de um: janelas sobrepostas
 * descreveriam fusões que disputam a mesma peça, e o lote teria de descartar
 * quase tudo o que encontrou.
 *
 * Varrer de baixo para cima continua sendo a política: a janela mais baixa é a
 * que gasta os níveis mais baratos, e as de cima ficam intactas para as fusões
 * seguintes. A diferença para a versão anterior é só que agora todas as janelas
 * do pool são oferecidas, e não apenas a primeira — uma conta com quarenta
 * raros num slot tem oito fusões prontas, e devolver uma delas por rodada
 * levava meia hora de relógio para gastar material que já estava na bolsa.
 *
 * O desperdício (`waste`) é a soma dos níveis que a janela joga fora, porque
 * tudo acima do menor nível é arrastado para baixo na saída. Entre candidatos
 * de ganho igual, é ele que desempata.
 */
function slotCandidates({ catalog, rules, slot, porRaridade, current }) {
  const saida = new Set(rules.outputSlots);
  if (saida.size && !saida.has(slot)) return [];

  const out = [];

  for (const [rarity, lista] of Object.entries(porRaridade || {})) {
    if (lista.length < rules.inputs) continue;
    const outRarity = rarityAbove(catalog, rarity);
    // A raridade mais alta do jogo não tem degrau acima: não há o que forjar
    // com ela, e ela também não deve ser moída.
    if (!outRarity) continue;

    // Exceção deliberada: uma lendária pode nascer de cinco épicos do mesmo
    // nível, desde que esse nível não seja inferior à lendária equipada. Sem
    // esta guarda a regra geral aceitaria janelas de níveis mistos e/ou abaixo
    // do equipamento, gastando cinco peças para não melhorar o slot.
    const isEpicToLegendary =
      str(current && current.rarity) === 'lendario'
      && rarity === 'epico'
      && outRarity === 'lendario';

    for (let k = 0; k + rules.inputs <= lista.length; k++) {
      const janela = lista.slice(k, k + rules.inputs);
      if (isEpicToLegendary) {
        const nivelEquipado = int(current && current.level);
        const nivel = int(janela[0] && janela[0].level);
        if (!nivel || nivel < nivelEquipado
          || janela.some(item => int(item.level) !== nivel)) continue;
      }
      const ganho = windowGain({ catalog, janela, rarity, outRarity, current });
      // Nesta exceção a decisão é explicitamente por nível, não pela estimativa
      // de poder: o servidor pode aplicar afixos que tornam a proporção de
      // `stat_mult` conservadora para uma lendária já muito forte.
      if (isEpicToLegendary && ganho.gain <= 0) {
        ganho.gain = 1;
        ganho.assumed = true;
      }
      if (ganho.gain <= 0) continue;
      // Positiva: consome as cinco e segue do fim delas. O `-1` compensa o
      // `k++` do laço.
      k += rules.inputs - 1;

      const outLevel = ganho.outLevel;
      out.push({
        slot,
        sigla: SLOT_BY_ID[slot],
        name: SLOT_NAMES[SLOT_BY_ID[slot]],
        slotSwap: false,
        inputRarity: rarity,
        rarity: outRarity,
        level: outLevel,
        inputs: rules.inputs,
        uids: janela.map(p => str(p.uid)),
        items: janela.map(brief),
        inputLevels: janela.map(p => int(p.level)),
        waste: janela.reduce((soma, p) => soma + (int(p.level) - outLevel), 0),
        gain: ganho.gain,
        estPower: ganho.power,
        assumed: ganho.assumed,
        current: current ? { ...current } : null,
        dustCost: Math.ceil(num(rules.dustCost[rarity])),
        goldKills: num(rules.goldKills[rarity])
      });
    }
  }

  return out;
}

/**
 * Todos os candidatos de todos os slots, do melhor para o pior.
 *
 * A ordem é a política de escolha quando duas fusões cabem no mesmo pó:
 *
 *   1. **maior ganho**. Pó é escasso e vem de peça destruída; gastá-lo no slot
 *      que mais rende é o único critério que o usuário aprovaria em todas as
 *      contas ao mesmo tempo.
 *   2. **menor desperdício de nível**, no empate. Entre duas fusões igualmente
 *      boas, a que preserva níveis altos deixa a conta mais perto da próxima.
 *   3. **menor custo de pó**, no empate restante.
 */
function candidates({ items, catalog = null, config, prof = null } = {}) {
  const cfg = normalizeConfig(config);
  const rules = readRules(catalog);
  if (!rules) return [];

  const retrato = prof || profile({ items, catalog, config: cfg });
  const out = [];

  for (const slot of activeSlots(cfg)) {
    const info = retrato.slots[slot];
    out.push(...slotCandidates({
      catalog,
      rules,
      slot,
      porRaridade: retrato.pool[slot],
      current: info ? info.current : null
    }));
  }

  return out.sort((a, b) =>
    b.gain - a.gain || a.waste - b.waste || a.dustCost - b.dustCost);
}

/**
 * O lote de fusões de uma rodada: quantas cabem ao mesmo tempo.
 *
 * Três restrições, e todas são de recurso compartilhado:
 *
 *   1. **peça**. Duas fusões não podem consumir o mesmo uid. As janelas já
 *      nascem disjuntas dentro de um slot, mas a lista vem ordenada por ganho e
 *      atravessa slots, então a verificação fica aqui, onde é barata e vale
 *      para todo mundo.
 *   2. **pó**. O orçamento é o saldo mais o que o sacrifício dirigido conseguir
 *      levantar; quem não couber fica para a rodada seguinte.
 *   3. **teto**. `maxFusions`, para a rodada não derreter a bolsa inteira num
 *      gesto só.
 *
 * Em ordem de ganho: se o pó só dá para três das oito, que sejam as três que
 * mais rendem.
 *
 * O ganho de cada candidato foi medido contra a peça **equipada hoje**, e duas
 * fusões no mesmo slot são as duas medidas contra a mesma referência. Isso é
 * otimista de propósito: a segunda provavelmente rende menos do que o número
 * diz, mas ela sai do mesmo material que ficaria parado, e `equip_best` no fim
 * da rodada escolhe a melhor das duas de qualquer forma.
 */
function batch({ candidates: lista, config, budget = 0 } = {}) {
  const cfg = normalizeConfig(config);
  const escolhidos = [];
  const tomados = new Set();
  let saldo = Math.max(0, num(budget));

  for (const c of arr(lista)) {
    if (escolhidos.length >= cfg.maxFusions) break;
    const uids = arr(c.uids).map(String);
    if (uids.some(u => tomados.has(u))) continue;
    const custo = Math.ceil(num(c.dustCost));
    if (custo > saldo) continue;
    saldo -= custo;
    for (const u of uids) tomados.add(u);
    escolhidos.push(c);
  }

  return escolhidos;
}

/**
 * Os slots em que a bolsa já tem peça melhor do que a equipada.
 *
 * Existe para a rodada **não forjar** nesses slots: equipar o que já está na
 * bolsa é de graça, e fundir para substituir uma peça que ia ser substituída de
 * graça seria queimar cinco peças por nada. Quem decide de verdade é
 * `equip_best` no servidor; isto é só a pista de que vale pedir.
 */
function equipFirstSlots({ items, catalog = null, config, prof = null } = {}) {
  const cfg = normalizeConfig(config);
  const retrato = prof || profile({ items, catalog, config: cfg });
  const out = [];

  for (const slot of activeSlots(cfg)) {
    const info = retrato.slots[slot];
    if (!info) continue;
    const atual = num(info.power);
    const porSlot = retrato.pool[slot] || {};
    let melhor = 0;
    for (const lista of Object.values(porSlot)) {
      for (const p of lista) melhor = Math.max(melhor, num(p.power));
    }
    if (melhor > atual) out.push(slot);
  }

  return out;
}

// ----------------------------------------------------------------- desmonte

/**
 * O lixo: tudo até o teto de raridade, moído no **começo** da rodada.
 *
 * Esta é a primeira coisa que acontece, e é a inversão deliberada em relação à
 * primeira versão. O raciocínio é simples: fusão custa pó, pó só vem de
 * desmonte, e comum e incomum não servem para mais nada. Deixá-las para o fim
 * da rodada fazia a fusão falhar por falta de pó que estava na bolsa o tempo
 * todo, em forma de lixo.
 */
function junkCandidates({ items, catalog = null, config, exclude } = {}) {
  const cfg = normalizeConfig(config);
  const teto = junkCeiling(catalog, cfg);
  if (teto === null) return [];

  const keep = new Set(cfg.keep);
  const fora = exclude instanceof Set ? exclude : new Set(arr(exclude).map(String));

  return arr(items)
    .filter(item => touchable(item, keep))
    // Só equipamento. O desmonte do jogo recusa material, gema e consumível
    // com `item.notAllowed`, e a bolsa está cheia de coisa comum que não é
    // peça. Sem catálogo `itemSlot` devolve 0 e nada é moído — o lado seguro.
    .filter(item => itemSlot(item, catalog))
    .filter(item => !fora.has(str(item.uid)))
    .filter(item => {
      const ordem = rarityOrder(catalog, item.rarity);
      // Raridade desconhecida nunca é desmontada: sem a ordem não há como
      // provar que ela está abaixo do teto, e o erro aqui apaga a peça.
      return ordem !== null && ordem <= teto;
    })
    .sort((a, b) => {
      const ra = rarityOrder(catalog, a.rarity) - rarityOrder(catalog, b.rarity);
      if (ra) return ra;
      return num(a.power) - num(b.power);
    })
    .slice(0, cfg.maxDismantle)
    .map(brief);
}

/**
 * O desmonte **dirigido**: as peças acima do lixo que precisam morrer para a
 * fusão escolhida sair, e nenhuma a mais.
 *
 * Três regras, e todas vêm de o nível de saída ser o menor insumo:
 *
 *   1. peça de nível **abaixo** do nível de saída é a primeira a ir. Ela nunca
 *      serviria de insumo — entrar numa janela arrastaria a saída para o nível
 *      dela.
 *   2. peça de nível **igual** ao de saída, excedente das cinco escolhidas, vai
 *      depois. Ela serviria, mas há de sobra.
 *   3. peça de nível **acima** nunca vai. É insumo da fusão seguinte, a que vai
 *      levar este slot mais alto ainda; moê-la agora é trocar o degrau de
 *      amanhã pelo de hoje.
 *
 * E a conta para no primeiro item que cobre o que falta. Se nem esgotando (1) e
 * (2) o pó fecha, **nada é desmontado**: moer pela metade destruiria peça sem
 * produzir fusão nenhuma.
 *
 * Com lote, as três regras valem para o **conjunto**: o que falta é a soma dos
 * custos, as peças de todas as janelas estão protegidas, e as duas fronteiras —
 * nível de saída e raridade de insumo — são as **mais estritas** do lote. A
 * regra mais apertada manda porque moer algo que serviria de insumo a qualquer
 * uma das fusões escolhidas desmancharia o próprio lote.
 */
function dustSacrifice({
  items, catalog = null, config, candidate = null, candidates: lote = null,
  dust = 0, rules = null
} = {}) {
  const cfg = normalizeConfig(config);
  const regras = rules || readRules(catalog);
  const vazio = { need: 0, got: 0, uids: [], items: [], ok: true };

  const alvos = arr(lote).length ? arr(lote) : (candidate ? [candidate] : []);
  if (!regras || !alvos.length) return vazio;

  const custo = alvos.reduce((soma, c) => soma + Math.ceil(num(c.dustCost)), 0);
  const falta = Math.max(0, custo - Math.max(0, int(dust)));
  if (!falta) return vazio;

  const keep = new Set(cfg.keep);
  const naJanela = new Set();
  for (const c of alvos) for (const u of arr(c.uids)) naJanela.add(String(u));

  const tetoLixo = junkCeiling(catalog, cfg);

  // A fronteira mais estrita do lote, nos dois eixos.
  let ordemInsumo = null;
  let outLevel = 0;
  for (const c of alvos) {
    const ordem = rarityOrder(catalog, c.inputRarity);
    if (ordem !== null) ordemInsumo = ordemInsumo === null ? ordem : Math.min(ordemInsumo, ordem);
    outLevel = outLevel ? Math.min(outLevel, int(c.level)) : int(c.level);
  }

  const fila = [];
  for (const item of arr(items)) {
    if (!touchable(item, keep)) continue;
    if (naJanela.has(str(item.uid))) continue;
    if (!itemSlot(item, catalog)) continue; // só equipamento, como no lixo.
    const ordem = rarityOrder(catalog, item.rarity);
    if (ordem === null) continue;
    // O lixo já foi moído no começo da rodada: contá-lo aqui prometeria um pó
    // que a bolsa não tem mais.
    if (tetoLixo !== null && ordem <= tetoLixo) continue;
    // Nunca acima da raridade que a fusão consome: moer uma lendária para
    // forjar uma épica é destruir o melhor para fazer o pior.
    if (ordemInsumo !== null && ordem > ordemInsumo) continue;

    const nivel = int(item.level);
    let faixa;
    if (nivel < outLevel) faixa = 1;
    else if (nivel === outLevel) faixa = 2;
    else continue; // regra 3: nível acima é insumo de amanhã.

    fila.push({ item, faixa, nivel, ordem, dust: num(regras.dustPerRarity[str(item.rarity)]) });
  }

  // Faixa primeiro, depois raridade mais baixa, depois nível mais baixo: a
  // peça mais descartável morre antes.
  fila.sort((a, b) => a.faixa - b.faixa || a.ordem - b.ordem || a.nivel - b.nivel
    || num(a.item.power) - num(b.item.power));

  const escolhidos = [];
  let somado = 0;
  for (const linha of fila) {
    if (somado >= falta) break;
    if (escolhidos.length >= cfg.maxDismantle) break;
    if (linha.dust <= 0) continue;
    escolhidos.push(linha.item);
    somado += linha.dust;
  }

  if (somado < falta) {
    return { need: falta, got: Math.floor(somado), uids: [], items: [], ok: false };
  }

  return {
    need: falta,
    got: Math.floor(somado),
    uids: escolhidos.map(p => str(p.uid)),
    items: escolhidos.map(brief),
    ok: true
  };
}

// ------------------------------------------------------------------- plano

/**
 * O que fazer com esta conta, agora.
 *
 * Função pura: recebe o inventário lido, a configuração e o catálogo, devolve a
 * rodada. Quem envia é o serviço.
 *
 * A ordem dos campos do retorno é a ordem de execução, e ela importa:
 *
 *   1. `junk` — moer comuns e incomuns. **Primeiro**, porque é de onde vem o pó
 *      que paga tudo o que vem depois.
 *   2. `equipFirst` — se a bolsa já tem peça melhor, vesti-la é de graça.
 *   3. `fusions` — o lote, em ordem de ganho. `fuse` é a primeira delas, mantido
 *      para quem só precisa saber o que a rodada vai fazer de mais importante.
 *   4. `sacrifice` — só se faltar pó para (3), e só o necessário.
 *
 * @param {object} input
 * @param {object} [input.config]
 * @param {number} [input.index] Índice da conta, para a lista de exceções.
 * @param {object} [input.catalog] Recorte de `leveling-market-catalog`.
 * @param {Array}  [input.items] Saída de `inventoryItems`, escopo da bolsa.
 * @param {number} [input.dust] Saldo de pó arcano.
 * @returns {{ok:boolean, reason:string, junk:Array, fuse:object|null,
 *            fusions:Array, sacrifice:object, equipFirst:Array,
 *            candidates:Array, rules:object|null}}
 */
function plan({ config, index = 0, catalog = null, items = [], dust = 0 } = {}) {
  const cfg = normalizeConfig(config);
  const vazio = {
    ok: false, reason: '', junk: [], fuse: null, fusions: [],
    sacrifice: { need: 0, got: 0, uids: [], items: [], ok: true },
    equipFirst: [], candidates: [], rules: null
  };

  if (!cfg.enabled) return { ...vazio, reason: 'forge.off' };
  if (cfg.disabled.includes(int(index, -1))) return { ...vazio, reason: 'forge.accountOff' };

  const rules = readRules(catalog);
  if (!rules) return { ...vazio, reason: 'forge.noRules' };
  if (cfg.dismantleUpTo && rarityOrder(catalog, cfg.dismantleUpTo) === null) {
    return { ...vazio, reason: 'forge.badRarity', rules };
  }

  const retrato = profile({ items, catalog, config: cfg });
  const lista = candidates({ items, catalog, config: cfg, prof: retrato });
  const equipar = equipFirstSlots({ items, catalog, config: cfg, prof: retrato });

  // Slot com peça melhor parada na bolsa não funde nesta rodada: vesti-la é de
  // graça e muda a referência contra a qual o ganho seria medido. Antes isso
  // abortava a rodada inteira; agora só tira aquele slot da lista, porque os
  // outros sete não têm nada a ver com o guarda-roupa deste.
  // Se o usuário desligou `equipBest`, não há tentativa de vestir que possa
  // justificar bloquear a fusão. O slot continua elegível para forja.
  const foraDoEquipar = cfg.equipBest ? new Set(equipar) : new Set();

  // O teto de desmonte não pode alcançar a raridade que a melhor fusão
  // consome: seria moer o próprio material. Recusa em vez de cortar a lista em
  // silêncio — o usuário configurou duas coisas que se contradizem, e só ele
  // resolve. Só vale para o teto **escolhido à mão**: o padrão de duas
  // raridades nunca alcança um insumo que valha a pena.
  //
  // Medido contra a lista inteira, antes do filtro de `equipFirst`: a
  // contradição é de configuração, e ela não deixa de existir porque o slot da
  // vez tem peça melhor na bolsa.
  if (cfg.dismantleUpTo && lista.length) {
    const teto = rarityOrder(catalog, cfg.dismantleUpTo);
    const insumo = rarityOrder(catalog, lista[0].inputRarity);
    if (teto !== null && insumo !== null && teto >= insumo) {
      return { ...vazio, reason: 'forge.dismantleClash', rules, candidates: lista };
    }
  }

  const elegiveis = lista.filter(c => !foraDoEquipar.has(c.slot));
  const melhor = elegiveis[0] || null;

  if (!melhor) {
    const junkSo = junkCandidates({ items, catalog, config: cfg });
    const reason = equipar.length
      ? 'forge.equipFirst'
      : (retrato.total ? 'forge.noPositiveWindow' : 'forge.noInputs');
    return {
      ...vazio,
      ok: !!junkSo.length || !!equipar.length,
      reason,
      rules,
      junk: junkSo,
      equipFirst: equipar,
      candidates: lista
    };
  }

  // O lote pelo que o saldo paga agora. Se o saldo não paga nem a primeira, o
  // lote vira a melhor sozinha e o sacrifício dirigido cobre a diferença — é o
  // caminho da conta sem pó, que é justamente a que precisa forjar.
  let lote = batch({ candidates: elegiveis, config: cfg, budget: dust });
  if (!lote.length) lote = [melhor];

  // Quem não couber no pó sai pelo fim, que é o de menor ganho. Truncar em vez
  // de recusar é o que mantém a rodada produtiva: quatro fusões pagas valem
  // mais do que cinco impossíveis.
  let sacrifice = dustSacrifice({ items, catalog, config: cfg, candidates: lote, dust, rules });
  while (!sacrifice.ok && lote.length > 1) {
    lote = lote.slice(0, -1);
    sacrifice = dustSacrifice({ items, catalog, config: cfg, candidates: lote, dust, rules });
  }

  // Os uids das fusões escolhidas ficam de fora do lixo. Na prática o lixo é de
  // raridade baixa e a fusão de raridade alta, mas depender disso deixaria a
  // correção num só lugar — e um teto escolhido à mão muda o que é lixo.
  const usados = new Set();
  for (const c of lote) for (const u of c.uids) usados.add(String(u));
  const junk = junkCandidates({ items, catalog, config: cfg, exclude: usados });

  if (!sacrifice.ok) {
    // Sem pó e sem como obtê-lo: a fusão sai do plano, mas o lixo continua —
    // moê-lo é exatamente o que aproxima a conta de poder forjar na rodada
    // seguinte.
    return {
      ...vazio,
      ok: !!junk.length,
      reason: 'forge.noDust',
      rules,
      junk,
      equipFirst: equipar,
      candidates: lista,
      sacrifice
    };
  }

  return {
    ok: true,
    reason: '',
    junk,
    fuse: lote[0],
    fusions: lote,
    sacrifice,
    equipFirst: equipar,
    candidates: lista,
    rules
  };
}

// ------------------------------------------------------------------ estudo

/**
 * O que esta conta consegue fazer agora, em números.
 *
 * Deixou de ser "quanto custa fechar o alvo" e passou a ser "quantos slots dá
 * para melhorar e com o que". A diferença é a mesma do resto desta versão: não
 * há alvo, há o que a conta tem.
 */
function estimate({ config, catalog = null, items = [], dust = 0 } = {}) {
  const cfg = normalizeConfig(config);
  const rules = readRules(catalog);
  const saldo = Math.max(0, int(dust));
  const vazio = {
    ready: false, reason: '', slots: activeSlots(cfg).length,
    upgradable: 0, possible: 0, affordable: 0, dustForBatch: 0,
    equipFirst: 0, forgeableNow: 0,
    best: null, pieces: 0,
    dustHave: saldo, dustNeeded: 0, dustFromJunk: 0, junkPieces: 0
  };

  if (!rules) return { ...vazio, reason: 'forge.noRules' };

  const retrato = profile({ items, catalog, config: cfg });
  const lista = candidates({ items, catalog, config: cfg, prof: retrato });

  // O que o desmonte de lixo renderia. Entra no estudo porque é a única receita
  // de pó que a automação tem: sem ele o usuário leria "preciso de 900 de pó"
  // sem saber de onde ele sairia.
  const teto = junkCeiling(catalog, cfg);
  const keep = new Set(cfg.keep);
  let rende = 0;
  let pecasLixo = 0;
  if (teto !== null) {
    for (const item of arr(items)) {
      if (!touchable(item, keep)) continue;
      const ordem = rarityOrder(catalog, item.rarity);
      if (ordem === null || ordem > teto) continue;
      rende += num(rules.dustPerRarity[str(item.rarity)]);
      pecasLixo++;
    }
  }

  const melhor = lista[0] || null;
  const porSlot = new Set(lista.map(c => c.slot));
  const equipFirstSlotsSet = new Set(equipFirstSlots({ items, catalog, config: cfg, prof: retrato }));
  const equipFirstCount = [...equipFirstSlotsSet].filter(slot => porSlot.has(slot)).length;

  // O lote que o pó de hoje paga, e o que ele custaria inteiro. A diferença
  // entre `ready` e `affordable` é o que o usuário precisa ver para entender
  // por que a rodada não fundiu tudo o que a bolsa permitiria.
  const lote = batch({ candidates: lista, config: cfg, budget: saldo });
  const custoTotal = lista
    .slice(0, cfg.maxFusions)
    .reduce((soma, c) => soma + Math.ceil(num(c.dustCost)), 0);

  return {
    ready: true,
    reason: '',
    slots: activeSlots(cfg).length,
    upgradable: porSlot.size,
    equipFirst: equipFirstCount,
    forgeableNow: Math.max(0, [...porSlot].filter(slot => !equipFirstSlotsSet.has(slot)).length),
    possible: Math.min(lista.length, cfg.maxFusions),
    affordable: lote.length,
    dustForBatch: custoTotal,
    best: melhor
      ? {
        slot: melhor.slot,
        name: melhor.name,
        rarity: melhor.rarity,
        inputRarity: melhor.inputRarity,
        level: melhor.level,
        inputLevels: melhor.inputLevels,
        waste: melhor.waste,
        assumed: melhor.assumed,
        dustCost: melhor.dustCost,
        goldKills: melhor.goldKills,
        current: melhor.current
      }
      : null,
    pieces: retrato.total,
    dustHave: saldo,
    dustNeeded: melhor ? melhor.dustCost : 0,
    dustFromJunk: Math.floor(rende),
    junkPieces: pecasLixo
  };
}

/**
 * Resumo de uma conta para a janela: o que cada slot tem hoje, o que daria para
 * fazer nele, e o custo disso.
 */
function summarize({ config, index = 0, catalog = null, items = [], dust = 0, level = 0 } = {}) {
  const cfg = normalizeConfig(config);
  const retrato = profile({ items, catalog, config: cfg });
  const lista = candidates({ items, catalog, config: cfg, prof: retrato });
  const equipar = new Set(equipFirstSlots({ items, catalog, config: cfg, prof: retrato }));

  const melhorPorSlot = new Map();
  const quantasPorSlot = new Map();
  for (const c of lista) {
    if (!melhorPorSlot.has(c.slot)) melhorPorSlot.set(c.slot, c);
    quantasPorSlot.set(c.slot, (quantasPorSlot.get(c.slot) || 0) + 1);
  }

  const slots = activeSlots(cfg).map(slot => {
    const info = retrato.slots[slot] || {};
    const cand = melhorPorSlot.get(slot) || null;
    const porSlot = retrato.pool[slot] || {};
    const estoque = Object.entries(porSlot)
      .map(([rarity, lista2]) => ({
        rarity,
        rarityName: rarityName(catalog, rarity),
        count: lista2.length,
        levels: lista2.map(p => int(p.level))
      }))
      .sort((a, b) => (rarityOrder(catalog, a.rarity) || 0) - (rarityOrder(catalog, b.rarity) || 0));

    return {
      slot,
      sigla: info.sigla || SLOT_BY_ID[slot],
      name: info.name || SLOT_NAMES[SLOT_BY_ID[slot]],
      level: int(info.level),
      rarity: str(info.rarity),
      power: num(info.power),
      stock: estoque,
      equipFirst: equipar.has(slot),
      // Quantas fusões este slot tem prontas. O usuário com trinta raros numa
      // arma precisa ver "6", e não só a próxima.
      ready: quantasPorSlot.get(slot) || 0,
      candidate: cand
        ? {
          rarity: cand.rarity,
          inputRarity: cand.inputRarity,
          level: cand.level,
          inputLevels: cand.inputLevels,
          waste: cand.waste,
          gain: cand.gain,
          assumed: cand.assumed,
          dustCost: cand.dustCost,
          goldKills: cand.goldKills
        }
        : null,
      // Verde é "nada a fazer aqui", e agora isso significa duas coisas de uma
      // vez: não há fusão que melhore e não há peça melhor parada na bolsa.
      ok: !cand && !equipar.has(slot)
    };
  });

  return {
    index: int(index),
    level: int(level),
    enabled: accountEnabled(cfg, index),
    slots,
    dust: Math.max(0, int(dust)),
    equipFirst: equipar.size,
    forgeableNow: Math.max(0, lista.length - equipar.size),
    estimate: estimate({ config: cfg, catalog, items, dust })
  };
}

module.exports = {
  defaultConfig,
  normalizeConfig,
  isConfigured,
  accountEnabled,
  activeSlots,
  readRules,
  hasRules,
  rarityList,
  rarityOrder,
  rarityBelow,
  rarityAbove,
  rarityMult,
  rarityName,
  junkCeiling,
  slotId,
  slotSigla,
  slotName,
  itemSlot,
  touchable,
  equippedBySlot,
  profile,
  candidates,
  batch,
  equipFirstSlots,
  junkCandidates,
  dustSacrifice,
  plan,
  estimate,
  summarize,
  SLOTS,
  SLOT_ORDER,
  SLOT_BY_ID,
  SLOT_NAMES,
  DEFAULT_FUSION_INPUTS,
  DEFAULT_JUNK_TIERS,
  DEFAULT_MAX_DISMANTLE,
  DEFAULT_MAX_FUSIONS,
  BACKOFF_MS,
  MIN_GAP_MS,
  LOG_MAX
};
