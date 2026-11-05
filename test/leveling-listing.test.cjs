const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
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
  OUTLIER_FACTOR
} = require('../src/domain/leveling-listing');

/** Vendas como o banco entrega: mais recente primeiro. */
const vendas = (...precos) => precos.map(p => ({ unit_price: p }));

/**
 * Um uid de item real, acima de 2^53.
 *
 * `Number(UID_GRANDE)` devolve `...616000` — um uid vizinho que **existe** no
 * jogo. Foi esse arredondamento que anunciou a peça errada.
 */
const UID_GRANDE = '1962493714927616001';

// ------------------------------------------------------------- mediana

test('a mediana de uma lista ímpar é o do meio, e a de par é a média dos dois', () => {
  assert.equal(medianOf([1, 2, 3]), 2);
  assert.equal(medianOf([1, 2, 3, 4]), 2.5);
  assert.equal(medianOf([]), 0);
});

// ------------------------------------------------------------- preço automático

test('o caso que motivou o corte: duas vendas de 1 M e uma de 10 M', () => {
  // Anunciar pelo máximo cru copiaria o erro de quem digitou um zero a mais,
  // e o item ficaria parado. Pela mediana se venderia barato. O que se quer é
  // o topo *do que é preço de verdade*.
  const r = suggestPrice(vendas(1000000, 1000000, 10000000));
  assert.equal(r.price, 1000000);
  assert.equal(r.dropped, 1, 'A venda anormal tem de ser contada, para a tela poder explicar');
  assert.equal(r.median, 1000000);
});

test('sem venda anormal nada é descartado e o preço é o topo real', () => {
  // Um corte que mordesse aqui seria pior que não ter corte: ele jogaria fora
  // justamente o preço bom, que é o motivo do automático existir.
  const r = suggestPrice(vendas(1000, 1200, 1400, 1100));
  assert.equal(r.price, 1400);
  assert.equal(r.dropped, 0);
});

test('o dobro da mediana ainda é preço de mercado, não anomalia', () => {
  // Preço de item oscila de verdade. O fator é 2,5 justamente para não
  // confundir volatilidade com erro de digitação.
  const r = suggestPrice(vendas(1000, 1000, 2000));
  assert.equal(r.price, 2000);
  assert.equal(r.dropped, 0);
  assert.ok(OUTLIER_FACTOR > 2, 'O corte precisa de folga sobre o dobro');
});

test('o automático se recusa a inventar preço com uma venda só', () => {
  // Uma venda não tem mediana, e o número sozinho pode ser o erro de alguém.
  // Devolver um preço aqui seria o automático chutando com cara de cálculo.
  const r = suggestPrice(vendas(999));
  assert.equal(r.price, 0);
  assert.equal(r.reason, 'price.fewSales');
});

test('sem venda nenhuma o automático não devolve preço', () => {
  assert.equal(suggestPrice([]).price, 0);
  assert.equal(suggestPrice(null).price, 0);
});

test('só as dez últimas entram, e são as últimas, não as mais baratas', () => {
  // A ordem de chegada é a do banco: mais recente primeiro. Ordenar antes de
  // cortar trocaria "as dez últimas vendas" por "as dez mais baratas de
  // sempre", e o preço sugerido despencaria num item que subiu.
  const antigasBaratas = Array(5).fill(100);
  const recentesCaras = Array(10).fill(5000);
  const r = suggestPrice(vendas(...recentesCaras, ...antigasBaratas));
  assert.equal(r.samples, SAMPLE_SIZE);
  assert.equal(r.price, 5000, 'As vendas velhas e baratas não podem puxar o preço para baixo');
});

test('preço zero ou negativo é descartado antes da conta', () => {
  const r = suggestPrice([{ unit_price: 0 }, { unit_price: 1000 }, { unit_price: 1200 }]);
  assert.equal(r.samples, 2);
  assert.equal(r.price, 1200);
});

// -------------------------------------------------- modo média ponderada

test('o modo média devolve a média ponderada pela quantidade', () => {
  // Uma venda de 100 unidades a 1 M diz muito mais sobre o preço corrente que
  // uma de 1 unidade a 2 M. A média aritmética daria 1,5 M às duas.
  const r = suggestPrice([
    { unit_price: 1000000, quantity: 100 },
    { unit_price: 2000000, quantity: 1 }
  ], { mode: 'average' });
  assert.equal(r.price, 1009901, '(100 M + 2 M) / 101');
  assert.equal(r.mode, 'average');
});

