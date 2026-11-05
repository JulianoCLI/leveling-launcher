/**
 * @file leveling-stats.js
 * Regras do auto-status: quais atributos receber os pontos livres de cada
 * nível. Decide, não envia.
 *
 * Mesma separação de `leveling-boss.js` e `leveling-refill.js`: aqui mora a
 * parte que precisa de teste — "estes pesos e estes pontos livres dão qual
 * divisão?" — e nada de socket, de relógio global ou de estado mutável.
 *
 * O pedido que este módulo atende, em uma frase: **gastar os 5 pontos de cada
 * nível do jeito que a build da classe gastaria, sem o usuário abrir o jogo**.
 *
 * ## Por que a conta é copiada do jogo, e não inventada
 *
 * Alocar ponto é irreversível: desfazer custa token de respec ou cristal. Uma
 * fórmula só parecida com a do botão "Distribuir pela build" gastaria pontos de
 * verdade numa divisão que o jogador não escolheu. Então `planAlocacao` é uma
 * transcrição da função do bundle publicado, extraída por
 * `tools/leveling-extract-build-math.js`. O original, desminificado:
 *
 * ```js
 * function distribuir(weights, allocated, free) {
 *   const r = weights.filter(w => w.points > 0);
 *   const i = r.reduce((s, w) => s + w.points, 0);
 *   if (free <= 0 || i <= 0) return [];
 *   const a = (allocated ?? []).reduce((s, w) => s + w.points, 0) + free;
 *   const o = r.map(w => Math.max(0, a * w.points / i - pontosDe(allocated, w.stat)));
 *   const s = o.reduce((x, y) => x + y, 0);
 *   const c = s > 0 ? o : r.map(w => w.points);
 *   const l = s > 0 ? s : i;
 *   const u = c.map(x => free * x / l);
 *   const d = u.map(Math.floor);
 *   let f = free - d.reduce((x, y) => x + y, 0);
 *   const p = u.map((_, k) => k).sort((x, y) => (u[y] - d[y]) - (u[x] - d[x]));
 *   for (const k of p) { if (f <= 0) break; d[k]++; f--; }
 *   return r.map((w, k) => ({ stat: w.stat, points: d[k] })).filter(e => e.points > 0);
 * }
 * ```
 *
 * Lido em português, são quatro decisões:
 *
 *   - **o alvo é proporcional ao total investido depois de gastar** (`a`), não
 *     ao que já existe. Uma build 40% INT mira 40% de `investido + livres`.
 *   - **a base é `allocated`, não `total`**. O que a classe dá de graça
 *     (`class_base`) e o que vem de equipamento (`from_items`) ficam fora — é o
 *     que a descrição da build "Rajada Arcana" diz com todas as letras: *"a
 *     Inteligência inicial da classe não conta"*.
 *   - **só o déficit recebe**. Atributo já acima do alvo recebe zero; o ponto
 *     dele vai para quem está atrás.
 *   - **se ninguém tem déficit** (`s === 0`, caso de uma build já cumprida), a
 *     divisão cai nos pesos crus. Sem isso a função devolveria vazio e os
 *     pontos ficariam parados para sempre.
 *
 * O resto é repartição por maior resto: piso para todos, e a sobra vai para as
 * maiores frações, o que garante que a soma devolvida seja **exatamente** os
 * pontos livres. Nunca mais, nunca menos.
 *
 * ## O que este módulo não faz
 *
 * Não reseta. `reset_stats` fica fora do launcher: custa recurso e o auto-status
 * só gasta o que está livre, nunca realoca o que já foi gasto.
 */

'use strict';

/**
 * Os cinco atributos, nos números do enum `StatId` de `common.proto`.
 *
 * O enum é aninhado, e o `verify` do protobufjs recusa nome em campo de enum
 * com escopo — mesmo motivo de `MARKET_KIND_NUM` e `FRIEND_KIND` no serviço.
 * Então o que trafega é número.
 *
 * Atenção ao buraco: 4 e 5 não existem, INT é 6 e PER é 7. Derivar o número da
 * posição na lista daria INT=4 e erraria calado.
 */
const STATS = Object.freeze({ STR: 1, AGI: 2, VIT: 3, INT: 6, PER: 7 });

/** Ordem de exibição, a mesma da tela de atributos do jogo. */
const STAT_ORDER = Object.freeze(['STR', 'AGI', 'PER', 'VIT', 'INT']);

/** Do número do enum de volta para a sigla. */
const STAT_BY_ID = Object.freeze(
  Object.fromEntries(Object.entries(STATS).map(([k, v]) => [v, k]))
);

