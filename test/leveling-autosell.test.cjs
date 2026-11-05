const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
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
  MAX_PER_ROUND_CAP,
  DEFAULT_FLOOR_PCT,
  MIN_DIAMOND_PRICE
} = require('../src/domain/leveling-autosell');

/** Catálogo mínimo: é ele que separa tesouro de equipamento. */
const catalog = {
  items: {
    citrino: { name: 'Citrino', category: 'materials' },
    pedra: { name: 'Pedra de encantamento', category: 'imbue_materials' },
    espada: { name: 'Espada', category: 'weapons' },
    peitoral: { name: 'Peitoral', category: 'armor' },
    anel: { name: 'Anel', category: 'accessories' },
    pocao: { name: 'Poção', category: 'consumables' }
  }
};

/** Um item do inventário, no formato de `inventoryItems`. */
const item = (over = {}) => ({
  uid: '100', defId: 'citrino', level: 1, enchant: 0, qty: 1,
  locked: false, equippedSlot: '', sellPrice: 0, scope: 1, ...over
});

const UID_GRANDE = '1962493714927616001';

// ------------------------------------------------------------ configuração

test('a configuração nasce desligada e sem conta excluída', () => {
  const cfg = defaultConfig();
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.excluded, []);
  assert.equal(cfg.claimMail, true);
  assert.equal(isConfigured(cfg), false, 'desligada não liga o laço');
});

test('o intervalo tem piso: uma rodada por segundo só geraria tráfego', () => {
  // O sniper corre a cada segundo porque disputa uma pechincha. Aqui não há
  // corrida: a vaga de anúncio continua vaga.
  assert.equal(normalizeConfig({ intervalMs: 10 }).intervalMs, MIN_INTERVAL_MS);
  assert.equal(normalizeConfig({ intervalMs: 0 }).intervalMs, defaultConfig().intervalMs);
});

test('o teto de itens por rodada é limitado nos dois sentidos', () => {
  // É escrita irreversível sem cancelar: um erro de preço com teto alto
  // liquida o inventário antes de alguém ler o relatório.
  assert.equal(normalizeConfig({ maxPerRound: 0 }).maxPerRound, defaultConfig().maxPerRound);
  assert.equal(normalizeConfig({ maxPerRound: 999 }).maxPerRound, MAX_PER_ROUND_CAP);
  assert.equal(normalizeConfig({ maxPerRound: 3 }).maxPerRound, 3);
});

test('o desconto aceita zero mas não negativo', () => {
  // Zero é anunciar empatado com o rival, que é um pedido legítimo. Negativo
  // seria anunciar acima dele, o oposto do que o desconto serve.
  assert.equal(normalizeConfig({ undercut: 0 }).undercut, 0);
  assert.equal(normalizeConfig({ undercut: -50 }).undercut, 0);
});

test('contas excluídas são deduplicadas e ordenadas', () => {
  const cfg = normalizeConfig({ excluded: [3, 1, 3, '2', -1, 'x'] });
  assert.deepEqual(cfg.excluded, [1, 2, 3], 'lixo e negativo saem');
});

test('todas as contas participam por padrão; a exclusão é explícita', () => {
  // Como no auto-boss: uma automação que precisa ser ligada conta por conta
  // fica meio ligada para sempre.
  const cfg = normalizeConfig({ enabled: true, excluded: [2] });
  assert.equal(includesAccount(cfg, 0), true);
  assert.equal(includesAccount(cfg, 7), true);
  assert.equal(includesAccount(cfg, 2), false);
  assert.equal(includesAccount({ ...cfg, enabled: false }, 0), false);
});

// --------------------------------------------------------- lista de bloqueio

test('a lista de bloqueio nasce vazia: proteger por padrão seria não vender nada', () => {
  assert.deepEqual(defaultConfig().blocked, []);
});

test('o bloqueio vence todas as outras regras, inclusive a categoria', () => {
  // É o ponto inteiro da lista: categoria e preço acertam no geral e erram no
  // particular, e o material de imbuição guardado para forjar é justamente o
  // melhor candidato que as regras encontram.
  const it = item({ defId: 'pedra' });
  assert.equal(skipReason(it, catalog), '', 'sem bloqueio, é tesouro e passa');
  assert.equal(skipReason(it, catalog, ['pedra']), 'blocked');
});

test('o bloqueio é por item inteiro, não por nível', () => {
  // Bloquear o nv. 2 e deixar o nv. 1 vendável é a forma de descobrir, tarde,
  // que o que o usuário guardava era o conjunto.
  for (const level of [1, 2, 7]) {
    assert.equal(skipReason(item({ defId: 'citrino', level }), catalog, ['citrino']), 'blocked');
  }
});

test('o bloqueio é checado antes do uid, para nenhum caminho passar por cima dele', () => {
  assert.equal(skipReason(item({ defId: 'citrino', uid: '' }), catalog, ['citrino']), 'blocked');
});

