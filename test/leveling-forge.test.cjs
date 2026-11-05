/**
 * @file leveling-forge.test.cjs
 * As regras da auto-forja.
 *
 * A prova que mais importa aqui é negativa: **nada é forjado que não deixe
 * aquele personagem mais forte**. É a regra que separa "melhorar a conta" de
 * "forjar porque sobrou material", e ela é a única coisa entre uma configuração
 * inocente e um inventário moído — peça desmontada não volta, nem pagando.
 *
 * Depois dela vem a consequência de o nível de saída ser o **menor** dos cinco
 * insumos: a janela escolhida tem de ser a das cinco peças mais baixas que
 * ainda melhoram, nunca a das cinco melhores. Essa é a diferença entre guardar
 * os níveis altos para a fusão seguinte e queimá-los numa saída que o insumo
 * mais fraco já define.
 *
 * E por último as três guardas de destruição (equipado, trancado, guardado), o
 * desmonte dirigido que só come o que nunca seria insumo, e a recusa quando o
 * teto de desmonte alcança o material da fusão.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const forge = require('../src/domain/leveling-forge');

/**
 * Catálogo mínimo no formato do recorte de `leveling-market-catalog.js`.
 *
 * As raridades têm `order` com buraco de propósito (0, 10, 20, 30): o campo é o
 * que ordena, e contar posições na lista em vez de ler `order` passaria neste
 * teste por acidente se a numeração fosse densa.
 *
 * `statMult` cresce com a raridade, que é o que permite estimar o ganho de um
 * degrau sem forjar antes. Um catálogo **sem** `statMult` é testado à parte:
 * é o caminho permissivo.
 */
const CATALOGO = {
  rarities: {
    comum: { name: 'Comum', order: 0, statMult: 1 },
    incomum: { name: 'Incomum', order: 10, statMult: 1.3 },
    raro: { name: 'Raro', order: 20, statMult: 1.8 },
    epico: { name: 'Épico', order: 25, statMult: 2.5 },
    lendario: { name: 'Lendário', order: 30, statMult: 3.5 }
  },
  items: {
    'espada-x': { slot: 'ARMA' },
    'elmo-x': { slot: 'CAPACETE' },
    'peito-x': { slot: 'PEITORAL' },
    'escudo-x': { slot: 'ESCUDO' },
    'anel-x': { slot: 'ANEL' }
  },
  fusion: {
    fusionInputs: 5,
    swapInputs: 8,
    dustItemId: 'po-arcano',
    dustPerRarity: { comum: 2, incomum: 5, raro: 20, epico: 60 },
    fusionDustCost: { raro: 100, epico: 300, incomum: 40, comum: 10 },
    fusionGoldKills: { raro: 7, epico: 19 },
    swapDustCost: { raro: 250 },
    swapGoldKills: { raro: 18 }
  }
};

/** O mesmo catálogo sem `stat_mult`: o servidor que não manda o campo. */
const SEM_MULT = {
  ...CATALOGO,
  rarities: Object.fromEntries(Object.entries(CATALOGO.rarities)
    .map(([id, def]) => [id, { ...def, statMult: 0 }]))
};

let proximo = 1;
/** Uma peça da bolsa, no formato de `inventoryItems`. */
const peca = (over = {}) => ({
  uid: String(9007199254740993n + BigInt(proximo++)),
  defId: 'espada-x',
  rarity: 'raro',
  level: 50,
  power: 100,
  locked: false,
  equippedSlot: '',
  ...over
});

/** Várias peças iguais. */
const pecas = (n, over = {}) => Array.from({ length: n }, () => peca(over));

/**
 * Peças de níveis dados, todas do mesmo slot e raridade.
 *
 * `power` fica **fixo** em 100 por padrão, e não acompanhando o nível: o que
 * está em teste aqui é a escolha da janela pelo nível, e deixar o poder variar
 * junto faria o teste passar pelo motivo errado. Quem precisa de poder por
 * nível passa `power` explicitamente.
 */
const niveis = (lista, over = {}) => lista.map(level => peca({ level, power: 100, ...over }));

const cfg = (over = {}) => forge.normalizeConfig({ enabled: true, ...over });