test('o modo padrão continua sendo o topo, e a média acompanha', () => {
  // A média volta mesmo no modo `top`: o relatório compara as duas, e quem
  // chama sem opções não pode ver o comportamento mudar.
  const r = suggestPrice(vendas(1000, 1200, 1400));
  assert.equal(r.price, 1400);
  assert.equal(r.mode, 'top');
  assert.equal(r.average, 1200);
  assert.equal(suggestPrice(vendas(1000, 1200, 1400), { mode: 'medio' }).price, 1400,
    'modo desconhecido cai no topo');
});

test('a venda anormal é descartada antes da média, não depois', () => {
  // Com 1 M, 1 M e 10 M a média crua é 4 M, um preço pelo qual o item nunca
  // vai sair. Na média o zero digitado a mais contamina o resultado inteiro.
  const r = suggestPrice(vendas(1000000, 1000000, 10000000), { mode: 'average' });
  assert.equal(r.price, 1000000);
  assert.equal(r.dropped, 1);
});

test('quantidade ausente vale uma unidade, não zero', () => {
  // Zero removeria a venda do peso da média, e o lote de uma unidade é o caso
  // mais comum do banco — a média sairia de uma amostra vazia.
  const r = suggestPrice(vendas(1000, 2000, 3000), { mode: 'average' });
  assert.equal(r.price, 2000);
});

// ------------------------------------------------------------- lote

test('a sugestão de um lote é o unitário vezes a quantidade', () => {
  // O bug que isto fecha: o campo da tela é o preço do pacote, mas
  // `suggestPrice` olha `unit_price` e devolve por unidade. Pôr o unitário no
  // campo do pacote anunciava dez unidades pelo preço de uma — a 38 000 cada
  // em vez de 380 000, para o primeiro comprador que passasse.
  assert.equal(lotPrice(380000, 10), 3800000);
});

test('item solto tem lote igual ao unitário', () => {
  assert.equal(lotPrice(5000, 1), 5000);
  // Quantidade ausente ou zero é um item, não zero itens: devolver 0 aqui
  // ofereceria anunciar de graça.
  assert.equal(lotPrice(5000, 0), 5000);
  assert.equal(lotPrice(5000), 5000);
});

test('sem sugestão não há lote: zero continua zero', () => {
  // Zero é "não sei o preço", e a tela o trata como "digite o valor".
  // Multiplicar não pode inventar um número a partir da ignorância.
  assert.equal(lotPrice(0, 10), 0);
});

test('o lote e a volta ao unitário são coerentes', () => {
  // A ida é `lotPrice`, a volta é o `unitPrice` de `normalizeDraft`. Se as
  // duas não fecharem, o preço muda só por passar pela tela.
  const unit = 378000;
  const total = lotPrice(unit, 10);
  assert.equal(normalizeDraft({ uid: 1, quantity: 10, total }).unitPrice, unit);
});

// ------------------------------------------------------------- vendável

test('item equipado não pode ser anunciado, e o motivo é dito', () => {
  // Esconder a linha faria o usuário procurar um item que está na tela do
  // jogo. Dizer "equipado" deixa claro que basta tirar.
  assert.equal(sellableReason({ uid: 1, equipped_slot: 'EQUIP_SLOT_PEITORAL' }), 'equipped');
  assert.equal(sellableReason({ uid: 1, equipped_slot: 'EQUIP_SLOT_UNSPECIFIED' }), '');
});

test('item trancado continua anunciável: o cadeado sai no preparo', () => {
  // O cadeado é desfazível por pedido, e o usuário pediu que anunciar o
  // tirasse sozinho. Recusar aqui escondia a linha e fazia a aba afirmar que o
  // item não existia.
  assert.equal(sellableReason({ uid: 1, locked: true }), '');
});

test('o preparo lista o que destrancar e o que trazer do depósito', () => {
  const items = [
    { uid: '1', locked: true, scope: 1 },
    { uid: '2', locked: false, scope: 3 },
    { uid: '3', locked: true, scope: 3 },
    { uid: '4', locked: false, scope: 1 }
  ];
  const p = prepareListings([{ uid: '1' }, { uid: '2' }, { uid: '3' }, { uid: '4' }], items);
  assert.deepEqual(p.unlock, ['1', '3']);
  assert.deepEqual(p.toBag, ['2', '3']);
});

test('o preparo ignora rascunho que não está no inventário lido', () => {
  // A tela pode estar olhando uma leitura antiga. Mexer no inventário por um
  // uid que o servidor não confirmou seria agir às cegas.
  const p = prepareListings([{ uid: '99' }], [{ uid: '1', locked: true, scope: 3 }]);
  assert.deepEqual(p.unlock, []);
  assert.deepEqual(p.toBag, []);
});