/** Pontos por nível, se o catálogo não informar `stat_points_per_level`. */
const DEFAULT_POINTS_PER_LEVEL = 5;

/**
 * Recuo depois de uma recusa do servidor, em milissegundos.
 *
 * Alocação é disparada por mudança de estado, não por relógio: sem recuo, uma
 * recusa que mantém `stat_points > 0` faria o próximo `character_patch` tentar
 * de novo, e o patch seguinte, e assim por diante.
 */
const BACKOFF_MS = 60000;

/** Teto de espera pelo `allocate_stats_result`. */
const RESULT_TIMEOUT_MS = 15000;

/** Linhas guardadas no relatório. */
const LOG_MAX = 300;

const arr = v => (Array.isArray(v) ? v : []);
const int = (value, fallback = 0) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : fallback;
};
const str = v => (typeof v === 'string' ? v.trim() : '');

/**
 * O número do enum para o que vier: número, sigla, ou o nome completo.
 *
 * O nome completo existe porque o codec desserializa com `enums: String`: todo
 * `StatAmount` que **chega** do servidor traz `stat: 'STAT_ID_INT'`, nunca 6.
 * Só o que **sai** daqui usa número, porque o `verify` recusa o nome em campo
 * de enum com escopo. As duas pontas falam formas diferentes, e é esta função
 * que as junta.
 */
function statId(value) {
  if (typeof value === 'number') return STATS[STAT_BY_ID[value]] || 0;
  const texto = str(value).toUpperCase();
  if (!texto) return 0;
  const sigla = texto.startsWith('STAT_ID_') ? texto.slice('STAT_ID_'.length) : texto;
  return STATS[sigla] || 0;
}

/** A sigla para qualquer das três formas, ou string vazia. */
function statSigla(value) {
  return STAT_BY_ID[statId(value)] || '';
}

/**
 * Quantos pontos uma lista `StatAmount[]` tem num atributo.
 *
 * Equivale ao `Xt` do bundle. Proto3 omite o campo zero, então um atributo sem
 * ponto nenhum simplesmente não aparece na lista — ausência é zero, não erro.
 */
function pontosDe(lista, stat) {
  const id = statId(stat);
  if (!id) return 0;
  for (const item of arr(lista)) {
    if (!item) continue;
    if (statId(item.stat) === id) return Math.max(0, int(item.points));
  }
  return 0;
}

/**
 * Normaliza `StatAmount[]` do servidor para `{ STR, AGI, PER, VIT, INT }`.
 * As cinco chaves sempre existem, com zero onde o proto omitiu.
 */
function lerStatAmounts(lista) {
  const out = {};
  for (const sigla of STAT_ORDER) out[sigla] = pontosDe(lista, sigla);
  return out;
}

// ------------------------------------------------------------------ catálogo

/**
 * Extrai do `content_catalog` só as classes e suas builds.
 *
 * O catálogo passa de 1 MB por login e o monitor não pode guardá-lo: aqui ele é
 * lido uma vez e sobram alguns kilobytes. Mesmo motivo e mesma forma de
 * `leveling-hunts.readHuntCatalog` e `leveling-refill.readCatalog`.
 *
 * @param {object} value `ContentCatalog` desserializado.
 * @returns {{classes:object, pointsPerLevel:number}}
 *   `classes` é indexado por `class_id`.
 */
function readClassCatalog(value) {
  const safe = value || {};
  const classes = {};

  for (const def of arr(safe.classes)) {
    if (!def || !def.id) continue;
    const builds = [];
    for (const b of arr(def.builds)) {
      if (!b || !b.id) continue;
      const pesos = lerStatAmounts(b.weights);
      // Build sem nenhum peso positivo não distribui nada: o próprio jogo
      // devolveria lista vazia. Guardá-la só encheria a tela de opção morta.
      if (!STAT_ORDER.some(s => pesos[s] > 0)) continue;
      builds.push({
        id: str(b.id),
        name: str(b.name) || str(b.id),
        description: str(b.description),
        pesos
      });
    }
    classes[def.id] = {
      id: str(def.id),
      name: str(def.name) || str(def.id),
      icon: str(def.icon),
      usesMagic: !!def.uses_magic,
      initialStats: lerStatAmounts(def.initial_stats),
      builds
    };
  }

  const regras = safe.rules || {};
  return {
    classes,
    pointsPerLevel: int(regras.stat_points_per_level, DEFAULT_POINTS_PER_LEVEL)
      || DEFAULT_POINTS_PER_LEVEL
  };
}