test('a lista é deduplicada, aparada e ordenada', () => {
  // `defId` é identificador do servidor: um espaço colado deixaria a linha na
  // tela sem bloquear nada, e uma lista de bloqueio que mente é pior que não ter.
  const cfg = normalizeConfig({ blocked: ['pedra', ' citrino ', 'pedra', '', null, 7] });
  assert.deepEqual(cfg.blocked, ['7', 'citrino', 'pedra']);
});

test('ligar e desligar o bloqueio devolve configuração nova, sem mexer na antiga', () => {
  const antes = normalizeConfig({ enabled: true, floorPct: 85 });
  const comPedra = withBlocked(antes, 'pedra', true);
  assert.deepEqual(antes.blocked, [], 'a original não é tocada');
  assert.deepEqual(comPedra.blocked, ['pedra']);
  assert.equal(comPedra.floorPct, 85, 'o resto da configuração sobrevive');

  // Duas vezes não duplica, e desligar remove.
  assert.deepEqual(withBlocked(comPedra, 'pedra', true).blocked, ['pedra']);
  assert.deepEqual(withBlocked(comPedra, 'pedra', false).blocked, []);
  // Desbloquear o que nunca esteve lá não é erro.
  assert.deepEqual(withBlocked(antes, 'citrino', false).blocked, []);
  // `defId` vazio não cria linha fantasma.
  assert.deepEqual(withBlocked(antes, '', true).blocked, []);
});

test('isBlocked responde a partir do defId só, que é tudo o que a tela tem', () => {
  const cfg = normalizeConfig({ blocked: ['pedra'] });
  assert.equal(isBlocked(cfg, 'pedra'), true);
  assert.equal(isBlocked(cfg, 'citrino'), false);
  assert.equal(isBlocked(cfg, ''), false);
});

// ------------------------------------------------------- tesouro e equipamento

test('material e material de imbuição são tesouro', () => {
  assert.equal(isTreasure(item({ defId: 'citrino' }), catalog), true);
  assert.equal(isTreasure(item({ defId: 'pedra' }), catalog), true);
});

test('arma, armadura e acessório são equipamento e nunca são anunciados', () => {
  // Por tipo, não por estado: a armadura no depósito é tão equipamento quanto
  // a vestida. Era essa a distinção que faltava.
  for (const defId of ['espada', 'peitoral', 'anel']) {
    const it = item({ defId, scope: 3, locked: false });
    assert.equal(isGear(it, catalog), true, defId);
    assert.equal(skipReason(it, catalog), 'gear', `${defId} fica fora mesmo solto`);
  }
});

test('sem catálogo nada é classificado, e nada é anunciado', () => {
  // Preferir o dado ausente ao palpite: classificar por `def_id` adivinhado
  // venderia equipamento como se fosse gema.
  assert.equal(skipReason(item(), null), 'noCategory');
  assert.equal(isGear(item({ defId: 'espada' }), null), false, 'sem catálogo não afirma nada');
});

test('categoria que não é tesouro nem equipamento também fica fora', () => {
  // Poção é consumível: o usuário pediu tesouros, e vender a poção que ele usa
  // para caçar seria uma surpresa caríssima.
  assert.equal(skipReason(item({ defId: 'pocao' }), catalog), 'notTreasure');
});

test('item vestido e item sem uid são recusados antes de tudo', () => {
  assert.equal(skipReason(item({ equippedSlot: 'EQUIP_SLOT_TESOURO' }), catalog), 'equipped');
  assert.equal(skipReason(item({ uid: '' }), catalog), 'no_uid');
  assert.equal(skipReason(item({ uid: 0 }), catalog), 'no_uid');
});

// ------------------------------------------------------------ chave de preço

test('a chave de preço inclui nível e encanto: o def_id sozinho mente', () => {
  // Um citrino nv. 2 vale perto de 3x um nv. 1 e os dois têm o mesmo def_id.
  // Qualquer preço por def_id sozinho erra por uma margem que supera qualquer
  // refinamento de média.
  const nv1 = priceKeyOf(item({ level: 1 }));
  const nv2 = priceKeyOf(item({ level: 2 }));
  assert.notEqual(nv1, nv2, 'níveis diferentes são produtos diferentes');
  assert.equal(nv1, 'citrino@1+0');
  assert.equal(priceKeyOf(item({ level: 2, enchant: 3 })), 'citrino@2+3');
});

// ------------------------------------------------------------------- preço

test('sem vendas do nível exato, não anuncia e diz por quê', () => {
  // `marketPriceHint` existe e responderia, mas ignora o nível: usá-lo como
  // fallback faria o nv. 2 sair pelo preço do nv. 1.
  const r = priceFor({ median: 0, samples: 0, rival: 1000, floorPct: 70 });
  assert.equal(r.price, 0);
  assert.equal(r.reason, 'price.noLevelData');

  // Uma venda só não é referência de mercado.
  assert.equal(priceFor({ median: 1000, samples: 1, rival: 900 }).reason, 'price.noLevelData');
});

