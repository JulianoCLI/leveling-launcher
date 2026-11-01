const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  defaultConfig,
  normalizeConfig,
  isConfigured,
  includesAccount,
  planCadeia,
  planHop,
  hopLiberado,
  proximoIntervalo,
  conferirOferta,
  conferirFecho,
  conferirSaldo,
  precisaAmizade,
  correioDoCambio,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  MIN_RESERVE,
  MIN_AMOUNT
} = require('../src/domain/leveling-cambio');

const NOW = 1700000000000;

/** Configuração ligada, com o resto no padrão. */
const cfg = (over = {}) => normalizeConfig({ enabled: true, ...over });

// ---------------------------------------------------------------- configuração

test('nasce desligado: câmbio move ouro e não tem desfazer', () => {
  const c = defaultConfig();
  assert.equal(c.enabled, false);
  assert.equal(c.destino, 1);
  assert.equal(c.reserva, MIN_RESERVE);
  assert.equal(c.intervaloMs, DEFAULT_INTERVAL_MS);
  assert.equal(isConfigured(c), false);
});

test('normalizeConfig aceita lixo sem quebrar', () => {
  const c = normalizeConfig(null);
  assert.equal(c.enabled, false);
  assert.equal(c.reserva, MIN_RESERVE);
  assert.deepEqual(c.disabled, []);
});

test('reserva nunca cai abaixo do piso, nem por prefs.json editado à mão', () => {
  // O caso que isto impede: zerar cada conta da cadeia e quebrar o refill delas.
  assert.equal(cfg({ reserva: 0 }).reserva, MIN_RESERVE);
  assert.equal(cfg({ reserva: -5000 }).reserva, MIN_RESERVE);
  assert.equal(cfg({ reserva: 'abacaxi' }).reserva, MIN_RESERVE);
  // Acima do piso é escolha do usuário e passa.
  assert.equal(cfg({ reserva: 500000 }).reserva, 500000);
});

test('intervalo fica entre o mínimo e o máximo', () => {
  assert.equal(cfg({ intervaloMs: 1 }).intervaloMs, MIN_INTERVAL_MS);
  assert.equal(cfg({ intervaloMs: 0 }).intervaloMs, DEFAULT_INTERVAL_MS);
  assert.equal(cfg({ intervaloMs: 99 * 3600000 }).intervaloMs, MAX_INTERVAL_MS);
  assert.equal(cfg({ intervaloMs: 600000 }).intervaloMs, 600000);
});

test('mínimo por troca não desce abaixo do chão', () => {
  assert.equal(cfg({ minimo: 1 }).minimo, MIN_AMOUNT);
  assert.equal(cfg({ minimo: 50000 }).minimo, 50000);
});

test('disabled vira lista única e ordenada', () => {
  const c = cfg({ disabled: [5, 2, 5, -1, 'x', 2] });
  assert.deepEqual(c.disabled, [2, 5]);
});

test('includesAccount só vale com o câmbio ligado', () => {
  assert.equal(includesAccount({ enabled: false, disabled: [] }, 3), false);
  assert.equal(includesAccount(cfg({ disabled: [3] }), 3), false);
  assert.equal(includesAccount(cfg({ disabled: [3] }), 4), true);
});

// ---------------------------------------------------------------------- cadeia

test('a cadeia desce da conta mais alta até o destino', () => {
  // Contas 1..5 (0-based 0..4), destino conta 1.
  const hops = planCadeia(cfg({ destino: 1 }), [0, 1, 2, 3, 4]);
  assert.deepEqual(hops, [
    { de: 4, para: 3 },
    { de: 3, para: 2 },
    { de: 2, para: 1 },
    { de: 1, para: 0 }
  ]);
});

test('conta offline some da cadeia e o hop pula por cima dela', () => {
  // A conta 7 (índice 6) não está ativa: o caminho tem de existir de fato,
  // então o ouro vai de 8 direto para 6.
  const hops = planCadeia(cfg({ destino: 1 }), [0, 5, 7]);
  assert.deepEqual(hops, [
    { de: 7, para: 5 },
    { de: 5, para: 0 }
  ]);
});