const planeja = (items, over = {}, dust = 100000, catalog = CATALOGO) =>
  forge.plan({ config: cfg(over), catalog, items, dust });

/** Uma peça equipada num slot. */
const equipada = (sigla, over = {}) => peca({
  equippedSlot: `EQUIP_SLOT_${sigla}`, ...over
});

/**
 * A peça equipada "no ponto": mais forte que qualquer coisa crua na bolsa, mas
 * fraca o bastante para a fusão a superar.
 *
 * Esta faixa existe porque o plano tem **duas** saídas, e elas competem: se a
 * bolsa tiver peça mais forte que a equipada, o plano manda equipar e não
 * forja — vestir é de graça. Com insumos de poder 100 e o degrau raro→épico
 * valendo 2.5/1.8, a fusão estima ~139: qualquer valor entre 100 e 139 isola a
 * fusão como única saída.
 */
const NO_PONTO = 120;

// ------------------------------------------------------------------- slots

test('a forja cobre os oito slots que o jogo deixa produzir', () => {
  // O seletor de slot de saída da aba Fusão lista arma, escudo, capacete,
  // peitoral, calça, luvas, botas, cinto e capa. Colar, anel e brinco nunca
  // saíram de uma fusão, e mantê-los aqui gerava candidatos que o servidor
  // recusava.
  assert.equal(forge.SLOT_ORDER.length, 8);
  assert.equal(forge.slotId('ANEL'), 0);
  assert.equal(forge.slotId('COLAR'), 0);
  assert.equal(forge.slotId('BRINCO'), 0);
});

test('escudo e tesouro continuam fora, apesar de escudo estar no seletor', () => {
  // Escudo é exclusivo de algumas classes: o personagem de duas mãos nunca o
  // preenche, e um slot que não dá para equipar consumiria material para
  // sempre. Tesouro nem é equipamento.
  assert.equal(forge.slotId('ESCUDO'), 0);
  assert.equal(forge.slotId('EQUIP_SLOT_TESOURO'), 0);
  assert.equal(forge.slotId(2), 0);
  assert.equal(forge.slotId(13), 0);
});

test('slotId aceita número, sigla e o nome completo do enum', () => {
  // As duas pontas falam formas diferentes: o que chega do servidor vem como
  // `EQUIP_SLOT_ARMA` porque o codec usa `enums: String`, e o que sai tem de
  // ser número porque o `verify` recusa o nome.
  assert.equal(forge.slotId(1), 1);
  assert.equal(forge.slotId('ARMA'), 1);
  assert.equal(forge.slotId('EQUIP_SLOT_ARMA'), 1);
  assert.equal(forge.slotName('EQUIP_SLOT_CALCA'), 'Calça');
});

// -------------------------------------------------------------- raridades

test('rarityAbove e rarityBelow andam pela order, não pela posição', () => {
  // A numeração tem buraco (20 → 25 → 30): contar posições inventaria um
  // degrau que não existe.
  assert.equal(forge.rarityAbove(CATALOGO, 'raro'), 'epico');
  assert.equal(forge.rarityBelow(CATALOGO, 'epico'), 'raro');
  assert.equal(forge.rarityAbove(CATALOGO, 'lendario'), null);
  assert.equal(forge.rarityBelow(CATALOGO, 'comum'), null);
});

test('o teto padrão de desmonte são as duas raridades mais baixas', () => {
  // Contar duas a partir da `order` mais baixa, em vez de procurar os ids
  // "comum" e "incomum", mantém isto funcionando num servidor que renomeie.
  assert.equal(forge.junkCeiling(CATALOGO, cfg()), 10);
  assert.equal(forge.junkCeiling(CATALOGO, cfg({ dismantleUpTo: 'raro' })), 20);
});

// ----------------------------------------------------- a janela de insumos

test('o nível de saída é o menor dos cinco insumos', () => {
  // Medido no jogo: quatro peças de 55 com uma de 52 devolvem uma de 52.
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 10, power: NO_PONTO }),
    ...niveis([52, 55, 55, 55, 55])
  ];
  const p = planeja(items);
  assert.ok(p.fuse);
  assert.equal(p.fuse.level, 52);
  assert.equal(p.fuse.rarity, 'epico');
  assert.equal(p.fuse.waste, 12); // 55-52 quatro vezes.
});