test('sem rival no mercado, o preço é a mediana', () => {
  const r = priceFor({ median: 1000000, samples: 5, rival: 0, floorPct: 70 });
  assert.equal(r.price, 1000000);
  assert.equal(r.reason, '');
});

test('com rival saudável, anuncia um ouro abaixo dele', () => {
  // Um ouro basta para ficar na frente na ordenação por preço, que é o que
  // decide a venda. Descontos maiores entregam margem de graça.
  const r = priceFor({ median: 1000000, samples: 5, rival: 900000, floorPct: 70, undercut: 1 });
  assert.equal(r.price, 899999);
  assert.equal(r.floor, 700000);
  assert.equal(r.reason, '');
});

test('rival abaixo do piso é despejo: não anuncia', () => {
  // É o caminho pelo qual uma automação liquida um inventário inteiro por
  // nada: alguém despeja estoque a 10% e o launcher acompanha a queda.
  const r = priceFor({ median: 2000000, samples: 8, rival: 180000, floorPct: 70 });
  assert.equal(r.price, 0);
  assert.equal(r.reason, 'price.marketDumped');
  assert.equal(r.floor, 1400000, 'o relatório mostra o piso que o rival furou');
  assert.equal(r.rival, 180000);
});

test('o piso trava o desconto: nunca abaixo dele', () => {
  // Rival exatamente no piso: o desconto não pode empurrar o preço abaixo.
  const r = priceFor({ median: 1000000, samples: 5, rival: 700000, floorPct: 70, undercut: 1 });
  assert.equal(r.price, 700000, 'o desconto cede ao piso');
});

test('o piso é configurável, e um piso frouxo aceita mais mercado', () => {
  const base = { median: 1000000, samples: 5, rival: 500000 };
  assert.equal(priceFor({ ...base, floorPct: 70 }).reason, 'price.marketDumped');
  assert.equal(priceFor({ ...base, floorPct: 40 }).price, 499999, 'piso de 40% aceita');
});

test('nunca anuncia abaixo do que o NPC paga', () => {
  // Pagar taxa de mercado para receber menos do que o balcão dá de graça.
  const r = priceFor({ median: 1000, samples: 5, rival: 800, floorPct: 70, npcPrice: 900 });
  assert.equal(r.price, 0);
  assert.equal(r.reason, 'price.belowNpc');
});

test('o piso padrão é 70% da mediana', () => {
  assert.equal(DEFAULT_FLOOR_PCT, 70);
  assert.equal(priceFor({ median: 1000, samples: 5 }).floor, 700);
});

// ------------------------------------------------------- modo e moeda

test('a configuração nasce no modo rival e em ouro', () => {
  // O padrão tem de ser o comportamento que já existia: uma configuração
  // salva antes destes campos não pode começar a anunciar diferente depois
  // de uma atualização do launcher.
  const cfg = defaultConfig();
  assert.equal(cfg.priceMode, 'rival');
  assert.equal(cfg.currency, 'gold');
  assert.equal(normalizeConfig({}).priceMode, 'rival');
  assert.equal(normalizeConfig({}).currency, 'gold');
});

test('modo e moeda desconhecidos caem no padrão, não passam adiante', () => {
  // Um `prefs.json` editado à mão não pode produzir um modo que nenhum
  // `switch` trata: o resultado seria um preço indefinido num anúncio
  // irreversível.
  assert.equal(normalizeConfig({ priceMode: 'medio' }).priceMode, 'rival');
  assert.equal(normalizeConfig({ priceMode: 42 }).priceMode, 'rival');
  assert.equal(normalizeConfig({ currency: 'token' }).currency, 'gold');
  assert.equal(normalizeConfig({ priceMode: 'average' }).priceMode, 'average');
  assert.equal(normalizeConfig({ currency: 'diamond' }).currency, 'diamond');
});

test('no modo média o preço é a média, não a mediana nem o rival', () => {
  // A média é a referência e também a resposta: o modo existe para afirmar o
  // preço que o item vem fazendo, não para negociar com a concorrência.
  const r = priceFor({
    median: 1000000, average: 1200000, samples: 6,
    rival: 500000, floorPct: 70, undercut: 1, priceMode: 'average'
  });
  assert.equal(r.price, 1200000);
  assert.equal(r.mode, 'average');
  assert.equal(r.reason, '');
});

