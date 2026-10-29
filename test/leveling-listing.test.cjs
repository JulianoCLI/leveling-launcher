const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  suggestPrice,
  lotPrice,
  sellableReason,
  normalizeDraft,
  planListings,
  medianOf,
  SAMPLE_SIZE,
  OUTLIER_FACTOR
} = require('../src/domain/leveling-listing');

/** Vendas como o banco entrega: mais recente primeiro. */
const vendas = (...precos) => precos.map(p => ({ unit_price: p }));

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

test('item trancado no jogo é respeitado', () => {
  assert.equal(sellableReason({ uid: 1, locked: true }), 'locked');
});

test('linha sem uid é recusada: MarketCreate exige o uid', () => {
  // Sem uid o pedido anunciaria outro item, ou nenhum. Nunca às cegas.
  assert.equal(sellableReason({ locked: false }), 'no_uid');
});

test('item solto e destrancado é vendável', () => {
  assert.equal(sellableReason({ uid: 77, qty: 3 }), '');
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