test('cinco épicos do mesmo nível podem criar lendário no nível equipado', () => {
  const items = [
    equipada('ARMA', { rarity: 'lendario', level: 75, power: 300 }),
    ...niveis([75, 75, 75, 75, 75], { rarity: 'epico' })
  ];
  const p = planeja(items);
  assert.ok(p.fuse);
  assert.equal(p.fuse.inputRarity, 'epico');
  assert.equal(p.fuse.rarity, 'lendario');
  assert.equal(p.fuse.level, 75);
});

test('épicos abaixo ou com níveis mistos não criam lendário', () => {
  const abaixo = planeja([
    equipada('ARMA', { rarity: 'lendario', level: 75, power: 300 }),
    ...niveis([74, 74, 74, 74, 74], { rarity: 'epico' })
  ]);
  assert.equal(abaixo.fuse, null);

  const mistos = planeja([
    equipada('ARMA', { rarity: 'lendario', level: 75, power: 300 }),
    ...niveis([75, 75, 75, 75, 76], { rarity: 'epico' })
  ]);
  assert.equal(mistos.fuse, null);
});

test('a janela escolhida é a das cinco mais baixas que já melhoram', () => {
  // A regra que mais importa desta versão. Com oito peças disponíveis e a
  // janela de baixo já bastando, pegar as cinco melhores queimaria níveis
  // altos numa saída que o insumo mais fraco define de qualquer forma.
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 10, power: NO_PONTO }),
    ...niveis([40, 41, 42, 43, 44, 70, 71, 72])
  ];
  const p = planeja(items);
  assert.ok(p.fuse);
  assert.equal(p.fuse.level, 40);
  assert.deepEqual(p.fuse.inputLevels, [40, 41, 42, 43, 44]);
});

test('a janela sobe só até achar a primeira que melhora', () => {
  // Equipada uma rara de nível 60 com poder 500. As janelas de baixo saem
  // fracas demais; a varredura tem de continuar em vez de desistir na
  // primeira.
  //
  // Aqui o poder acompanha o nível, porque é essa correlação que faz as
  // janelas de baixo saírem fracas: nenhuma peça crua da bolsa chega aos 500
  // da equipada (a mais forte tem 406), então `equipFirst` não entra e a
  // fusão é a única saída.
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 60, power: 500 }),
    ...[10, 11, 12, 13, 14, 200, 201, 202, 203, 204]
      .map(level => peca({ level, power: level * 2 }))
  ];
  const p = planeja(items);
  assert.ok(p.fuse, 'alguma janela mais alta tem de servir');
  // Só a janela que começa no 200 sai acima dos 500 da equipada: todas as
  // anteriores têm o nível baixo como base, e é a base que define a saída.
  assert.equal(p.fuse.level, 200);
});

// -------------------------------------------------------------------- lote

test('janelas de um mesmo slot não se sobrepõem', () => {
  // Quinze peças iguais dão três fusões, não onze. Janelas deslizantes de um
  // em um descreveriam fusões que disputam a mesma peça.
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 1, power: NO_PONTO }),
    ...niveis([50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50])
  ];
  const lista = forge.candidates({ items, catalog: CATALOGO, config: cfg() });
  assert.equal(lista.length, 3);
  const vistos = new Set();
  for (const c of lista) for (const u of c.uids) {
    assert.ok(!vistos.has(u), 'uid repetido entre candidatos');
    vistos.add(u);
  }
});

test('a rodada funde o lote inteiro, não uma fusão', () => {
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 1, power: NO_PONTO }),
    ...niveis([50, 50, 50, 50, 50, 50, 50, 50, 50, 50])
  ];
  const p = planeja(items);
  assert.equal(p.fusions.length, 2);
  assert.equal(p.fuse, p.fusions[0]);
});

test('o teto por rodada limita o lote', () => {
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 1, power: NO_PONTO }),
    ...niveis(Array(25).fill(50))
  ];
  assert.equal(planeja(items, { maxFusions: 2 }).fusions.length, 2);
});