test('o modo média ignora o piso e o despejo: não há rival na conta', () => {
  // Um rival a 10% da mediana faria o modo rival recusar com
  // `marketDumped`. Aqui ele não participa, então o preço sai igual.
  const base = { median: 2000000, average: 1800000, samples: 8, floorPct: 70 };
  assert.equal(priceFor({ ...base, rival: 180000, priceMode: 'rival' }).reason, 'price.marketDumped');
  assert.equal(priceFor({ ...base, rival: 180000, priceMode: 'average' }).price, 1800000);
  assert.equal(priceFor({ ...base, rival: 0, priceMode: 'average' }).price, 1800000);
});

test('o modo média sem média recusa, em vez de cair na mediana calado', () => {
  // Cair na mediana entregaria um preço de outro modo com o nome deste, e o
  // relatório diria "média" sobre um número que não é a média.
  const r = priceFor({ median: 1000000, average: 0, samples: 6, priceMode: 'average' });
  assert.equal(r.price, 0);
  assert.equal(r.reason, 'price.noLevelData');
});

test('o NPC ainda é o piso absoluto no modo média', () => {
  // É um piso em ouro e não depende de rival nenhum: pagar taxa de mercado
  // para receber menos do que o balcão dá de graça é errado nos dois modos.
  const r = priceFor({
    median: 1000, average: 800, samples: 5, priceMode: 'average', npcPrice: 900
  });
  assert.equal(r.reason, 'price.belowNpc');
});

test('em diamante com histórico em diamante, o preço sai direto e sem cotação', () => {
  // `median` já está em diamante: converter por cima dela multiplicaria o
  // preço pela cotação e o anúncio sairia em dezenas de milhares de diamantes.
  const r = priceFor({
    median: 40, samples: 5, rival: 0, currency: 'diamond',
    directDiamond: true, rate: 380000
  });
  assert.equal(r.price, 40);
  assert.equal(r.currency, 'diamond');
  assert.equal(r.rate, 0, 'a cotação não entrou na conta');
  assert.equal(r.reason, '');
});

test('em diamante sem histórico, o preço em ouro é convertido pela cotação', () => {
  const r = priceFor({
    median: 3800000, samples: 5, rival: 0, currency: 'diamond', rate: 380000
  });
  assert.equal(r.price, 10, '3,8 M de ouro a 380 k por diamante');
  assert.equal(r.goldPrice, 3800000, 'o equivalente em ouro fica para auditar');
  assert.equal(r.rate, 380000);
});

test('a conversão arredonda para cima: nunca a favor do comprador', () => {
  // Mesmo motivo de `normalizeDraft`: para baixo, o lote sairia por menos do
  // que o cálculo pediu — e um anúncio barato demais some no primeiro
  // comprador que passa.
  const r = priceFor({
    median: 3900000, samples: 5, rival: 0, currency: 'diamond', rate: 380000
  });
  assert.equal(r.price, 11, '10,26 sobe para 11');
});

test('item barato demais não é anunciado em diamante', () => {
  // A 380 k por diamante, um lote de 500 k dá 1,3: arredondar para 2 pede 53%
  // a mais e não vende; para 1 dá 24% de desconto irreversível. Nenhum dos
  // dois é o preço do item.
  const r = priceFor({
    median: 500000, samples: 5, rival: 0, currency: 'diamond', rate: 380000
  });
  assert.equal(r.price, 0);
  assert.equal(r.reason, 'price.tooCheapForDiamond');
  assert.equal(r.goldPrice, 500000, 'o relatório mostra quanto ele valia em ouro');

  // Exatamente no mínimo passa: o corte é "abaixo de", não "até".
  assert.equal(priceFor({
    median: 380000 * MIN_DIAMOND_PRICE, samples: 5, rival: 0,
    currency: 'diamond', rate: 380000
  }).price, MIN_DIAMOND_PRICE);
});

test('sem cotação, o diamante recusa em vez de inventar uma taxa', () => {
  const r = priceFor({
    median: 3800000, samples: 5, rival: 0, currency: 'diamond', rate: 0
  });
  assert.equal(r.price, 0);
  assert.equal(r.reason, 'price.noRate');
  assert.equal(r.goldPrice, 3800000);
});

test('o NPC é comparado em ouro, antes da conversão para diamante', () => {
  // Comparar "4 diamantes" com "900 de ouro" aprovaria como ótimo um anúncio
  // que vale um décimo do que o NPC dá.
  const r = priceFor({
    median: 1000, samples: 5, rival: 0, currency: 'diamond',
    rate: 100, npcPrice: 1200
  });
  assert.equal(r.reason, 'price.belowNpc');
});

// ------------------------------------------------------- rival no mercado

