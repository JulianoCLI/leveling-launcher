const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
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
  DEFAULT_POINTS_PER_LEVEL
} = require('../src/domain/leveling-stats');

/**
 * A função do jogo, transcrita do bundle sem nenhuma mudança além de
 * desminificar os nomes. Serve de oráculo: `planAlocacao` tem de concordar com
 * ela em qualquer entrada, porque alocar ponto não tem volta sem pagar respec.
 *
 * Extraída por `tools/leveling-extract-build-math.js` como `eM`.
 */
function oraculo(weights, allocated, free) {
  const ponto = (lista, stat) => (lista ?? []).find(e => e.stat === stat)?.points ?? 0;
  const r = weights.filter(e => e.points > 0);
  const i = r.reduce((a, e) => a + e.points, 0);
  if (free <= 0 || i <= 0) return [];
  const a = (allocated ?? []).reduce((s, e) => s + e.points, 0) + free;
  const o = r.map(e => Math.max(0, a * e.points / i - ponto(allocated, e.stat)));
  const s = o.reduce((x, y) => x + y, 0);
  const c = s > 0 ? o : r.map(e => e.points);
  const l = s > 0 ? s : i;
  const u = c.map(e => free * e / l);
  const d = u.map(Math.floor);
  let f = free - d.reduce((x, y) => x + y, 0);
  const p = u.map((_, t) => t).sort((x, y) => (u[y] - d[y]) - (u[x] - d[x]));
  for (const e of p) {
    if (f <= 0) break;
    d[e]++;
    f--;
  }
  return r.map((e, t) => ({ stat: e.stat, points: d[t] })).filter(e => e.points > 0);
}

/** `{STR:..}` para o `StatAmount[]` que o oráculo espera, na ordem da tela. */
const paraAmounts = obj => STAT_ORDER
  .map(s => ({ stat: STATS[s], points: obj[s] || 0 }))
  .filter(e => e.points > 0);

/** O plano do oráculo em `{STR:..}`, para comparar com o nosso. */
const amountsParaObj = lista => {
  const out = {};
  for (const s of STAT_ORDER) out[s] = 0;
  for (const e of lista) out[statSigla(e.stat)] = e.points;
  return out;
};

const planoParaObj = plano => {
  const out = {};
  for (const s of STAT_ORDER) out[s] = 0;
  for (const e of plano) out[e.stat] = e.points;
  return out;
};

/** Catálogo cru como o `content_catalog` manda, em snake_case. */
const CATALOGO_CRU = {
  rules: { stat_points_per_level: 5 },
  classes: [
    {
      id: 'mago',
      name: 'Mago',
      icon: 'mago.png',
      uses_magic: true,
      initial_stats: [
        { stat: STATS.INT, points: 36 },
        { stat: STATS.PER, points: 18 },
        { stat: STATS.VIT, points: 14 },
        { stat: STATS.AGI, points: 10 },
        { stat: STATS.STR, points: 6 }
      ],
      builds: [
        {
          id: 'arquimago',
          name: 'Arquimago',
          description: 'Magias devastadoras.',
          weights: [
            { stat: STATS.AGI, points: 20 },
            { stat: STATS.PER, points: 25 },
            { stat: STATS.VIT, points: 15 },
            { stat: STATS.INT, points: 40 }
          ]
        },
        {
          id: 'rajada-arcana',
          name: 'Rajada Arcana',
          description: 'Exige Estilhaçar de Gelo.',
          weights: [
            { stat: STATS.STR, points: 45 },
            { stat: STATS.AGI, points: 25 },
            { stat: STATS.PER, points: 20 },
            { stat: STATS.VIT, points: 10 }
          ]
        },
        {
          id: 'guardiao-arcano',
          name: 'Guardião Arcano',
          description: 'Resistente.',
          weights: [
            { stat: STATS.PER, points: 25 },
            { stat: STATS.VIT, points: 30 },
            { stat: STATS.INT, points: 45 }
          ]
        }
      ]
    },
    {
      id: 'guerreiro',
      name: 'Guerreiro',
      builds: [
        { id: 'bruto', name: 'Bruto', weights: [{ stat: STATS.STR, points: 60 }, { stat: STATS.VIT, points: 40 }] }
      ]
    },
    // Classe sem build nenhuma: existe no jogo em classe nova, e a conta dela
    // não pode distribuir nada.
    { id: 'sem-build', name: 'Sem Build', builds: [] }
  ]
};