test('item já na mochila e destrancado não gera pedido nenhum', () => {
  const p = prepareListings([{ uid: '4' }], [{ uid: '4', locked: false, scope: 1 }]);
  assert.deepEqual(p.unlock, []);
  assert.deepEqual(p.toBag, []);
});

test('linha sem uid é recusada: MarketCreate exige o uid', () => {
  // Sem uid o pedido anunciaria outro item, ou nenhum. Nunca às cegas.
  assert.equal(sellableReason({ locked: false }), 'no_uid');
});

test('item solto e destrancado é vendável', () => {
  assert.equal(sellableReason({ uid: 77, qty: 3 }), '');
});

// ------------------------------------------------------- precisão do uid

test('o uid atravessa o domínio como texto, sem arredondar', () => {
  // A conversão para número é o bug: o uid vizinho existe, então o servidor
  // aceita o anúncio e vende outra peça, sem erro nenhum.
  assert.equal(uid64(UID_GRANDE), UID_GRANDE);
  assert.notEqual(uid64(UID_GRANDE), String(Number(UID_GRANDE)));

  // Ausência de uid é ausência, não um uid.
  assert.equal(uid64(0), '');
  assert.equal(uid64('000'), '');
  assert.equal(uid64(''), '');
  assert.equal(uid64(null), '');
  assert.equal(uid64(undefined), '');
  assert.equal(uid64('não é número'), '');
  assert.equal(uid64(-7), '', 'uid negativo não existe');
  // Notação científica chega a ter `Number` válido, e é justamente a forma em
  // que um uid grande já estragado se apresenta.
  assert.equal(uid64('1e21'), '');
  // Zeros à esquerda são normalizados para a comparação com o inventário
  // poder ser por igualdade crua.
  assert.equal(uid64('007'), '7');
});

test('o rascunho preserva o uid grande: era o item errado no jogo', () => {
  const d = normalizeDraft({ uid: UID_GRANDE, quantity: 1, total: 500 });
  assert.equal(d.uid, UID_GRANDE, 'o uid não pode perder o último dígito');
  assert.equal(typeof d.uid, 'string', 'número não representa uint64');
});

test('o preparo casa o uid grande: sem isso o anúncio é recusado', () => {
  // O não-casamento era silencioso: nada é destrancado, nada vem do depósito,
  // e o `MarketCreate` volta `market.locked` ou `item_not_in_bag` sem que a
  // tela saiba que a culpa foi do arredondamento.
  const items = [{ uid: UID_GRANDE, locked: true, scope: 3 }];
  const p = prepareListings([{ uid: UID_GRANDE }], items);
  assert.deepEqual(p.unlock, [UID_GRANDE]);
  assert.deepEqual(p.toBag, [UID_GRANDE]);
});

test('o uid vizinho não é confundido com o pedido', () => {
  // Os dois uids diferem no último dígito, e `Number` os torna iguais. Se o
  // domínio ainda convertesse, este rascunho mexeria na peça errada.
  const vizinho = '1962493714927616000';
  const p = prepareListings([{ uid: UID_GRANDE }], [{ uid: vizinho, locked: true, scope: 3 }]);
  assert.deepEqual(p.unlock, [], 'o item pedido não está no inventário lido');
  assert.deepEqual(p.toBag, []);
});

test('o bloqueio por falta de preço reporta o uid intacto', () => {
  // O relatório é o que o usuário usa para achar o item no jogo: um uid
  // arredondado aponta para outra peça.
  const plano = planListings([{ uid: UID_GRANDE, name: 'Citrino', quantity: 1, total: 0 }]);
  assert.deepEqual(plano.ready, []);
  assert.equal(plano.blocked[0].uid, UID_GRANDE);
  assert.equal(plano.blocked[0].reason, 'price.missing');
});

// --------------------------------------------------- separação de anúncios

test('anúncio vendido não entra em "à venda agora"', () => {
  // Era a confusão relatada: `mine` devolve todos os status, e a aba punha
  // tudo em "À venda agora". O vendido não tem expiração porque já fechou.
  const r = splitListings([
    { id: 1, status: 'MARKET_STATUS_ACTIVE' },
    { id: 2, status: 'MARKET_STATUS_SOLD' }
  ]);
  assert.deepEqual(r.active.map(l => l.id), [1]);
  assert.deepEqual(r.sold.map(l => l.id), [2]);
});

test('expirado e cancelado não são venda nem anúncio de pé', () => {
  const r = splitListings([
    { id: 1, status: 'MARKET_STATUS_EXPIRED' },
    { id: 2, status: 'MARKET_STATUS_CANCELED' }
  ]);
  assert.deepEqual(r.active, []);
  assert.deepEqual(r.sold, []);
  assert.equal(r.closed.length, 2);
});