test('o lote cabe no pó disponível', () => {
  // Fusão de raro custa 100. Com 250 de pó e sem nada a sacrificar, duas.
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 1, power: NO_PONTO }),
    ...niveis(Array(20).fill(50))
  ];
  const p = planeja(items, {}, 250);
  assert.equal(p.fusions.length, 2);
});

test('o lote cruza slots, em ordem de ganho', () => {
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 1, power: NO_PONTO }),
    equipada('CAPACETE', { defId: 'elmo-x', rarity: 'raro', level: 1, power: NO_PONTO }),
    ...niveis([50, 50, 50, 50, 50], { defId: 'espada-x' }),
    ...niveis([50, 50, 50, 50, 50], { defId: 'elmo-x' })
  ];
  const p = planeja(items);
  assert.equal(p.fusions.length, 2);
  assert.notEqual(p.fusions[0].slot, p.fusions[1].slot);
});

test('slot com peça melhor na bolsa não bloqueia os outros', () => {
  // Antes isto abortava a rodada inteira. O guarda-roupa da arma não tem nada
  // a ver com o capacete.
  const items = [
    // Arma fraca: a bolsa já tem rara de poder 100 acima dela.
    equipada('ARMA', { rarity: 'raro', level: 1, power: 10 }),
    ...niveis([50, 50, 50, 50, 50], { defId: 'espada-x' }),
    equipada('CAPACETE', { defId: 'elmo-x', rarity: 'raro', level: 1, power: NO_PONTO }),
    ...niveis([50, 50, 50, 50, 50], { defId: 'elmo-x' })
  ];
  const p = planeja(items);
  assert.ok(p.equipFirst.includes(forge.SLOTS.ARMA));
  assert.equal(p.fusions.length, 1);
  assert.equal(p.fuse.sigla, 'CAPACETE');
});

test('sem janela que melhore, nada é forjado', () => {
  // A conta que já está no melhor que consegue para por si. É o estado final
  // saudável, não uma falha — e por isso o motivo é próprio.
  const items = [
    equipada('ARMA', { rarity: 'epico', level: 90, power: 9000 }),
    ...niveis([10, 11, 12, 13, 14])
  ];
  const p = planeja(items);
  assert.equal(p.fuse, null);
  assert.equal(p.reason, 'forge.noPositiveWindow');
});

test('quatro peças não fundem', () => {
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 10, power: 20 }),
    ...niveis([50, 50, 50, 50])
  ];
  assert.equal(planeja(items).fuse, null);
});

test('peças de slots diferentes não entram na mesma janela', () => {
  // `Fuse.slot` existe para o destino ser nomeado; misturar slots exigiria
  // `slot_swap`, que custa mais pó e está desligado.
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 10, power: 20 }),
    ...niveis([50, 50], { defId: 'espada-x' }),
    ...niveis([50, 50, 50], { defId: 'elmo-x' })
  ];
  assert.equal(planeja(items).fuse, null);
});

test('o slot da peça da bolsa vem do catálogo, não de equipped_slot', () => {
  // `ItemInstance.equipped_slot` é vazio em tudo que está na bolsa: o slot do
  // tipo mora em `ItemDef.slot`.
  assert.equal(forge.itemSlot({ defId: 'elmo-x' }, CATALOGO), forge.SLOTS.CAPACETE);
  assert.equal(forge.itemSlot({ defId: 'desconhecido' }, CATALOGO), 0);
});

test('peça de slot que a forja não produz fica fora do pool', () => {
  const items = [...pecas(5, { defId: 'anel-x', level: 50 })];
  const prof = forge.profile({ items, catalog: CATALOGO, config: cfg() });
  assert.equal(prof.total, 0);
});

// ------------------------------------------------- estimativa e permissivo

test('o ganho é estimado pelo stat_mult do degrau', () => {
  // A peça que sai não existe ainda: não há `power` para ler. A aproximação é
  // o insumo mais baixo um degrau acima, porque o nível de saída é o dele.
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 50, power: 100 }),
    ...niveis([50, 50, 50, 50, 50]) // power 100 cada
  ];
  const p = planeja(items);
  assert.ok(p.fuse);
  // 100 × (2.5 / 1.8) ≈ 138.9
  assert.ok(p.fuse.estPower > 130 && p.fuse.estPower < 145);
  assert.equal(p.fuse.assumed, false);
});