/** O catálogo tem o mínimo para a tela montar um seletor de build? */
function hasClasses(catalog) {
  return !!catalog && Object.keys(catalog.classes || {}).length > 0;
}

/** A classe pedida, ou `null`. */
function classeDe(catalog, classId) {
  const id = str(classId);
  if (!id || !catalog) return null;
  return (catalog.classes || {})[id] || null;
}

/** A build pedida dentro da classe, ou `null`. */
function buildDe(catalog, classId, buildId) {
  const classe = classeDe(catalog, classId);
  if (!classe) return null;
  const id = str(buildId);
  if (!id) return null;
  return classe.builds.find(b => b.id === id) || null;
}

/**
 * A build que vale para uma conta sem escolha própria: a **primeira** da classe.
 *
 * O catálogo lista as builds na ordem em que o jogo as mostra, e a primeira é a
 * de dano puro da classe — a escolha que serve à maioria das contas de monitor.
 */
function buildPadrao(catalog, classId) {
  const classe = classeDe(catalog, classId);
  return classe && classe.builds.length ? classe.builds[0] : null;
}

// ------------------------------------------------------------- configuração

/**
 * Configuração vazia: **desligada**.
 *
 * Alocar ponto não tem volta sem pagar respec. Ligar isso sozinho gastaria, na
 * primeira subida de nível, pontos que o usuário talvez guardasse de propósito.
 */
function defaultConfig() {
  return { enabled: false, disabled: [], porConta: {} };
}

/**
 * Normaliza os pesos vindos da tela.
 *
 * O jogador digita o que quiser; o que importa é a **proporção**, porque a
 * fórmula divide cada peso pela soma. Então nada é reescalado para 100 aqui —
 * seria uma divisão a mais com erro de arredondamento e nenhum ganho.
 */
function normalizePesos(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const sigla of STAT_ORDER) {
    out[sigla] = Math.max(0, Math.min(1000, int(source[sigla], 0)));
  }
  return out;
}

/** A escolha de uma conta, ou `null` se o que veio não descreve nada. */
function normalizeConta(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const modo = source.modo === 'custom' ? 'custom' : 'build';

  if (modo === 'custom') {
    const pesos = normalizePesos(source.pesos);
    // Pesos todos em zero não distribuem nada. Vira `null` para a conta cair no
    // padrão da classe, em vez de ficar ligada sem fazer nada em silêncio.
    if (!STAT_ORDER.some(s => pesos[s] > 0)) return null;
    return { modo: 'custom', buildId: '', pesos };
  }

  return { modo: 'build', buildId: str(source.buildId), pesos: normalizePesos(source.pesos) };
}

/**
 * Normaliza o que vem do disco ou da tela.
 *
 * As contas são listadas pelo que está **desligado**, não pelo que está ligado,
 * pela mesma razão do boss e da expedição: uma aba nova traz contas novas, e uma
 * lista de permissões as deixaria de fora em silêncio.
 *
 * `porConta` é a exceção ao padrão de "uma configuração para todas": classe e
 * build são por personagem, não há um valor global que sirva. Conta sem entrada
 * usa a primeira build da classe dela.
 */
function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};

  const lista = Array.isArray(source.disabled) ? source.disabled : [];
  const disabled = [...new Set(lista.map(i => int(i, -1)).filter(i => i >= 0))]
    .sort((a, b) => a - b);

  const porConta = {};
  const bruto = source.porConta && typeof source.porConta === 'object' ? source.porConta : {};
  for (const [chave, valor] of Object.entries(bruto)) {
    const idx = int(chave, -1);
    if (idx < 0) continue;
    const conta = normalizeConta(valor);
    if (conta) porConta[String(idx)] = conta;
  }

  return { enabled: !!source.enabled, disabled, porConta };
}

/** Vale ligar o gatilho? */
function isConfigured(config) {
  return normalizeConfig(config).enabled;
}

/** Esta conta participa? */
function accountEnabled(config, index) {
  const cfg = normalizeConfig(config);
  if (!cfg.enabled) return false;
  return !cfg.disabled.includes(int(index, -1));
}

/**
 * Os pesos que valem para uma conta, e de onde vieram.
 *
 * @returns {{pesos:object, origem:'custom'|'build'|'padrao', buildId:string,
 *            buildName:string, reason:string}}
 *   `reason` vem preenchido quando não há pesos — a tela e o relatório dizem o
 *   porquê em vez de mostrar uma conta parada sem explicação.
 */