test('o rival é o mais barato do mesmo nível, não do mesmo def_id', () => {
  const anuncios = [
    { unit_price: 100000, level: 1, enchant: 0, status: 'MARKET_STATUS_ACTIVE' },
    { unit_price: 900000, level: 2, enchant: 0, status: 'MARKET_STATUS_ACTIVE' },
    { unit_price: 950000, level: 2, enchant: 0, status: 'MARKET_STATUS_ACTIVE' }
  ];
  // O nv. 1 a 100k não é concorrência de um nv. 2 — e se fosse considerado,
  // o nv. 2 sairia a 100k, que é o bug de 3x que o usuário descreveu.
  assert.equal(lowestRival(anuncios, item({ level: 2 })), 900000);
  assert.equal(lowestRival(anuncios, item({ level: 1 })), 100000);
  assert.equal(lowestRival(anuncios, item({ level: 3 })), 0, 'nenhum rival nesse nível');
});

test('o encanto também separa o rival', () => {
  const anuncios = [
    { unit_price: 100, level: 1, enchant: 0, status: 'MARKET_STATUS_ACTIVE' },
    { unit_price: 900, level: 1, enchant: 2, status: 'MARKET_STATUS_ACTIVE' }
  ];
  assert.equal(lowestRival(anuncios, item({ level: 1, enchant: 2 })), 900);
});

test('o próprio anúncio não é rival de si mesmo', () => {
  // Incluí-lo cria uma espiral: anuncia a 1 M, lê o próprio anúncio como
  // rival, desconta, repete. Ninguém mais no mercado precisa estar envolvido.
  const anuncios = [
    { unit_price: 500000, level: 1, enchant: 0, mine: true, status: 'MARKET_STATUS_ACTIVE' },
    { unit_price: 900000, level: 1, enchant: 0, status: 'MARKET_STATUS_ACTIVE' }
  ];
  assert.equal(lowestRival(anuncios, item({ level: 1 })), 900000);
});

test('anúncio fechado e em outra moeda não são rival', () => {
  const anuncios = [
    { unit_price: 1, level: 1, enchant: 0, status: 'MARKET_STATUS_SOLD' },
    { unit_price: 2, level: 1, enchant: 0, status: 'MARKET_STATUS_CANCELED' },
    { unit_price: 3, level: 1, enchant: 0, currency: 'MARKET_CURRENCY_DIAMOND', status: 'MARKET_STATUS_ACTIVE' },
    { unit_price: 800, level: 1, enchant: 0, status: 'MARKET_STATUS_ACTIVE' }
  ];
  assert.equal(lowestRival(anuncios, item({ level: 1 })), 800);
});

test('status ausente conta como ativo: proto3 omite o zero', () => {
  assert.equal(lowestRival([{ unit_price: 700, level: 1, enchant: 0 }], item({ level: 1 })), 700);
});

test('anunciando em diamante, o rival é o anúncio em diamante', () => {
  // A moeda inverte o filtro. Sem isso, todo anúncio em diamante veria "nenhum
  // rival" e sairia pela mediana, ignorando a concorrência que de fato existe.
  const anuncios = [
    { unit_price: 800000, level: 1, enchant: 0, status: 'MARKET_STATUS_ACTIVE' },
    { unit_price: 40, level: 1, enchant: 0, currency: 'MARKET_CURRENCY_DIAMOND', status: 'MARKET_STATUS_ACTIVE' },
    { unit_price: 60, level: 1, enchant: 0, currency: 'MARKET_CURRENCY_DIAMOND', status: 'MARKET_STATUS_ACTIVE' }
  ];
  assert.equal(lowestRival(anuncios, item({ level: 1 }), 'diamond'), 40);
  assert.equal(lowestRival(anuncios, item({ level: 1 }), 'gold'), 800000);
  assert.equal(lowestRival(anuncios, item({ level: 1 })), 800000, 'ouro é o padrão');
});

test('token nunca é rival, em nenhuma das duas moedas', () => {
  const anuncios = [
    { unit_price: 1, level: 1, enchant: 0, currency: 'MARKET_CURRENCY_TOKEN', status: 'MARKET_STATUS_ACTIVE' },
    { unit_price: 50, level: 1, enchant: 0, currency: 'MARKET_CURRENCY_DIAMOND', status: 'MARKET_STATUS_ACTIVE' }
  ];
  assert.equal(lowestRival(anuncios, item({ level: 1 }), 'diamond'), 50);
  assert.equal(lowestRival(anuncios, item({ level: 1 }), 'gold'), 0);
});

// ------------------------------------------------------------------ rodada

const preco = (median, rival, samples = 5) => ({ median, rival, samples });

test('a rodada respeita as vagas que o servidor informa', () => {
  // O teto de anúncios é do jogo e muda com a conta: um número nosso daria
  // recusa do servidor em vez de um item a menos.
  const prices = new Map([['citrino@1+0', preco(1000, 900)]]);
  const itens = [
    item({ uid: '1' }), item({ uid: '2' }), item({ uid: '3' })
  ];
  const p = planRound({
    items: itens, catalog, prices, limit: 10, active: 9,
    config: { enabled: true, maxPerRound: 5 }
  });
  assert.equal(p.slots, 1, 'uma vaga livre de dez');
  assert.equal(p.ready.length, 1);
  assert.equal(p.skipped.filter(s => s.reason === 'noSlot').length, 2);
});