test('conta excluída é tratada como inexistente, não como parada', () => {
  const hops = planCadeia(cfg({ destino: 1, disabled: [1] }), [0, 1, 2]);
  // A conta 2 não doa nem serve de ponte: o ouro de 3 passa direto para 1.
  assert.deepEqual(hops, [{ de: 2, para: 0 }]);
});

test('o destino entra na cadeia mesmo marcado como excluído', () => {
  // "Excluído" quer dizer "não doa", não "não recebe" — sem o destino não há
  // cadeia nenhuma.
  const hops = planCadeia(cfg({ destino: 1, disabled: [0] }), [0, 1]);
  assert.deepEqual(hops, [{ de: 1, para: 0 }]);
});

test('sem o destino ativo não há cadeia', () => {
  assert.deepEqual(planCadeia(cfg({ destino: 1 }), [1, 2, 3]), []);
});

test('destino sozinho não gera hop', () => {
  assert.deepEqual(planCadeia(cfg({ destino: 1 }), [0]), []);
});

test('conta abaixo do destino não participa', () => {
  // Destino é a conta 3 (índice 2); as contas 1 e 2 não têm para onde descer.
  const hops = planCadeia(cfg({ destino: 3 }), [0, 1, 2, 3, 4]);
  assert.deepEqual(hops, [
    { de: 4, para: 3 },
    { de: 3, para: 2 }
  ]);
});

test('origem limita o topo da cadeia', () => {
  // origem = conta 3 (índice 2): nada acima dela entra.
  const hops = planCadeia(cfg({ destino: 1, origem: 3 }), [0, 1, 2, 3, 4]);
  assert.deepEqual(hops, [
    { de: 2, para: 1 },
    { de: 1, para: 0 }
  ]);
});

test('câmbio desligado não produz cadeia', () => {
  assert.deepEqual(planCadeia({ enabled: false }, [0, 1, 2]), []);
});

// ------------------------------------------------------------------------ hop

test('só sai o que passa da reserva', () => {
  const plano = planHop(cfg({ reserva: 100000 }), 750000);
  assert.equal(plano.skip, false);
  assert.equal(plano.gold, 650000);
  assert.equal(plano.reserva, 100000);
});

test('saldo igual à reserva não troca', () => {
  const plano = planHop(cfg({ reserva: 100000 }), 100000);
  assert.equal(plano.skip, true);
  assert.equal(plano.reason, 'cambio.abaixoDaReserva');
  assert.equal(plano.gold, 0);
});

test('saldo abaixo da reserva não troca', () => {
  const plano = planHop(cfg({ reserva: 100000 }), 42);
  assert.equal(plano.skip, true);
  assert.equal(plano.reason, 'cambio.abaixoDaReserva');
});

test('sobra pequena demais não paga o hop', () => {
  // 100.500 com reserva de 100.000 deixa 500 disponíveis: menos que o mínimo.
  const plano = planHop(cfg({ reserva: 100000, minimo: 1000 }), 100500);
  assert.equal(plano.skip, true);
  assert.equal(plano.reason, 'cambio.poucoParaValer');
});

test('não há teto por troca: o saldo inteiro acima da reserva sai de uma vez', () => {
  const plano = planHop(cfg({ reserva: 100000 }), 50000000);
  assert.equal(plano.skip, false);
  assert.equal(plano.gold, 49900000);
});

// ---------------------------------------------------------------------- ritmo

test('o primeiro hop sai na hora', () => {
  assert.equal(hopLiberado(cfg(), 0, NOW), true);
});

test('o hop seguinte espera o intervalo inteiro', () => {
  const c = cfg({ intervaloMs: 600000 });
  assert.equal(hopLiberado(c, NOW, NOW + 599999), false);
  assert.equal(hopLiberado(c, NOW, NOW + 600000), true);
});

