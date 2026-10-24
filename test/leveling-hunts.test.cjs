const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  readHuntCatalog,
  hasHunts,
  tiersOf,
  tierOf,
  difficultiesFor,
  requirementFor,
  blockReason,
  normalizeTicket
} = require('../src/domain/leveling-hunts');

/**
 * Catálogo como o servidor manda: portais, dificuldades e faixas, com as áreas
 * por dificuldade. Os números são os três que barram uma caçada ao mesmo tempo —
 * `GateDef.min_level`, `DifficultyDef.req_level` e `Area.required_level`.
 */
const push = {
  gates: [
    { id: 'castelo-demonios', scene_id: 'cena-castelo', name: 'Castelo dos Demônios', min_level: 30 },
    { id: 'portal-azul', scene_id: 'cena-azul', name: 'Portal Azul', min_level: 1 }
  ],
  difficulties: [
    { id: 'normal', name: 'Normal', req_level: 0, reward_mult: 1, drop_mult: 1, status_mult: 1 },
    { id: 'dificil', name: 'Difícil', req_level: 40, reward_mult: 1.5, drop_mult: 1.3, status_mult: 2 }
  ],
  tiers: [
    {
      gate_id: 'portal-azul',
      min: 1,
      max: 10,
      boss_id: 'goblin-rei',
      areas: [
        { difficulty: 'normal', level: 8, required_level: 1 }
      ]
    },
    {
      gate_id: 'castelo-demonios',
      min: 36,
      max: 45,
      boss_id: 'lorde-demonio',
      areas: [
        { difficulty: 'normal', level: 42, required_level: 30 },
        { difficulty: 'dificil', level: 52, required_level: 45 }
      ]
    },
    {
      gate_id: 'castelo-demonios',
      min: 46,
      max: 55,
      coming_soon: true,
      areas: [{ difficulty: 'normal', level: 50, required_level: 46 }]
    }
  ]
};

const catalog = readHuntCatalog(push);

test('o catálogo vira portais, dificuldades e faixas, e nada além disso', () => {
  // O `content_catalog` passa de 1 MB; o que fica guardado tem de ser só isto.
  assert.deepEqual(Object.keys(catalog), ['gates', 'difficulties', 'tiers']);
  assert.ok(hasHunts(catalog));

  // Ordem de progressão, não a ordem interna do catálogo.
  assert.deepEqual(catalog.gates.map(g => g.id), ['portal-azul', 'castelo-demonios']);
  assert.deepEqual(catalog.gates[1], {
    id: 'castelo-demonios',
    sceneId: 'cena-castelo',
    name: 'Castelo dos Demônios',
    icon: '',
    minLevel: 30
  });

  assert.deepEqual(catalog.difficulties.map(d => d.id), ['normal', 'dificil']);
});

test('as faixas ficam indexadas por portal e em ordem crescente', () => {
  assert.deepEqual(tiersOf(catalog, 'castelo-demonios').map(t => t.min), [36, 46]);
  assert.deepEqual(tiersOf(catalog, 'portal-azul').map(t => t.min), [1]);
  assert.deepEqual(tiersOf(catalog, 'inexistente'), []);

  const tier = tierOf(catalog, 'castelo-demonios', 36);
  assert.equal(tier.max, 45);
  assert.equal(tier.bossId, 'lorde-demonio');
  assert.equal(tier.comingSoon, false);
  assert.deepEqual(tier.areas.dificil, { level: 52, requiredLevel: 45 });
});

test('um catálogo sem portais não serve para montar uma troca', () => {
  const vazio = readHuntCatalog({});
  assert.equal(hasHunts(vazio), false);
  assert.equal(hasHunts(null), false);
  // Lixo não pode derrubar a leitura: o push vem do servidor.
  assert.deepEqual(readHuntCatalog(null).gates, []);
  assert.deepEqual(readHuntCatalog({ gates: [{ name: 'sem id' }] }).gates, []);
});