test('a rodada não anuncia o que está na lista de bloqueio', () => {
  // O item barrado tem preço, tem vaga e é tesouro: tudo o que a rodada pede.
  // Só a decisão do usuário o segura.
  const prices = new Map([
    ['pedra@1+0', preco(9000, 8000)],
    ['citrino@1+0', preco(1000, 900)]
  ]);
  const p = planRound({
    items: [item({ uid: '1', defId: 'pedra' }), item({ uid: '2', defId: 'citrino' })],
    catalog, prices, limit: 10, active: 0,
    config: { enabled: true, maxPerRound: 5, blocked: ['pedra'] }
  });
  assert.deepEqual(p.ready.map(r => r.defId), ['citrino'],
    'a pedra valia nove vezes mais e mesmo assim fica');
  assert.equal(p.skipped.find(s => s.defId === 'pedra').reason, 'blocked');
});

test('sem vaga nenhuma, a rodada não anuncia nada', () => {
  const prices = new Map([['citrino@1+0', preco(1000, 900)]]);
  const p = planRound({
    items: [item()], catalog, prices, limit: 10, active: 10,
    config: { enabled: true }
  });
  assert.equal(p.slots, 0);
  assert.deepEqual(p.ready, []);
});

test('o teto por rodada corta antes das vagas disponíveis', () => {
  const prices = new Map([['citrino@1+0', preco(1000, 900)]]);
  const itens = Array.from({ length: 8 }, (_, i) => item({ uid: String(i + 1) }));
  const p = planRound({
    items: itens, catalog, prices, limit: 10, active: 0,
    config: { enabled: true, maxPerRound: 2 }
  });
  assert.equal(p.ready.length, 2, 'dez vagas, mas o teto da rodada é dois');
});

test('tesouro vem antes, mesmo valendo menos', () => {
  // A preferência é do usuário, e as vagas são escassas o bastante para a
  // ordem decidir o que de fato vende.
  const prices = new Map([
    ['citrino@1+0', preco(1000, 1000)],
    ['pedra@1+0', preco(500, 500)]
  ]);
  const itens = [item({ uid: '1', defId: 'citrino' }), item({ uid: '2', defId: 'pedra' })];
  const p = planRound({
    items: itens, catalog, prices, limit: 10, active: 0,
    config: { enabled: true, maxPerRound: 5 }
  });
  assert.ok(p.ready.every(r => r.treasure), 'os dois são tesouro');
  assert.equal(p.ready[0].defId, 'citrino', 'entre tesouros, o de maior valor');
});

test('o mais caro do lote vem primeiro', () => {
  const prices = new Map([['citrino@1+0', preco(1000, 1000)]]);
  const itens = [item({ uid: '1', qty: 1 }), item({ uid: '2', qty: 10 })];
  const p = planRound({
    items: itens, catalog, prices, limit: 10, active: 0,
    config: { enabled: true, maxPerRound: 1 }
  });
  assert.equal(p.ready[0].uid, '2');
  // Rival a 1000 com desconto de 1: o unitário é 999, e o lote de dez é
  // 9990. É a conversão que já causou um bug de verdade na tela de anunciar —
  // o preço do pacote e o da unidade não são o mesmo número.
  assert.equal(p.ready[0].unitPrice, 999, 'o servidor recebe o unitário');
  assert.equal(p.ready[0].total, 9990, 'o preço do lote é o unitário vezes a quantidade');
});

test('equipamento não entra nem com vaga sobrando', () => {
  const prices = new Map([
    ['espada@1+0', preco(9000000, 9000000)],
    ['citrino@1+0', preco(1000, 1000)]
  ]);
  const itens = [item({ uid: '1', defId: 'espada' }), item({ uid: '2', defId: 'citrino' })];
  const p = planRound({
    items: itens, catalog, prices, limit: 10, active: 0,
    config: { enabled: true, maxPerRound: 5 }
  });
  assert.equal(p.ready.length, 1);
  assert.equal(p.ready[0].defId, 'citrino');
  assert.ok(p.skipped.some(s => s.defId === 'espada' && s.reason === 'gear'),
    'e a espada de 9 M aparece no relatório como recusada, não como esquecida');
});

test('item sem referência de preço é pulado com motivo auditável', () => {
  const p = planRound({
    items: [item({ level: 2 })], catalog, prices: new Map(), limit: 10, active: 0,
    config: { enabled: true }
  });
  assert.deepEqual(p.ready, []);
  const s = p.skipped[0];
  assert.equal(s.reason, 'price.noLevelData');
  assert.equal(s.level, 2, 'o relatório diz de que nível faltou dado');
});