test('o jitter mexe no intervalo mas respeita o mínimo', () => {
  const c = cfg({ intervaloMs: 600000 });
  assert.equal(proximoIntervalo(c, () => 0), 480000);   // -20%
  assert.equal(proximoIntervalo(c, () => 1), 720000);   // +20%
  assert.equal(proximoIntervalo(c, () => 0.5), 600000); // no centro
  // Nem o pior jitter derruba o intervalo abaixo do piso.
  const curto = cfg({ intervaloMs: MIN_INTERVAL_MS });
  assert.ok(proximoIntervalo(curto, () => 0) >= MIN_INTERVAL_MS);
});

// ------------------------------------------------------- conferência da oferta

/** `TradeState` como o servidor manda, medido na sonda. */
const estado = (over = {}) => ({
  id: '324',
  me: { account: '16751', name: 'credo', items: [], shadows: [], gold: '50000' },
  partner: { account: '14803', name: 'mortemorrida', items: [], shadows: [] },
  version: 2,
  ...over
});

const plano = { gold: 50000, meAccount: '16751', partnerAccount: '14803' };

test('oferta certa passa', () => {
  assert.equal(conferirOferta(estado(), plano).ok, true);
});

test('ouro divergente barra a trava', () => {
  const r = conferirOferta(estado({
    me: { account: '16751', items: [], shadows: [], gold: '60000' }
  }), plano);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cambio.ouroDivergente');
});

test('item na oferta aborta: a automação só troca ouro', () => {
  const r = conferirOferta(estado({
    me: { account: '16751', items: [{ uid: '9' }], shadows: [], gold: '50000' }
  }), plano);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cambio.itemNaOferta');
});

test('sombra na oferta aborta', () => {
  const r = conferirOferta(estado({
    partner: { account: '14803', items: [], shadows: [{ uid: '3' }] }
  }), plano);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cambio.sombraNaOferta');
});

test('parceiro ofertando ouro aborta: a troca é de mão única', () => {
  const r = conferirOferta(estado({
    partner: { account: '14803', items: [], shadows: [], gold: '10' }
  }), plano);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cambio.parceiroOfertou');
});

test('conta errada do outro lado aborta', () => {
  const r = conferirOferta(estado({
    partner: { account: '99999', items: [], shadows: [] }
  }), plano);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cambio.parceiroErrado');
});

test('estado sem troca aberta aborta', () => {
  const r = conferirOferta({ me: {}, partner: {} }, plano);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cambio.semTrocaAberta');
});

test('proto3 omite o zero: oferta vazia contra plano zero não é aceita como troca', () => {
  // `gold` ausente vira 0, e um plano de 0 não deveria existir — o planHop já
  // teria pulado. Aqui o que importa é não travar uma oferta vazia por engano.
  const r = conferirOferta(estado({
    me: { account: '16751', items: [], shadows: [] }
  }), plano);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cambio.ouroDivergente');
});

// --------------------------------------------------------- conferência do fecho

test('fecho medido no servidor passa, e sem taxa', () => {
  // Valores reais da sonda, trade 17837.
  const r = conferirFecho(
    { id: '17837', partner: 'mortemorrida', given_gold: '50000' },
    { id: '17837', partner: 'credo', received_gold: '50000' },
    { gold: 50000 }
  );
  assert.equal(r.ok, true);
  assert.equal(r.gold, 50000);
  assert.equal(r.mailed, false);
  assert.equal(r.heldUntil, 0);
});