test('sem stat_mult, o degrau é presumido como melhoria se o nível alcança', () => {
  // A política permissiva. Recusar aqui travaria a conta inteira por um campo
  // ausente do servidor, e a rede de segurança está do outro lado:
  // `equip_best_preview` mede o ganho real depois da fusão.
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 50, power: 999999 }),
    ...niveis([50, 50, 50, 50, 50])
  ];
  const p = planeja(items, {}, 100000, SEM_MULT);
  assert.ok(p.fuse, 'poder altíssimo não impede: só o nível decide');
  assert.equal(p.fuse.assumed, true);
});

test('sem stat_mult, nível de saída abaixo do equipado não forja', () => {
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 80, power: 10 }),
    ...niveis([50, 50, 50, 50, 50])
  ];
  assert.equal(planeja(items, {}, 100000, SEM_MULT).fuse, null);
});

test('slot vazio sempre aceita a primeira fusão possível', () => {
  // O caso mais claro de melhoria que existe: não há com o que comparar, e
  // deixar o slot vazio para sempre seria o pior resultado.
  //
  // Olha `candidates` e não `plan`: com o slot vazio, o plano manda **equipar**
  // antes de forjar, e com razão — vestir uma peça crua num slot vazio é de
  // graça. O que se prova aqui é que o candidato existe, para a rodada
  // seguinte o encontrar depois de o slot já estar preenchido.
  const lista = forge.candidates({
    items: niveis([30, 30, 30, 30, 30]), catalog: SEM_MULT, config: cfg()
  });
  assert.equal(lista.length, 1);
  assert.equal(lista[0].level, 30);
  assert.equal(lista[0].assumed, true);
});

// ------------------------------------------------------------ a escolha

test('entre dois slots, vence o de maior ganho', () => {
  // A arma equipada tem poder 135, quase o que a fusão dela renderia (~139);
  // o capacete tem 110, logo acima dos insumos crus de 100 — nenhum dos dois
  // cai em `equipFirst`, e os dois têm candidato. O capacete ganha muito mais.
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 50, power: 135 }),
    equipada('CAPACETE', { defId: 'elmo-x', rarity: 'raro', level: 50, power: 110 }),
    ...niveis([50, 50, 50, 50, 50], { defId: 'espada-x' }),
    ...niveis([50, 50, 50, 50, 50], { defId: 'elmo-x' })
  ];
  const p = planeja(items);
  assert.ok(p.fuse);
  assert.equal(p.fuse.sigla, 'CAPACETE');
});

test('no empate de ganho, vence a janela que desperdiça menos nível', () => {
  // Duas fusões igualmente boas: a que preserva níveis altos deixa a conta
  // mais perto da próxima. Os dois slots partem do mesmo poder equipado e os
  // insumos têm o mesmo poder, então o ganho empata e só o desperdício separa.
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 1, power: NO_PONTO }),
    equipada('CAPACETE', { defId: 'elmo-x', rarity: 'raro', level: 1, power: NO_PONTO }),
    ...niveis([50, 60, 70, 80, 90], { defId: 'elmo-x' }),
    ...niveis([50, 50, 50, 50, 50], { defId: 'espada-x' })
  ];
  const lista = forge.candidates({ items, catalog: CATALOGO, config: cfg() });
  const arma = lista.find(c => c.sigla === 'ARMA');
  const elmo = lista.find(c => c.sigla === 'CAPACETE');

  assert.equal(arma.waste, 0);
  assert.equal(elmo.waste, 10 + 20 + 30 + 40);
  assert.equal(arma.gain, elmo.gain);
  assert.equal(lista[0].sigla, 'ARMA');
});

test('equipar vem antes de forjar quando a bolsa já tem peça melhor', () => {
  // Vestir é de graça. Fundir para substituir algo que ia ser substituído sem
  // custo nenhum seria queimar cinco peças por nada.
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 50, power: 100 }),
    peca({ rarity: 'raro', level: 60, power: 900 }),
    ...niveis([50, 50, 50, 50, 50])
  ];
  const p = planeja(items);
  assert.equal(p.reason, 'forge.equipFirst');
  assert.equal(p.fuse, null);
  assert.ok(p.equipFirst.includes(forge.SLOTS.ARMA));
});