const CATALOGO = readClassCatalog(CATALOGO_CRU);
const ligado = (over = {}) => normalizeConfig({ enabled: true, ...over });

// ------------------------------------------------------------------- enum

test('o enum tem o buraco do jogo: INT é 6 e PER é 7, não 4 e 5', () => {
  assert.equal(STATS.STR, 1);
  assert.equal(STATS.AGI, 2);
  assert.equal(STATS.VIT, 3);
  assert.equal(STATS.INT, 6);
  assert.equal(STATS.PER, 7);
  // Derivar da posição daria INT=4; o teste existe para isso não passar calado.
  assert.notEqual(STATS.INT, 4);
});

test('statId aceita sigla e número, e recusa o que não é atributo', () => {
  assert.equal(statId('INT'), 6);
  assert.equal(statId('int'), 6);
  assert.equal(statId(6), 6);
  assert.equal(statId(4), 0);
  assert.equal(statId('MANA'), 0);
  assert.equal(statId(null), 0);
});

test('statSigla volta do número para a sigla', () => {
  assert.equal(statSigla(7), 'PER');
  assert.equal(statSigla(4), '');
  assert.equal(statSigla('VIT'), 'VIT');
});

test('pontosDe trata ausência como zero: proto3 omite o campo zero', () => {
  const lista = [{ stat: STATS.INT, points: 10 }];
  assert.equal(pontosDe(lista, 'INT'), 10);
  assert.equal(pontosDe(lista, 'STR'), 0);
  assert.equal(pontosDe(undefined, 'STR'), 0);
});

test('lerStatAmounts devolve sempre as cinco chaves', () => {
  const lido = lerStatAmounts([{ stat: STATS.STR, points: 3 }]);
  assert.deepEqual(lido, { STR: 3, AGI: 0, PER: 0, VIT: 0, INT: 0 });
});

// --------------------------------------------------------------- catálogo

test('o catálogo é recortado em classes, builds e pontos por nível', () => {
  assert.equal(hasClasses(CATALOGO), true);
  assert.equal(CATALOGO.pointsPerLevel, 5);
  assert.equal(classeDe(CATALOGO, 'mago').name, 'Mago');
  assert.equal(classeDe(CATALOGO, 'mago').usesMagic, true);
  assert.equal(classeDe(CATALOGO, 'inexistente'), null);
});

test('os pesos da build viram as cinco chaves, com zero no que falta', () => {
  const build = buildDe(CATALOGO, 'mago', 'arquimago');
  assert.deepEqual(build.pesos, { STR: 0, AGI: 20, PER: 25, VIT: 15, INT: 40 });
});

test('initial_stats da classe é lido, e é o que a build ignora', () => {
  assert.deepEqual(classeDe(CATALOGO, 'mago').initialStats,
    { STR: 6, AGI: 10, PER: 18, VIT: 14, INT: 36 });
});

test('build sem nenhum peso positivo é descartada: não distribuiria nada', () => {
  const lido = readClassCatalog({
    classes: [{
      id: 'x',
      builds: [
        { id: 'morta', name: 'Morta', weights: [{ stat: STATS.STR, points: 0 }] },
        { id: 'viva', name: 'Viva', weights: [{ stat: STATS.STR, points: 1 }] }
      ]
    }]
  });
  assert.deepEqual(lido.classes.x.builds.map(b => b.id), ['viva']);
});

test('sem stat_points_per_level no catálogo, vale o padrão de 5', () => {
  assert.equal(readClassCatalog({ classes: [] }).pointsPerLevel, DEFAULT_POINTS_PER_LEVEL);
  assert.equal(readClassCatalog(null).pointsPerLevel, 5);
  assert.equal(hasClasses(readClassCatalog(null)), false);
});

test('a build padrão é a primeira da classe, e classe sem build não tem', () => {
  assert.equal(buildPadrao(CATALOGO, 'mago').id, 'arquimago');
  assert.equal(buildPadrao(CATALOGO, 'sem-build'), null);
  assert.equal(buildPadrao(CATALOGO, 'nao-existe'), null);
});