test('só são oferecidas as dificuldades que a faixa de fato tem', () => {
  assert.deepEqual(difficultiesFor(catalog, 'castelo-demonios', 36).map(d => d.id), ['normal', 'dificil']);
  // O portal azul só declara `normal`: oferecer `dificil` seria oferecer uma
  // combinação que o servidor recusa.
  assert.deepEqual(difficultiesFor(catalog, 'portal-azul', 1).map(d => d.id), ['normal']);
});

test('faixa sem área declarada aceita todas as dificuldades', () => {
  // Filtrar aqui deixaria a tela sem nenhuma opção; o catálogo omitindo `areas`
  // significa que a faixa não restringe.
  const semArea = readHuntCatalog({
    gates: [{ id: 'g', name: 'G' }],
    difficulties: push.difficulties,
    tiers: [{ gate_id: 'g', min: 1, max: 9 }]
  });
  assert.deepEqual(difficultiesFor(semArea, 'g', 1).map(d => d.id), ['normal', 'dificil']);
});

test('o nível exigido é o maior dos três requisitos, não só o do portal', () => {
  // Portal 30, dificuldade 40, área 45: o que vale é 45.
  const dificil = requirementFor(catalog, 'castelo-demonios', 36, 'dificil');
  assert.equal(dificil.minLevel, 45);
  assert.equal(dificil.recommended, 52, 'o recomendado é o nível dos monstros da área');
  assert.deepEqual(dificil.tierRange, [36, 45]);
  assert.equal(dificil.known, true);

  // Na mesma faixa em normal, quem manda é o portal.
  const normal = requirementFor(catalog, 'castelo-demonios', 36, 'normal');
  assert.equal(normal.minLevel, 30);
  assert.equal(normal.recommended, 42);
});

test('sem área o recomendado cai para o topo da faixa', () => {
  const semArea = readHuntCatalog({
    gates: [{ id: 'g', name: 'G', min_level: 5 }],
    difficulties: push.difficulties,
    tiers: [{ gate_id: 'g', min: 10, max: 19 }]
  });
  const req = requirementFor(semArea, 'g', 10, 'normal');
  assert.equal(req.recommended, 19);
  assert.equal(req.minLevel, 5);
});

test('combinação que o catálogo não descreve não afirma nível nenhum', () => {
  const req = requirementFor(catalog, 'castelo-demonios', 999, 'normal');
  assert.equal(req.known, false, 'melhor dizer que não sabe do que afirmar zero');
  assert.deepEqual(req.tierRange, []);
});

test('o bloqueio distingue nível insuficiente de faixa não liberada', () => {
  const dificil = requirementFor(catalog, 'castelo-demonios', 36, 'dificil');
  assert.equal(blockReason(dificil, 44), 'hunt.level');
  assert.equal(blockReason(dificil, 45), '');
  assert.equal(blockReason(dificil, 60), '');
  // Nível desconhecido não bloqueia: quem decide é o servidor.
  assert.equal(blockReason(dificil, 0), '');

  const emBreve = requirementFor(catalog, 'castelo-demonios', 46, 'normal');
  assert.equal(blockReason(emBreve, 99), 'hunt.comingSoon');
});

test('o bilhete é normalizado nas duas formas de nome, e exige portal', () => {
  assert.deepEqual(normalizeTicket({ gate_id: 'g', tier_min: '36', difficulty: 'normal' }), {
    gate_id: 'g', tier_min: 36, difficulty: 'normal'
  });
  // A interface fala camelCase; o fio fala snake_case.
  assert.deepEqual(normalizeTicket({ gateId: 'g', tierMin: 7 }), {
    gate_id: 'g', tier_min: 7, difficulty: ''
  });
  assert.equal(normalizeTicket({ tier_min: 5 }), null, 'sem portal não existe caçada');
  assert.equal(normalizeTicket(null), null);
});