test('o mínimo de ouro corta pelo valor do lote', () => {
  const prices = new Map([['citrino@1+0', preco(1000, 1000)]]);
  const p = planRound({
    items: [item({ qty: 1 }), item({ uid: '2', qty: 50 })], catalog, prices,
    limit: 10, active: 0, config: { enabled: true, minGold: 10000, maxPerRound: 5 }
  });
  assert.equal(p.ready.length, 1);
  assert.equal(p.ready[0].uid, '2', 'só o lote que passa do mínimo');
  assert.ok(p.skipped.some(s => s.reason === 'cheap'));
});

test('a rodada preserva o uid grande: era o item errado no jogo', () => {
  const prices = new Map([['citrino@1+0', preco(1000, 900)]]);
  const p = planRound({
    items: [item({ uid: UID_GRANDE })], catalog, prices, limit: 10, active: 0,
    config: { enabled: true }
  });
  assert.equal(p.ready[0].uid, UID_GRANDE);
  assert.equal(typeof p.ready[0].uid, 'string', 'número não representa uint64');
});

test('a rodada não lança com entrada vazia ou lixo', () => {
  for (const entrada of [undefined, {}, { items: null }, { items: [null, undefined] }]) {
    const p = planRound(entrada);
    assert.deepEqual(p.ready, []);
    assert.ok(Array.isArray(p.skipped));
  }
});

test('a rodada em modo média usa a média de cada item', () => {
  const prices = new Map([
    ['citrino@1+0', { median: 1000000, average: 1200000, samples: 6, rival: 500000 }]
  ]);
  const p = planRound({
    items: [item()], catalog, prices, limit: 10, active: 0,
    config: { enabled: true, priceMode: 'average' }
  });
  assert.equal(p.ready.length, 1, 'rival a metade da mediana não recusa no modo média');
  assert.equal(p.ready[0].unitPrice, 1200000);
  assert.equal(p.ready[0].from.mode, 'average');
  assert.equal(p.ready[0].from.average, 1200000);
});

test('a rodada em diamante marca a moeda no rascunho', () => {
  // É `currency` do rascunho que `marketCreate` recebe. Faltando, o preço
  // seria calculado em diamante e o anúncio sairia em ouro — três ordens de
  // grandeza abaixo do valor, irreversível.
  const prices = new Map([
    ['citrino@1+0', { median: 3800000, average: 3800000, samples: 6, rival: 0 }]
  ]);
  const p = planRound({
    items: [item()], catalog, prices, limit: 10, active: 0, rate: 380000,
    config: { enabled: true, currency: 'diamond' }
  });
  assert.equal(p.ready.length, 1);
  assert.equal(p.ready[0].currency, 'diamond');
  assert.equal(p.ready[0].unitPrice, 10);
  assert.equal(p.ready[0].from.rate, 380000, 'a taxa usada vai para o relatório');
  assert.equal(p.ready[0].from.goldPrice, 3800000);
});

test('sem cotação, a rodada em diamante não anuncia nada', () => {
  const prices = new Map([
    ['citrino@1+0', { median: 3800000, average: 3800000, samples: 6, rival: 0 }]
  ]);
  const p = planRound({
    items: [item()], catalog, prices, limit: 10, active: 0,
    config: { enabled: true, currency: 'diamond' }
  });
  assert.deepEqual(p.ready, []);
  assert.equal(p.skipped[0].reason, 'price.noRate');
});

test('o mínimo de ouro é avaliado em ouro, mesmo anunciando em diamante', () => {
  // O corte se chama `minGold` e é em ouro: comparado contra o preço em
  // diamante, um mínimo de 50.000 recusaria todo anúncio da moeda — nenhum
  // deles chega perto desse número em diamantes.
  const prices = new Map([
    ['citrino@1+0', { median: 3800000, average: 3800000, samples: 6, rival: 0 }]
  ]);
  const base = {
    items: [item()], catalog, prices, limit: 10, active: 0, rate: 380000
  };
  assert.equal(planRound({
    ...base, config: { enabled: true, currency: 'diamond', minGold: 1000000 }
  }).ready.length, 1, '3,8 M de ouro passa num mínimo de 1 M');

  const corta = planRound({
    ...base, config: { enabled: true, currency: 'diamond', minGold: 9000000 }
  });
  assert.deepEqual(corta.ready, []);
  assert.equal(corta.skipped[0].reason, 'cheap');
  assert.equal(corta.skipped[0].total, 3800000, 'o relatório mostra o valor em ouro');
});