test('pesosEmPercentual é o que o cartão de build mostra', () => {
  const build = buildDe(CATALOGO, 'mago', 'arquimago');
  assert.deepEqual(pesosEmPercentual(build.pesos),
    { STR: 0, AGI: 20, PER: 25, VIT: 15, INT: 40 });
});

// ----------------------------------------------------------- configuração

test('a configuração nasce desligada: alocar ponto não tem volta', () => {
  const cfg = defaultConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(isConfigured(cfg), false);
  assert.deepEqual(cfg.disabled, []);
  assert.deepEqual(cfg.porConta, {});
});

test('a lista é do que está desligado: conta nova participa sozinha', () => {
  const cfg = ligado({ disabled: [2] });
  assert.equal(accountEnabled(cfg, 0), true);
  assert.equal(accountEnabled(cfg, 7), true);
  assert.equal(accountEnabled(cfg, 2), false);
});

test('desligado no geral desliga toda conta', () => {
  assert.equal(accountEnabled(normalizeConfig({ enabled: false }), 0), false);
});

test('disabled é limpo: repetido, negativo e não-número saem', () => {
  const cfg = normalizeConfig({ enabled: true, disabled: [3, 3, -1, 'x', 1] });
  assert.deepEqual(cfg.disabled, [1, 3]);
});

test('normalizeConfig aguenta lixo vindo de um prefs.json editado à mão', () => {
  assert.deepEqual(normalizeConfig(null), defaultConfig());
  assert.deepEqual(normalizeConfig('texto'), defaultConfig());
  assert.deepEqual(normalizeConfig({ porConta: 'texto' }).porConta, {});
});

test('os pesos personalizados são presos entre 0 e 1000', () => {
  const pesos = normalizePesos({ STR: -5, AGI: 99999, PER: 'x', VIT: 10.7, INT: 40 });
  assert.deepEqual(pesos, { STR: 0, AGI: 1000, PER: 0, VIT: 10, INT: 40 });
});

test('conta personalizada com todos os pesos em zero é descartada', () => {
  // Fica sem entrada, então cai no padrão da classe em vez de ficar ligada
  // sem fazer nada em silêncio.
  const cfg = normalizeConfig({
    enabled: true,
    porConta: { 0: { modo: 'custom', pesos: { STR: 0, INT: 0 } } }
  });
  assert.deepEqual(cfg.porConta, {});
});

test('a escolha por conta sobrevive à normalização', () => {
  const cfg = normalizeConfig({
    enabled: true,
    porConta: {
      0: { modo: 'build', buildId: 'guardiao-arcano' },
      1: { modo: 'custom', pesos: { INT: 70, VIT: 30 } },
      '-1': { modo: 'build', buildId: 'x' }
    }
  });
  assert.equal(cfg.porConta['0'].buildId, 'guardiao-arcano');
  assert.equal(cfg.porConta['1'].modo, 'custom');
  assert.deepEqual(cfg.porConta['1'].pesos, { STR: 0, AGI: 0, PER: 0, VIT: 30, INT: 70 });
  assert.equal(cfg.porConta['-1'], undefined);
});

// ------------------------------------------------------ escolha dos pesos

test('conta sem escolha usa a primeira build da classe', () => {
  const r = pesosDaConta(ligado(), 0, 'mago', CATALOGO);
  assert.equal(r.origem, 'padrao');
  assert.equal(r.buildId, 'arquimago');
  assert.deepEqual(r.pesos, { STR: 0, AGI: 20, PER: 25, VIT: 15, INT: 40 });
});

test('conta com build escolhida usa aquela build', () => {
  const cfg = ligado({ porConta: { 0: { modo: 'build', buildId: 'guardiao-arcano' } } });
  const r = pesosDaConta(cfg, 0, 'mago', CATALOGO);
  assert.equal(r.origem, 'build');
  assert.deepEqual(r.pesos, { STR: 0, AGI: 0, PER: 25, VIT: 30, INT: 45 });
});