// -------------------------------------------------- guardas de destruição

test('peça equipada nunca é tocada', () => {
  // Ela é a referência contra a qual o ganho é medido; desmontá-la deixaria o
  // slot vazio.
  const items = pecas(5, { equippedSlot: 'EQUIP_SLOT_ARMA', rarity: 'comum' });
  const p = planeja(items);
  assert.equal(p.junk.length, 0);
  assert.equal(p.fuse, null);
});

test('peça trancada nunca é tocada', () => {
  // O cadeado é do jogo, e é como o jogador diz "não toque". Aqui ninguém
  // confirma nada peça por peça, então ele vale sem exceção.
  const p = planeja(pecas(9, { rarity: 'comum', locked: true }));
  assert.equal(p.junk.length, 0);
});

test('a lista keep protege o tipo inteiro', () => {
  const items = pecas(9, { rarity: 'comum', defId: 'espada-x' });
  const p = planeja(items, { keep: ['espada-x'] });
  assert.equal(p.junk.length, 0);
});

test('raridade desconhecida nunca é desmontada nem fundida', () => {
  // Sem a `order` não há como provar que ela está abaixo do teto, e o erro
  // aqui apaga a peça para sempre.
  const items = pecas(9, { rarity: 'mitico-novo' });
  const p = planeja(items);
  assert.equal(p.junk.length, 0);
  assert.equal(p.fuse, null);
});

test('a raridade mais alta do jogo não vira insumo', () => {
  // Não há degrau acima dela: fundi-la destruiria cinco das melhores peças da
  // conta sem produzir nada melhor.
  const items = [
    equipada('ARMA', { rarity: 'comum', level: 1, power: 1 }),
    ...niveis([90, 90, 90, 90, 90], { rarity: 'lendario' })
  ];
  assert.equal(planeja(items).fuse, null);
});

// ------------------------------------------------------------- o desmonte

test('comuns e incomuns são moídos sem o usuário pedir', () => {
  // Primeira coisa de cada rodada, e é de onde vem o pó que paga tudo.
  const items = [...pecas(3, { rarity: 'comum' }), ...pecas(2, { rarity: 'incomum' })];
  const p = planeja(items);
  assert.equal(p.junk.length, 5);
});

test('raros não entram no lixo por padrão', () => {
  // Eles são insumo. Moê-los sem necessidade é destruir o material da fusão.
  const p = planeja(pecas(9, { rarity: 'raro' }));
  assert.equal(p.junk.length, 0);
});

test('o que não é equipamento nunca é moído', () => {
  // Poção, material e gema também vêm com raridade comum, e o desmonte do
  // jogo recusa todas com `item.notAllowed`. Sem slot no catálogo, fora.
  const items = [
    ...pecas(3, { rarity: 'comum', defId: 'espada-x' }),
    ...pecas(4, { rarity: 'comum', defId: 'pocao-x' })
  ];
  const p = planeja(items);
  assert.equal(p.junk.length, 3);
  for (const j of p.junk) assert.equal(j.defId, 'espada-x');
});

test('o teto por rodada limita o desmonte', () => {
  const p = planeja(pecas(40, { rarity: 'comum' }), { maxDismantle: 7 });
  assert.equal(p.junk.length, 7);
});

test('os insumos da fusão escolhida ficam fora do lixo', () => {
  // Na prática o lixo é de raridade baixa e a fusão de raridade alta, mas
  // depender disso deixaria a correção num só lugar.
  // A equipada fica acima dos insumos crus para o plano não cair em
  // `equipFirst`: ali não haveria fusão, e o teste não provaria nada.
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 1, power: NO_PONTO }),
    ...niveis([50, 50, 50, 50, 50], { rarity: 'incomum' })
  ];
  const p = planeja(items);
  assert.ok(p.fuse);
  const noLixo = new Set(p.junk.map(j => j.uid));
  for (const uid of p.fuse.uids) assert.ok(!noLixo.has(uid));
});