test('a ordem pela vaga compara em ouro, não misturando as duas moedas', () => {
  // Um item com preço direto em diamante e um convertido convivem na mesma
  // lista: 4 diamantes contra 1,5 M de ouro ordenaria pelo menor se a
  // comparação fosse no número cru.
  const prices = new Map([
    // Direto em diamante: 50 💎 o lote, que a 380 k vale ~19 M de ouro.
    ['citrino@1+0', { median: 50, average: 50, samples: 6, rival: 0, directDiamond: true }],
    // Convertido: 1,5 M de ouro vira 4 💎.
    ['pedra@1+0', { median: 1520000, average: 1520000, samples: 6, rival: 0 }]
  ]);
  const p = planRound({
    items: [item({ uid: '1' }), item({ uid: '2', defId: 'pedra' })],
    catalog, prices, limit: 10, active: 0, rate: 380000,
    config: { enabled: true, currency: 'diamond', maxPerRound: 1 }
  });
  // Sem equivalente em ouro, o direto usa o próprio total — e aqui ele perde
  // da pedra, cujo valor em ouro é conhecido e maior. O que o teste fixa é que
  // a comparação usa `sortValue`, não o `total` cru em moedas diferentes.
  assert.equal(p.ready.length, 1);
  assert.equal(p.ready[0].defId, 'pedra');
  assert.equal(p.ready[0].unitPrice, 4);
});

// ------------------------------------------------------------------ correio

test('o resgate casa por subject_key, e não por kind', () => {
  // A regressão que deixava o ouro parado: `kind` é a categoria da
  // correspondência (`market`, `reward`, `return`), e o que diz que a entrada é
  // uma venda é `subject_key`. Casar por `kind: 'market_sale'` nunca dava
  // verdadeiro, e nenhum `claim` saía.
  const ids = claimableMail([
    { id: '1', kind: 'market', subjectKey: 'market_sale', claimed: false },
    { id: '2', kind: 'reward', subjectKey: 'daily_boss', claimed: false },
    { id: '3', kind: 'reward', subjectKey: 'tower', claimed: false },
    { id: '4', kind: 'return', subjectKey: 'return', claimed: false },
    { id: '5', kind: 'market', subjectKey: 'market_offer_refund', claimed: false },
    { id: '6', kind: 'market', subjectKey: 'look_sale', claimed: false }
  ]);
  assert.deepEqual(ids, ['1', '4', '5', '6']);
});

test('compra no mercado fica no correio', () => {
  // Item comprado entrando na bolsa não é trabalho do auto-anunciar, e gastaria
  // o espaço de que ele precisa para anunciar.
  const ids = claimableMail([
    { id: '1', kind: 'market', subjectKey: 'market_purchase', claimed: false },
    { id: '2', kind: 'market', subjectKey: 'market_offer_accepted', claimed: false }
  ]);
  assert.deepEqual(ids, []);
});

test('sem subject_key a categoria do mercado ainda vale', () => {
  // Rede de segurança para uma chave de assunto nova: em `market` e `return`
  // tudo que chega é venda, devolução ou reembolso.
  const ids = claimableMail([
    { id: '1', kind: 'market', claimed: false },
    { id: '2', kind: 'return', claimed: false },
    { id: '3', kind: 'reward', claimed: false }
  ]);
  assert.deepEqual(ids, ['1', '2']);
});

test('entrada já recolhida não é pedida de novo', () => {
  // O servidor mantém a entrada depois do resgate: sem este filtro, cada
  // rodada pediria as mesmas entradas para sempre.
  const ids = claimableMail([
    { id: '1', kind: 'market', subjectKey: 'market_sale', claimed: true },
    { id: '2', kind: 'market', subjectKey: 'market_sale', claimed: false }
  ]);
  assert.deepEqual(ids, ['2']);
});

test('correspondência em análise espera o prazo', () => {
  // O servidor recusa o resgate antes de `held_until_ms`. Tentar gastaria um
  // pedido por rodada, por conta, para sempre receber a mesma recusa.
  const ids = claimableMail([
    { id: '1', kind: 'market', subjectKey: 'market_sale', claimed: false, heldUntil: Date.now() + 3600000 },
    { id: '2', kind: 'market', subjectKey: 'market_sale', claimed: false, heldUntil: Date.now() - 1000 }
  ]);
  assert.deepEqual(ids, ['2']);
});

test('assunto desconhecido fica no correio', () => {
  // Deixar ouro no correio custa um clique; recolher um item errado custa o
  // item.
  assert.deepEqual(claimableMail([{ id: '1', kind: 'system', subjectKey: 'misterio', claimed: false }]), []);
  assert.deepEqual(claimableMail(null), []);
});

// --------------------------------------------------------------- categoria

test('a categoria do item ganha da do catálogo quando vem do servidor', () => {
  assert.equal(categoryOf({ defId: 'citrino', category: 'imbue_materials' }, catalog), 'imbue_materials');
  assert.equal(categoryOf({ defId: 'citrino' }, catalog), 'materials');
  assert.equal(categoryOf({ defId: 'desconhecido' }, catalog), '');
});