test('build que sumiu num deploy vira motivo, não volta calada ao padrão', () => {
  const cfg = ligado({ porConta: { 0: { modo: 'build', buildId: 'build-antiga' } } });
  const r = pesosDaConta(cfg, 0, 'mago', CATALOGO);
  assert.equal(r.pesos, null);
  assert.equal(r.reason, 'stats.buildGone');
});

test('o personalizado dispensa classe e catálogo', () => {
  const cfg = ligado({ porConta: { 0: { modo: 'custom', pesos: { INT: 100 } } } });
  const r = pesosDaConta(cfg, 0, '', null);
  assert.equal(r.origem, 'custom');
  assert.deepEqual(r.pesos, { STR: 0, AGI: 0, PER: 0, VIT: 0, INT: 100 });
});

test('sem classe, sem catálogo e sem build cada um dá seu motivo', () => {
  assert.equal(pesosDaConta(ligado(), 0, '', CATALOGO).reason, 'stats.noClass');
  assert.equal(pesosDaConta(ligado(), 0, 'mago', null).reason, 'stats.noCatalog');
  assert.equal(pesosDaConta(ligado(), 0, 'sem-build', CATALOGO).reason, 'stats.noBuild');
});

// ---------------------------------------------------------------- fórmula

test('a soma do plano é exatamente os pontos livres', () => {
  for (let livres = 1; livres <= 60; livres++) {
    const plano = planAlocacao({
      pesos: { AGI: 20, PER: 25, VIT: 15, INT: 40 },
      allocated: { STR: 6, AGI: 10, PER: 18, VIT: 14, INT: 36 },
      livres
    });
    const soma = plano.reduce((a, e) => a + e.points, 0);
    assert.equal(soma, livres, `livres=${livres}`);
  }
});

test('só os atributos com peso recebem: peso zero é fora, não pouco', () => {
  const plano = planAlocacao({
    pesos: { STR: 0, AGI: 0, PER: 0, VIT: 0, INT: 100 },
    allocated: {},
    livres: 5
  });
  assert.deepEqual(plano, [{ stat: 'INT', statId: STATS.INT, points: 5 }]);
});

test('a base é o investido, não o total: a base da classe não conta', () => {
  // Com 36 de INT de classe, uma build 100% INT ainda manda tudo para INT,
  // porque `allocated` está zerado. Se a função olhasse `total`, mandaria menos.
  const plano = planAlocacao({
    pesos: { INT: 100 },
    allocated: { STR: 0, AGI: 0, PER: 0, VIT: 0, INT: 0 },
    livres: 10
  });
  assert.deepEqual(planoParaObj(plano), { STR: 0, AGI: 0, PER: 0, VIT: 0, INT: 10 });
});

test('atributo já acima do alvo não recebe: o ponto vai para quem está atrás', () => {
  const plano = planAlocacao({
    pesos: { STR: 50, VIT: 50 },
    allocated: { STR: 100, VIT: 0 },
    livres: 10
  });
  assert.deepEqual(planoParaObj(plano), { STR: 0, AGI: 0, PER: 0, VIT: 10, INT: 0 });
});

test('build já cumprida cai nos pesos crus em vez de devolver vazio', () => {
  // Déficit zero em todo mundo: sem o desvio, os pontos ficariam parados.
  const plano = planAlocacao({
    pesos: { STR: 50, VIT: 50 },
    allocated: { STR: 50, VIT: 50 },
    livres: 4
  });
  assert.deepEqual(planoParaObj(plano), { STR: 2, AGI: 0, PER: 0, VIT: 2, INT: 0 });
});

test('um ponto livre vai inteiro para o maior déficit', () => {
  const plano = planAlocacao({
    pesos: { STR: 10, INT: 90 },
    allocated: { STR: 0, INT: 0 },
    livres: 1
  });
  assert.deepEqual(plano, [{ stat: 'INT', statId: STATS.INT, points: 1 }]);
});

test('sem pontos livres ou sem pesos, o plano é vazio', () => {
  assert.deepEqual(planAlocacao({ pesos: { INT: 100 }, livres: 0 }), []);
  assert.deepEqual(planAlocacao({ pesos: { INT: 100 }, livres: -3 }), []);
  assert.deepEqual(planAlocacao({ pesos: {}, livres: 5 }), []);
  assert.deepEqual(planAlocacao(), []);
});