test('teto escolhido que alcança o insumo da fusão recusa a rodada', () => {
  // Recusa em vez de cortar a lista em silêncio: o usuário configurou duas
  // coisas que se contradizem, e só ele resolve.
  const items = [
    equipada('ARMA', { rarity: 'comum', level: 1, power: 1 }),
    ...niveis([50, 50, 50, 50, 50], { rarity: 'raro' })
  ];
  const p = planeja(items, { dismantleUpTo: 'raro' });
  assert.equal(p.reason, 'forge.dismantleClash');
  assert.equal(p.junk.length, 0);
});

// --------------------------------------------------- o desmonte dirigido

test('faltando pó, só peças de nível abaixo da saída são sacrificadas', () => {
  // Peça de nível acima é insumo da fusão seguinte: moê-la agora é trocar o
  // degrau de amanhã pelo de hoje.
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 1, power: NO_PONTO }),
    ...niveis([50, 50, 50, 50, 50]),
    // Noutro slot de propósito: no slot da arma elas entrariam na janela e
    // puxariam a saída para o nível 20, que é o contrário do que se testa.
    peca({ rarity: 'raro', level: 20, defId: 'elmo-x' }),
    peca({ rarity: 'raro', level: 21, defId: 'elmo-x' }),
    peca({ rarity: 'raro', level: 80, defId: 'elmo-x' }),
    peca({ rarity: 'raro', level: 90, defId: 'elmo-x' })
  ];
  // Custo da fusão de raros é 100; o pó de um raro é 20. Faltando 100, cinco
  // peças seriam precisas — e só há duas abaixo do nível 50.
  const p = planeja(items, {}, 0);
  assert.equal(p.reason, 'forge.noDust');
  assert.equal(p.fuse, null);
  assert.equal(p.sacrifice.ok, false);
});

test('o sacrifício para no primeiro item que fecha a conta', () => {
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 1, power: NO_PONTO }),
    ...niveis([50, 50, 50, 50, 50]),
    // Noutro slot: no slot da arma elas entrariam na janela e a saída viraria
    // nível 20 em vez de 50.
    peca({ rarity: 'raro', level: 20, defId: 'elmo-x' }),
    peca({ rarity: 'raro', level: 21, defId: 'elmo-x' }),
    peca({ rarity: 'raro', level: 22, defId: 'elmo-x' })
  ];
  // Faltando 40 de pó e cada raro rendendo 20: duas peças bastam, a terceira
  // não pode ser tocada.
  const p = planeja(items, {}, 60);
  assert.ok(p.fuse);
  assert.equal(p.sacrifice.uids.length, 2);
  assert.equal(p.sacrifice.need, 40);
});

test('com pó de sobra, nada é sacrificado', () => {
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 1, power: NO_PONTO }),
    ...niveis([50, 50, 50, 50, 50]),
    peca({ rarity: 'raro', level: 20, defId: 'elmo-x' })
  ];
  const p = planeja(items, {}, 100000);
  assert.ok(p.fuse);
  assert.equal(p.sacrifice.uids.length, 0);
});

test('o sacrifício nunca toca peça de raridade acima da que a fusão consome', () => {
  // Moer uma épica para forjar uma épica a partir de raras é destruir o melhor
  // para fazer o pior.
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 1, power: NO_PONTO }),
    ...niveis([50, 50, 50, 50, 50], { rarity: 'raro' }),
    peca({ rarity: 'epico', level: 10, power: 5 }),
    peca({ rarity: 'epico', level: 11, power: 5 })
  ];
  const p = planeja(items, {}, 0);
  assert.equal(p.sacrifice.ok, false);
  assert.equal(p.sacrifice.uids.length, 0);
});

// ------------------------------------------------------------ configuração

test('a configuração nasce desligada', () => {
  // Das automações do launcher esta é a que destrói mais coisa por rodada.
  const c = forge.defaultConfig();
  assert.equal(c.enabled, false);
  assert.equal(forge.isConfigured(c), false);
});

test('equipar o melhor vem ligado por padrão', () => {
  // Sem equipar, a peça forjada fica na bolsa e a rodada seguinte mede o ganho
  // contra a peça velha — e forjaria a mesma coisa de novo, para sempre.
  assert.equal(forge.defaultConfig().equipBest, true);
  assert.equal(forge.normalizeConfig({}).equipBest, true);
  assert.equal(forge.normalizeConfig({ equipBest: false }).equipBest, false);
});

