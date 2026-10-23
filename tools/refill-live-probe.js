/**
 * @file refill-live-probe.js
 * Roda o auto-refill real do launcher contra o servidor de produção.
 *
 * As outras sondas testaram pacotes soltos. Esta usa o `LevelingHeadlessClient`
 * de verdade, com uma configuração de refill de verdade, e cronometra o ciclo
 * inteiro: viagem, caminhada, compra em duas passagens e volta à caçada.
 *
 * É o teste que as suítes não podem fazer — lá o servidor é um mock, e o que
 * importa aqui é se o servidor real aceita a sequência.
 *
 *   node tools/refill-live-probe.js --user U --pass P
 *     --target N  alvo de estoque (padrão 3)
 *     --multi     quatro itens numa viagem, para medir se cabem juntos
 *     --diag      imprime cada guarda de `maybeRefill`, para refill que não parte
 *
 * COMPRA DE VERDADE: repõe até 3 poções pequenas de vida, poucas dezenas de
 * ouro. Tira a conta da caçada por ~3 s e a devolve.
 *
 * Ferramenta de investigação, não parte do launcher.
 */

'use strict';

const { LevelingHeadlessClient } = require('../src/domain/leveling-headless-service');

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

const opts = args();
if (!opts.user || !opts.pass) {
  console.error('uso: node tools/refill-live-probe.js --user U --pass P');
  process.exit(1);
}

const T0 = Date.now();
const ms = () => String(Date.now() - T0).padStart(6) + 'ms';
const log = (...a) => console.log(ms(), ...a);

// Alvo pequeno de propósito: o que se mede é o ciclo, não o estoque.
const alvo = Number(opts.target) || 3;

const client = new LevelingHeadlessClient(0, {
  username: opts.user,
  password: opts.pass,
  autoReconnect: false,
  refillConfig: {
    enabled: true,
    reserveGold: 0,
    items: opts.multi
      // Vários itens: o que se mede é se cabem na mesma ida à cidade.
      ? {
          hpPequena: { min: alvo, target: alvo },
          manaPequena: { min: alvo, target: alvo },
          revivePequena: { min: 2, target: 2 },
          essence: { min: alvo, target: alvo }
        }
      : { hpPequena: { min: alvo, target: alvo } }
  }
});

// Espiona os pacotes de saída para reconstruir o ciclo a partir do fio.
const envio = [];
const encodeOriginal = client.codec.encode.bind(client.codec);
client.codec.encode = (id, caseName, value) => {
  if (caseName !== 'ping') {
    envio.push({ at: Date.now() - T0, caseName });
    log(`→ ${caseName} ${JSON.stringify(value)}`);
  }
  return encodeOriginal(id, caseName, value);
};

let cena = '';
client.on('update', ({ state }) => {
  if (state.scene.id !== cena) {
    cena = state.scene.id;
    log(`cena: ${cena} (${state.scene.kind})`);
  }
});

client.on('status', e => log(`status: ${e.status}${e.error ? ' — ' + e.error : ''}`));

// Por que o refill não partiu? Cada guarda de `maybeRefill`, explícita.
// Atrás de `--diag` porque isto substitui um método do cliente: útil para
// investigar um refill que não parte, ruído em qualquer outra corrida.
const maybeOriginal = client.maybeRefill.bind(client);
let diag = 0;
if (opts.diag) client.maybeRefill = () => {
  if (diag++ < 6) {
    const plano = client.catalog ? client.planRefill() : null;
    log(`maybeRefill: busy=${client.refillBusy} open=${client.isOpen()} status=${client.status}` +
      ` catalogo=${!!client.catalog} bilhete=${JSON.stringify(client.huntTicket)}` +
      ` espera=${Math.max(0, client.refillAt - Date.now())}ms` +
      ` pedidos=${plano ? plano.orders.length : 'n/d'}` +
      ` descartados=${plano ? JSON.stringify(plano.skipped) : 'n/d'}` +
      ` estoque=${client.state.stock.hp.pequena} nivel=${client.state.level}`);
  }
  return maybeOriginal();
};
client.on('ended', e => log(`sessão encerrada: ${e.code}`));

let feito = false;
client.on('refill', e => {
  feito = true;
  if (e.ok) {
    log(`REFILL OK — custo ${e.cost}`);
    for (const item of e.items) log(`   ${item.label}: ${item.qty} un, ${item.cost} de ouro`);
  } else {
    log(`REFILL FALHOU — ${e.error}`);
    for (const item of e.items || []) log(`   comprado antes da falha: ${item.label} ${item.qty}`);
  }
});

client.connect();

const fim = () => {
  const s = client.state;
  log('');
  log('== resultado');
  log(`   cena final  : ${s.scene.id} (${s.scene.kind})`);
  log(`   caçada      : ${s.hunt.gateId} tier ${s.hunt.tierMin} ${s.hunt.difficulty}`);
  log(`   hp pequena  : ${s.stock.hp.pequena} (alvo ${alvo})`);
  log(`   ouro        : ${s.gold}`);
  log(`   preços reais: ${JSON.stringify(client.learnedPrices)}`);
  log(`   viagem presa: ${client.tripInterrupted}`);

  // O número que decide se o recurso presta: quanto a conta ficou fora.
  const travel = envio.find(p => p.caseName === 'travel');
  const volta = envio.filter(p => p.caseName === 'start_hunt').pop();
  if (travel && volta) {
    log(`   TEMPO FORA DA CAÇADA: ${volta.at - travel.at}ms`);
  } else if (!travel) {
    log('   nenhuma viagem: o estoque já estava no alvo.');
  }

  const sequencia = envio
    .filter(p => ['travel', 'move_to', 'interact', 'buy_consumable', 'buy_essence', 'start_hunt'].includes(p.caseName))
    .map(p => p.caseName);
  log(`   sequência   : ${sequencia.join(' → ') || '(vazia)'}`);

  const voltou = s.scene.kind === 'SCENE_KIND_HUNT';
  log(voltou ? '\n   OK: a conta está na caçada.' : '\n   ATENÇÃO: a conta NÃO está em caçada.');

  client.disconnect();
  setTimeout(() => process.exit(voltou ? 0 : 1), 300);
};

// Dá tempo ao ciclo inteiro, mas não espera por nada: encerra quando acaba.
const limite = setTimeout(fim, 60000);
const relogio = setInterval(() => {
  if (!feito) return;
  // Um instante após o evento, para o `finally` do ciclo ter encerrado.
  clearInterval(relogio);
  clearTimeout(limite);
  setTimeout(fim, 1500);
}, 200);