function pesosDaConta(config, index, classId, catalog) {
  const cfg = normalizeConfig(config);
  const escolha = cfg.porConta[String(int(index, -1))] || null;
  const vazio = { pesos: null, origem: '', buildId: '', buildName: '', reason: '' };

  if (escolha && escolha.modo === 'custom') {
    return { pesos: escolha.pesos, origem: 'custom', buildId: '', buildName: '', reason: '' };
  }

  if (!str(classId)) return { ...vazio, reason: 'stats.noClass' };
  if (!hasClasses(catalog)) return { ...vazio, reason: 'stats.noCatalog' };

  if (escolha && escolha.buildId) {
    const build = buildDe(catalog, classId, escolha.buildId);
    // A build escolhida pode ter sumido num deploy do jogo. Cair no padrão
    // calado trocaria a divisão sem avisar, então isso é um motivo, não um
    // fallback.
    if (!build) return { ...vazio, reason: 'stats.buildGone' };
    return {
      pesos: build.pesos, origem: 'build',
      buildId: build.id, buildName: build.name, reason: ''
    };
  }

  const padrao = buildPadrao(catalog, classId);
  if (!padrao) return { ...vazio, reason: 'stats.noBuild' };
  return {
    pesos: padrao.pesos, origem: 'padrao',
    buildId: padrao.id, buildName: padrao.name, reason: ''
  };
}

// --------------------------------------------------------------- a fórmula

/**
 * Divide `livres` pontos entre os atributos, do mesmo jeito que o botão
 * "Distribuir pela build" do jogo.
 *
 * Transcrição de `eM(weights, allocated, free)` do bundle; o original está no
 * cabeçalho deste arquivo. Os nomes mudaram, a ordem das operações não.
 *
 * @param {object} input
 * @param {object} input.pesos `{ STR, AGI, PER, VIT, INT }`, proporção livre.
 * @param {object} [input.allocated] O já investido, mesmas chaves. **Não** o
 *   total: base de classe e bônus de item ficam de fora.
 * @param {number} input.livres Pontos a gastar.
 * @returns {Array<{stat:string, statId:number, points:number}>}
 *   Soma dos `points` é exatamente `livres`. Atributos que não recebem nada
 *   saem da lista.
 */
function planAlocacao({ pesos, allocated, livres } = {}) {
  const livre = int(livres, 0);
  const peso = normalizePesos(pesos);
  const base = normalizePesos(allocated);

  // Só os atributos com peso concorrem. Um peso zero não é "pouco": é fora.
  const concorrem = STAT_ORDER.filter(s => peso[s] > 0);
  const somaPesos = concorrem.reduce((acc, s) => acc + peso[s], 0);
  if (livre <= 0 || somaPesos <= 0) return [];

  // O alvo é proporcional ao que o personagem terá investido **depois** de
  // gastar estes pontos, não ao que tem agora.
  const totalFinal = STAT_ORDER.reduce((acc, s) => acc + base[s], 0) + livre;
  const deficits = concorrem.map(s => Math.max(0, totalFinal * peso[s] / somaPesos - base[s]));
  const somaDeficits = deficits.reduce((a, b) => a + b, 0);

  // Build já cumprida: ninguém está atrás do alvo. Sem este desvio a função
  // devolveria vazio e os pontos ficariam parados para sempre, então a divisão
  // cai nos pesos crus.
  const partes = somaDeficits > 0 ? deficits : concorrem.map(s => peso[s]);
  const divisor = somaDeficits > 0 ? somaDeficits : somaPesos;

  const exatos = partes.map(p => livre * p / divisor);
  const inteiros = exatos.map(Math.floor);

  // Maior resto: a sobra do piso vai para as maiores frações. É o que garante
  // que a soma devolvida seja exatamente `livre`.
  let sobra = livre - inteiros.reduce((a, b) => a + b, 0);
  const ordem = exatos
    .map((_, i) => i)
    .sort((a, b) => (exatos[b] - inteiros[b]) - (exatos[a] - inteiros[a]));
  for (const i of ordem) {
    if (sobra <= 0) break;
    inteiros[i]++;
    sobra--;
  }

  return concorrem
    .map((sigla, i) => ({ stat: sigla, statId: STATS[sigla], points: inteiros[i] }))
    .filter(e => e.points > 0);
}

/**
 * O pacote pronto para `allocate_stats`.
 *
 * Os atributos saem como **número** do enum: o `verify` do protobufjs recusa o
 * nome em campo de enum com escopo.
 */
function toAllocatePoints(plano) {
  return arr(plano)
    .filter(e => e && int(e.points) > 0)
    .map(e => ({ stat: statId(e.statId || e.stat), points: int(e.points) }))
    .filter(e => e.stat > 0);
}