test('a divisão bate com a do jogo em mil combinações aleatórias', () => {
  // A paridade é o ponto do módulo: alocar errado custa respec.
  let seed = 20261103;
  const rnd = n => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };

  for (let caso = 0; caso < 1000; caso++) {
    const pesos = {};
    const allocated = {};
    for (const s of STAT_ORDER) {
      // Muitos zeros de propósito: build com dois ou três atributos é o comum,
      // e é onde o filtro de peso e o desempate por resto trabalham.
      pesos[s] = rnd(3) === 0 ? rnd(60) : 0;
      allocated[s] = rnd(4) === 0 ? rnd(400) : 0;
    }
    const livres = 1 + rnd(120);

    const nosso = planoParaObj(planAlocacao({ pesos, allocated, livres }));
    const deles = amountsParaObj(oraculo(paraAmounts(pesos), paraAmounts(allocated), livres));

    assert.deepEqual(nosso, deles,
      `caso ${caso}: pesos=${JSON.stringify(pesos)} alloc=${JSON.stringify(allocated)} livres=${livres}`);
  }
});

test('o pacote do allocate_stats leva o atributo como número do enum', () => {
  const plano = planAlocacao({ pesos: { INT: 60, VIT: 40 }, allocated: {}, livres: 5 });
  const points = toAllocatePoints(plano);
  assert.equal(points.length, 2);
  for (const p of points) {
    assert.equal(typeof p.stat, 'number');
    assert.ok(p.points > 0);
  }
  assert.equal(points.reduce((a, p) => a + p.points, 0), 5);
});

// -------------------------------------------------------------- plan/summary

const base = (over = {}) => ({
  config: ligado(),
  index: 0,
  classId: 'mago',
  catalog: CATALOGO,
  allocated: { STR: 0, AGI: 0, PER: 0, VIT: 0, INT: 0 },
  livres: 5,
  level: 42,
  ...over
});

test('plan devolve o plano e o pacote pronto quando tudo está no lugar', () => {
  const r = plan(base());
  assert.equal(r.ok, true);
  assert.equal(r.reason, '');
  assert.equal(r.origem, 'padrao');
  assert.equal(r.buildId, 'arquimago');
  assert.equal(r.points.reduce((a, p) => a + p.points, 0), 5);
  assert.equal(r.level, 42);
});

test('plan recusa, com motivo, o que não deve ser enviado', () => {
  assert.equal(plan(base({ config: normalizeConfig({}) })).reason, 'stats.off');
  assert.equal(plan(base({ config: ligado({ disabled: [0] }) })).reason, 'stats.accountOff');
  assert.equal(plan(base({ livres: 0 })).reason, 'stats.noPoints');
  assert.equal(plan(base({ classId: '' })).reason, 'stats.noClass');
  assert.equal(plan(base({ catalog: null })).reason, 'stats.noCatalog');
  assert.equal(plan(base({ classId: 'sem-build' })).reason, 'stats.noBuild');
});

test('plan recusado nunca traz pontos: nada a enviar', () => {
  for (const r of [plan(base({ livres: 0 })), plan(base({ classId: '' }))]) {
    assert.equal(r.ok, false);
    assert.deepEqual(r.points, []);
    assert.deepEqual(r.plano, []);
  }
});

test('summarize mostra a prévia sem enviar nada', () => {
  const s = summarize(base());
  assert.equal(s.className, 'Mago');
  assert.equal(s.builds.length, 3);
  assert.equal(s.enabled, true);
  assert.equal(s.previa.reduce((a, e) => a + e.points, 0), 5);
  assert.deepEqual(s.allocated, { STR: 0, AGI: 0, PER: 0, VIT: 0, INT: 0 });
});

test('summarize de conta desligada ainda descreve a classe e a build', () => {
  const s = summarize(base({ config: ligado({ disabled: [0] }) }));
  assert.equal(s.enabled, false);
  assert.equal(s.buildId, 'arquimago');
  assert.equal(s.builds.length, 3);
});

test('summarize sem pontos livres traz prévia vazia, não erro', () => {
  const s = summarize(base({ livres: 0 }));
  assert.deepEqual(s.previa, []);
  assert.equal(s.reason, '');
});