test('status ausente conta como ativo: proto3 omite o zero', () => {
  // Sumir com um anúncio de pé é o pior erro possível aqui.
  const r = splitListings([{ id: 1 }, { id: 2, status: 'MARKET_STATUS_UNSPECIFIED' }]);
  assert.equal(r.active.length, 2);
});

test('a venda vinda do servidor admite não saber o líquido', () => {
  // `MarketListing` não traz taxa nem líquido. Estimá-los daria um número com
  // cara de exato que nenhuma fonte confirmou.
  const s = saleFromListing({
    id: 7, def_id: 'gema-opala', name: 'Opala', quantity: 2,
    total: 300000, unit_price: 150000, buyer_name: 'alguem', closed_at_ms: 1700
  });
  assert.equal(s.listing_id, '7');
  assert.equal(s.total, 300000);
  assert.equal(s.net, 0);
  assert.equal(s.sold_at_ms, 1700);
  assert.equal(s.source, 'server');
});

test('a venda do banco ganha da do servidor: ela tem o líquido real', () => {
  const local = [{ listing_id: '7', total: 300000, net: 285000, sold_at_ms: 1700 }];
  const servidor = [saleFromListing({ id: 7, total: 300000, closed_at_ms: 1700 })];
  const r = mergeSales(local, servidor);
  assert.equal(r.length, 1, 'a mesma venda não pode aparecer duas vezes');
  assert.equal(r[0].net, 285000);
});

test('a venda que só o servidor lembra entra no histórico', () => {
  // O banco só grava o push `market_push`, que exige o launcher aberto na
  // hora exata. O servidor cobre o buraco.
  const r = mergeSales(
    [{ listing_id: '7', sold_at_ms: 100 }],
    [saleFromListing({ id: 9, closed_at_ms: 500 })]
  );
  assert.deepEqual(r.map(s => s.listing_id), ['9', '7'], 'mais recente primeiro');
});

test('venda sem listing_id entra mesmo assim: perder uma é pior que repetir', () => {
  const r = mergeSales([], [{ listing_id: '', sold_at_ms: 1 }, { listing_id: '', sold_at_ms: 2 }]);
  assert.equal(r.length, 2);
});

// ------------------------------------------------------------- rascunho

test('o preço digitado é o do pacote, e o servidor recebe o unitário', () => {
  // O usuário pediu que lote seja anunciado inteiro: ele pensa em "quanto
  // quero pelos 10", mas `MarketCreate.unit_price` é por unidade.
  const d = normalizeDraft({ uid: 5, quantity: 10, total: 3780000 });
  assert.equal(d.total, 3780000);
  assert.equal(d.unitPrice, 378000);
});

test('o unitário arredonda para cima: o lote nunca sai por menos que o pedido', () => {
  // 1000 / 3 = 333,33. Arredondar para baixo venderia os três por 999.
  const d = normalizeDraft({ uid: 5, quantity: 3, total: 1000 });
  assert.equal(d.unitPrice, 334);
  assert.ok(d.unitPrice * 3 >= 1000);
});

test('rascunho sem preço ou sem uid não vira anúncio', () => {
  assert.equal(normalizeDraft({ uid: 5, total: 0 }), null);
  assert.equal(normalizeDraft({ total: 100 }), null);
});

test('a duração é fixa em dois dias', () => {
  assert.equal(normalizeDraft({ uid: 1, total: 10 }).hours, 48);
});

// ------------------------------------------------------------- plano

test('o que falta preço fica separado do que está pronto', () => {
  // Uma lista só, com linhas inválidas no meio, levaria a confirmar sem ver.
  // São dois pedidos diferentes: "confirma?" e "digita o valor".
  const p = planListings([
    { uid: 1, name: 'Topázio', quantity: 1, total: 5000 },
    { uid: 2, name: 'Citrino', quantity: 1, total: 0 }
  ]);
  assert.equal(p.ready.length, 1);
  assert.equal(p.blocked.length, 1);
  assert.equal(p.blocked[0].reason, 'price.missing');
  assert.equal(p.blocked[0].name, 'Citrino', 'O bloqueado precisa ser nomeável na tela');
});

test('o total da confirmação é somado por moeda, nunca junto', () => {
  // Ouro e diamante têm ordens de grandeza diferentes; um total somado não
  // corresponderia a nada que vai acontecer.
  const p = planListings([
    { uid: 1, quantity: 1, total: 5000 },
    { uid: 2, quantity: 1, total: 90, currency: 'diamond' }
  ]);
  assert.equal(p.totalGold, 5000);
  assert.equal(p.totalDiamond, 90);
});