test('ligar basta: não há mais alvo a configurar', () => {
  // O alvo agora é derivado de cada conta. Exigir nível e raridade aqui era
  // justamente o que fazia a conta de nível 30 moer atrás do alvo da de 80.
  assert.equal(forge.isConfigured({ enabled: true }), true);
});

test('contas e slots são listados pelo que fica de fora', () => {
  // Uma lista de permissões deixaria uma conta nova de fora em silêncio.
  const c = cfg({ disabled: [2], slotsOff: ['CAPA'] });
  assert.equal(forge.accountEnabled(c, 0), true);
  assert.equal(forge.accountEnabled(c, 2), false);
  assert.ok(!forge.activeSlots(c).includes(forge.SLOTS.CAPA));
  assert.ok(forge.activeSlots(c).includes(forge.SLOTS.ARMA));
});

test('slot desligado não gera candidato', () => {
  const items = [
    equipada('ARMA', { rarity: 'comum', level: 1, power: 1 }),
    ...niveis([50, 50, 50, 50, 50])
  ];
  assert.equal(planeja(items, { slotsOff: ['ARMA'] }).fuse, null);
});

test('conta desligada não planeja nada', () => {
  const p = forge.plan({
    config: cfg({ disabled: [3] }), index: 3, catalog: CATALOGO,
    items: pecas(9, { rarity: 'comum' }), dust: 1000
  });
  assert.equal(p.reason, 'forge.accountOff');
  assert.equal(p.junk.length, 0);
});

test('sem regras de fusão no catálogo a rodada recusa', () => {
  // Sem `fusion_inputs` não há como saber quantas peças uma fusão come, e
  // chutar cinco gastaria peças de verdade num palpite.
  const p = forge.plan({
    config: cfg(), catalog: { rarities: CATALOGO.rarities }, items: pecas(9), dust: 1000
  });
  assert.equal(p.reason, 'forge.noRules');
});

// ------------------------------------------------------------- o resumo

test('o resumo traz o candidato de cada slot e o estoque por raridade', () => {
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 20, power: 40 }),
    ...niveis([50, 50, 50, 50, 50])
  ];
  const s = forge.summarize({ config: cfg(), catalog: CATALOGO, items, dust: 500 });
  const arma = s.slots.find(x => x.sigla === 'ARMA');
  assert.equal(arma.level, 20);
  assert.ok(arma.candidate);
  assert.equal(arma.candidate.level, 50);
  assert.equal(arma.candidate.rarity, 'epico');
  assert.equal(arma.ok, false);
  assert.equal(arma.stock[0].count, 5);
});

test('slot sem nada a fazer vem marcado como ok', () => {
  const items = [equipada('CAPACETE', { defId: 'elmo-x', rarity: 'lendario', level: 99, power: 9999 })];
  const s = forge.summarize({ config: cfg(), catalog: CATALOGO, items, dust: 0 });
  const elmo = s.slots.find(x => x.sigla === 'CAPACETE');
  assert.equal(elmo.ok, true);
  assert.equal(elmo.candidate, null);
});

test('a estimativa aponta a próxima fusão e o pó que o lixo renderia', () => {
  const items = [
    equipada('ARMA', { rarity: 'raro', level: 20, power: 40 }),
    ...niveis([50, 50, 50, 50, 50]),
    ...pecas(3, { rarity: 'comum' }) // 2 de pó cada
  ];
  const e = forge.estimate({ config: cfg(), catalog: CATALOGO, items, dust: 7 });
  assert.equal(e.ready, true);
  assert.equal(e.best.rarity, 'epico');
  assert.equal(e.best.level, 50);
  assert.equal(e.dustNeeded, 100);
  assert.equal(e.dustHave, 7);
  assert.equal(e.dustFromJunk, 6);
  assert.equal(e.junkPieces, 3);
});

test('a estimativa sem candidato não inventa um', () => {
  const e = forge.estimate({ config: cfg(), catalog: CATALOGO, items: [], dust: 0 });
  assert.equal(e.ready, true);
  assert.equal(e.best, null);
  assert.equal(e.upgradable, 0);
});