/**
 * O que fazer com esta conta, agora.
 *
 * Função pura: recebe o estado lido, a configuração e o catálogo, devolve o
 * plano. Quem envia é o serviço.
 *
 * @param {object} input
 * @param {object} [input.config]
 * @param {number} [input.index] Índice da conta, para a lista de exceções.
 * @param {string} [input.classId]
 * @param {object} [input.catalog] Saída de `readClassCatalog`.
 * @param {object} [input.allocated] `{ STR, ... }` já investido.
 * @param {number} [input.livres] `points.stat_points`.
 * @param {number} [input.level] Só para o relatório.
 * @returns {{ok:boolean, reason:string, plano:Array, points:Array,
 *            origem:string, buildId:string, buildName:string, pesos:object,
 *            livres:number, level:number}}
 */
function plan({ config, index = 0, classId = '', catalog = null,
  allocated = null, livres = 0, level = 0 } = {}) {
  const cfg = normalizeConfig(config);
  const livre = int(livres, 0);

  const vazio = {
    ok: false, reason: '', plano: [], points: [],
    origem: '', buildId: '', buildName: '', pesos: null,
    livres: livre, level: int(level)
  };

  if (!cfg.enabled) return { ...vazio, reason: 'stats.off' };
  if (cfg.disabled.includes(int(index, -1))) return { ...vazio, reason: 'stats.accountOff' };
  if (livre <= 0) return { ...vazio, reason: 'stats.noPoints' };

  const escolha = pesosDaConta(cfg, index, classId, catalog);
  if (!escolha.pesos) return { ...vazio, reason: escolha.reason || 'stats.noBuild' };

  const plano = planAlocacao({ pesos: escolha.pesos, allocated, livres: livre });
  // Pesos positivos e pontos livres sempre produzem plano; vazio aqui só por
  // bug. Vira motivo em vez de um envio sem pontos, que o servidor recusaria.
  if (!plano.length) return { ...vazio, reason: 'stats.emptyPlan', pesos: escolha.pesos };

  return {
    ok: true,
    reason: '',
    plano,
    points: toAllocatePoints(plano),
    origem: escolha.origem,
    buildId: escolha.buildId,
    buildName: escolha.buildName,
    pesos: escolha.pesos,
    livres: livre,
    level: int(level)
  };
}

/**
 * Resumo de uma conta para a janela: classe, build em uso, pontos parados e a
 * prévia da divisão que aconteceria agora.
 */
function summarize({ config, index = 0, classId = '', catalog = null,
  allocated = null, livres = 0, level = 0 } = {}) {
  const cfg = normalizeConfig(config);
  const classe = classeDe(catalog, classId);
  const escolha = pesosDaConta(cfg, index, classId, catalog);
  const livre = int(livres, 0);

  return {
    index: int(index),
    classId: str(classId),
    className: classe ? classe.name : '',
    builds: classe ? classe.builds : [],
    escolha: cfg.porConta[String(int(index, -1))] || null,
    origem: escolha.origem,
    buildId: escolha.buildId,
    buildName: escolha.buildName,
    pesos: escolha.pesos,
    reason: escolha.reason,
    enabled: accountEnabled(cfg, index),
    allocated: normalizePesos(allocated),
    livres: livre,
    level: int(level),
    // Prévia: a mesma conta que o envio faria, sem enviar. É o que deixa o
    // usuário conferir a divisão antes de ligar o automático.
    previa: escolha.pesos
      ? planAlocacao({ pesos: escolha.pesos, allocated, livres: livre })
      : []
  };
}

/** Percentual de cada peso, como o jogo mostra nos cartões de build. */
function pesosEmPercentual(pesos) {
  const peso = normalizePesos(pesos);
  const soma = STAT_ORDER.reduce((acc, s) => acc + peso[s], 0);
  const out = {};
  for (const sigla of STAT_ORDER) {
    out[sigla] = soma > 0 ? Math.round(peso[sigla] / soma * 100) : 0;
  }
  return out;
}

module.exports = {
  defaultConfig,
  normalizeConfig,
  normalizePesos,
  isConfigured,
  accountEnabled,
  readClassCatalog,
  hasClasses,
  classeDe,
  buildDe,
  buildPadrao,
  pesosDaConta,
  pesosEmPercentual,
  lerStatAmounts,
  pontosDe,
  statId,
  statSigla,
  planAlocacao,
  toAllocatePoints,
  plan,
  summarize,
  STATS,
  STAT_ORDER,
  STAT_BY_ID,
  DEFAULT_POINTS_PER_LEVEL,
  BACKOFF_MS,
  RESULT_TIMEOUT_MS,
  LOG_MAX
};