test('fecho ausente nos dois lados não é sucesso', () => {
  const r = conferirFecho({}, {}, { gold: 50000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cambio.semFecho');
});

test('recebido menor que o dado para a cadeia', () => {
  const r = conferirFecho(
    { given_gold: '50000' },
    { received_gold: '45000' },
    { gold: 50000 }
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cambio.recebeuDiferente');
});

test('correio é reportado, não ignorado', () => {
  const r = conferirFecho(
    { given_gold: '50000' },
    { received_gold: '50000', mailed: true, held_until_ms: '1700000900000' },
    { gold: 50000 }
  );
  assert.equal(r.ok, true);
  assert.equal(r.mailed, true);
  assert.equal(r.heldUntil, 1700000900000);
});

// --------------------------------------------------------- conferência do saldo

test('saldo bate dos dois lados', () => {
  const r = conferirSaldo(7726267, 7676267, 850875, 900875, 50000);
  assert.equal(r.ok, true);
  assert.equal(r.entrada, 50000);
});

test('quem deu pode ter ganho ouro caçando no meio da troca', () => {
  // Saldo acima do esperado é normal: a conta estava rendendo.
  const r = conferirSaldo(7726267, 7680000, 850875, 900875, 50000);
  assert.equal(r.ok, true);
});

test('saldo da origem abaixo do esperado é inexplicável e para a cadeia', () => {
  const r = conferirSaldo(7726267, 7000000, 850875, 900875, 50000);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cambio.saldoOrigemBaixo');
});

test('destino que não recebeu o esperado para a cadeia', () => {
  const r = conferirSaldo(7726267, 7676267, 850875, 860875, 50000);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cambio.saldoDestinoBaixo');
});

// -------------------------------------------------------------------- amizade

test('sem amigos, precisa pedir', () => {
  assert.equal(precisaAmizade({ friends: [], incoming: [], outgoing: [] }, '14803'), true);
});

test('já amigo não pede de novo', () => {
  const lista = { friends: [{ account: '14803', name: 'mortemorrida' }] };
  assert.equal(precisaAmizade(lista, '14803'), false);
});

test('amizade com outra conta não serve', () => {
  const lista = { friends: [{ account: '11111' }] };
  assert.equal(precisaAmizade(lista, '14803'), true);
});

test('o id vem como string do servidor e como número do launcher', () => {
  const lista = { friends: [{ account: '14803' }] };
  assert.equal(precisaAmizade(lista, 14803), false);
});

test('lista ausente não explode', () => {
  assert.equal(precisaAmizade(null, '14803'), true);
  assert.equal(precisaAmizade({}, '14803'), true);
});

// -------------------------------------------------------------------- correio

test('recolhe a venda que é só ouro', () => {
  const ids = correioDoCambio([
    { id: '1', kind: 'market', subjectKey: 'market_sale', gold: 480000 }
  ]);
  assert.deepEqual(ids, ['1']);
});

test('entrada com item fica no correio', () => {
  // Resgate com a bolsa cheia é **parcial** e silencioso: o câmbio não abre
  // essa porta por ouro que ele nem precisa.
  assert.deepEqual(correioDoCambio([{ id: '1', gold: 500, items: 1 }]), []);
});

test('entrada com diamante fica no correio', () => {
  // Ouro mais diamante é recompensa, não venda.
  assert.deepEqual(correioDoCambio([{ id: '1', gold: 500, diamonds: 10 }]), []);
});

test('entrada sem ouro nenhum é ignorada', () => {
  assert.deepEqual(correioDoCambio([{ id: '1', gold: 0 }]), []);
});

test('o que já foi recolhido não é pedido de novo', () => {
  // O servidor mantém a entrada depois do resgate.
  assert.deepEqual(correioDoCambio([{ id: '1', gold: 500, claimed: true }]), []);
});

test('a retida para análise espera o prazo', () => {
  const agora = 1000000;
  assert.deepEqual(correioDoCambio([{ id: '1', gold: 500, heldUntil: agora + 60000 }], agora), []);
  // Passado o prazo, entra.
  assert.deepEqual(correioDoCambio([{ id: '1', gold: 500, heldUntil: agora - 1 }], agora), ['1']);
});

test('caixa ausente não explode', () => {
  assert.deepEqual(correioDoCambio(null), []);
  assert.deepEqual(correioDoCambio(undefined), []);
});
