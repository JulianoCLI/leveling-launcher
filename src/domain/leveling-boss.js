/**
 * @file leveling-boss.js
 * Regras do auto-boss diário. Decide, não envia.
 *
 * Mesma separação de `leveling-expedition.js` e `leveling-refill.js`: aqui mora
 * a parte que precisa de teste — "quais bosses esta conta ainda pode fazer
 * hoje, e em que ordem?", "o dia virou?" — e nada de socket, de relógio global
 * ou de estado mutável.
 *
 * O pedido que este módulo atende, em uma frase: **fazer todos os bosses
 * diários disponíveis em cada conta, uma vez por dia, e dizer quais deram certo
 * e quais não**.
 *
 * As decisões, e por que são estas:
 *
 *   - **quais**: todos os que o servidor marca como não feitos hoje
 *     (`done_today: false`) e cujo nível mínimo a conta alcança. Tentar um boss
 *     acima do nível só gasta a tentativa do dia e enche o relatório de falhas.
 *   - **ordem**: do **mais fraco para o mais forte** (`boss_level` crescente).
 *     Cada boss tem limite de tempo, e um boss duro pode consumir o minuto
 *     inteiro antes de falhar. Garantir os fáceis primeiro é o que faz a conta
 *     terminar o dia com o máximo de bosses concluídos.
 *   - **falha não repete**: derrota ou estouro de tempo gastam a tentativa, e o
 *     servidor passa a responder `done_today`. Insistir geraria recusa certa —
 *     a falha vira linha no relatório, não nova tentativa.
 *   - **volta para a caçada**: ao terminar o boss o servidor devolve a conta à
 *     cidade. O bilhete de caçada é guardado antes da primeira entrada e
 *     reposto no fim, uma vez só, depois do último boss.
 *
 * O dia é o do **servidor**, não o do PC. `DailyBossState.reset_at_ms` é a
 * fronteira: enquanto ele não muda, a rodada do dia já foi feita. O relógio
 * local às 00:01 é só o empurrão para reler o estado — quem decide é o campo.
 */

'use strict';

/** Intervalo entre releituras do estado, em milissegundos. */
const MIN_INTERVAL_MS = 60000;
const MAX_INTERVAL_MS = 3600000;
/**
 * Dez minutos. O estado só muda uma vez por dia, então este intervalo não
 * decide "quando fazer" — decide em quanto tempo o launcher percebe um reset
 * que o relógio local perdeu (PC suspenso na virada, conta que logou depois).
 */
const DEFAULT_INTERVAL_MS = 600000;

/** Recuo depois de uma recusa do servidor, para não repetir a mesma negativa. */
const BACKOFF_MS = 900000;

/**
 * Teto de espera pelo resultado de um boss, em milissegundos.
 *
 * `DailyBossEntry.time_limit_secs` é o limite da luta, mas o resultado chega
 * depois dele — a conta ainda sai da cena. A folga é somada ao limite que o
 * próprio servidor informou; este é o chão para a entrada que vier sem limite.
 */
const RESULT_TIMEOUT_MS = 180000;
const RESULT_GRACE_MS = 30000;

/** Minuto do dia em que o relógio local manda reler o estado. */
const LOCAL_RESET_HOUR = 0;
const LOCAL_RESET_MINUTE = 1;

const int = (value, fallback = 0) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const str = v => (typeof v === 'string' ? v.trim() : '');

/**
 * Configuração vazia: **desligada**.
 *
 * O boss diário é uma tentativa por dia e não volta: uma conta que entra sem
 * equipamento perde a chance do dia. Ligar isso sozinho decidiria pelo usuário
 * algo que ele não pode desfazer até o reset seguinte.
 */
function defaultConfig() {
  return { enabled: false, intervalMs: DEFAULT_INTERVAL_MS, disabled: [] };
}

/**
 * Normaliza o que vem do disco ou da tela.
 *
 * As contas são listadas pelo que está **desligado**, não pelo que está ligado,
 * pela mesma razão da expedição: uma aba nova traz contas novas, e uma lista de
 * permissões as deixaria de fora em silêncio.
 */
function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const lista = Array.isArray(source.disabled) ? source.disabled : [];
  const disabled = [...new Set(lista.map(i => int(i, -1)).filter(i => i >= 0))]
    .sort((a, b) => a - b);
  return {
    enabled: !!source.enabled,
    intervalMs: Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS,
      int(source.intervalMs, DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS)),
    disabled
  };
}

/** Vale ligar o laço? */
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
 * Recorta o `DailyBossState` do servidor no que as regras usam.
 *
 * Os nomes viram camelCase porque o resto do launcher fala assim, e os números
 * passam por `int`: proto3 omite o campo zero, então metade deles chega ausente
 * numa conta que nunca fez boss.
 */
function readState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};

  const bosses = (Array.isArray(s.bosses) ? s.bosses : []).map(b => ({
    id: str(b && b.id),
    rank: int(b && b.rank),
    minLevel: int(b && b.min_level),
    bossId: str(b && b.boss_id),
    bossLevel: int(b && b.boss_level),
    timeLimitSecs: int(b && b.time_limit_secs),
    doneToday: !!(b && b.done_today),
    myBestMs: int(b && b.my_best_ms),
    sceneId: str(b && b.scene_id)
  })).filter(b => b.id);

  return {
    /**
     * Marca de "já recortado". Mesma razão do painel de expedição: `plan` e
     * `summarize` aceitam o estado cru ou o lido, e distinguir pelas chaves não
     * funciona — `bosses` existe nos dois com formatos diferentes.
     */
    read: true,
    bosses,
    resetAtMs: int(s.reset_at_ms),
    /** Boss em andamento agora, se o servidor informar; vazio no normal. */
    active: str(s.active)
  };
}

/**
 * A conta alcança este boss?
 *
 * `minLevel` zero significa sem exigência — não significa nível 0. Entradas
 * sem exigência passam sempre.
 */
function eligible(boss, level) {
  if (!boss || boss.doneToday) return false;
  if (!boss.minLevel) return true;
  return int(level) >= boss.minLevel;
}

/**
 * Quanto esperar pelo resultado deste boss.
 *
 * O limite vem do servidor, somado a uma folga para a saída da cena. Sem limite
 * informado vale o teto fixo — esperar para sempre prenderia o laço do dia.
 */
function resultTimeoutMs(boss) {
  const limite = boss && int(boss.timeLimitSecs);
  if (!limite) return RESULT_TIMEOUT_MS;
  return limite * 1000 + RESULT_GRACE_MS;
}

/**
 * O que fazer com o estado desta conta, agora.
 *
 * Função pura: recebe o estado lido, a configuração e o nível da conta, devolve
 * a fila de bosses a tentar. Quem executa é o serviço.
 *
 * @param {object} input
 * @param {object} input.state Estado cru do servidor ou já lido.
 * @param {object} [input.config] Configuração; `enabled` desligado devolve nada.
 * @param {number} [input.index] Índice da conta, para a lista de exceções.
 * @param {number} [input.level] Nível do personagem, para o corte por exigência.
 * @returns {{targets:Array, skipped:Array, done:Array, resetAtMs:number, state:object}}
 */
function plan({ state, config, index = 0, level = 0 } = {}) {
  const cfg = normalizeConfig(config);
  const s = state && state.read ? state : readState(state);

  const out = {
    targets: [], skipped: [], done: [], resetAtMs: s.resetAtMs, state: s
  };

  if (!cfg.enabled) {
    out.skipped.push({ reason: 'boss.off' });
    return out;
  }
  if (cfg.disabled.includes(int(index, -1))) {
    out.skipped.push({ reason: 'boss.accountOff' });
    return out;
  }
  if (!s.bosses.length) {
    out.skipped.push({ reason: 'boss.noneListed' });
    return out;
  }

  for (const boss of s.bosses) {
    if (boss.doneToday) {
      out.done.push({ id: boss.id, bossId: boss.bossId, myBestMs: boss.myBestMs });
      continue;
    }
    if (!eligible(boss, level)) {
      out.skipped.push({
        reason: 'boss.level', id: boss.id, bossId: boss.bossId,
        minLevel: boss.minLevel, level: int(level)
      });
      continue;
    }
    out.targets.push({
      id: boss.id,
      bossId: boss.bossId,
      bossLevel: boss.bossLevel,
      minLevel: boss.minLevel,
      rank: boss.rank,
      timeLimitSecs: boss.timeLimitSecs,
      timeoutMs: resultTimeoutMs(boss)
    });
  }

  // Do mais fraco para o mais forte. Empate pelo id, para a ordem ser a mesma
  // em duas leituras seguidas: fila que muda sozinha faria o relatório parecer
  // aleatório.
  out.targets.sort((a, b) =>
    a.bossLevel - b.bossLevel
    || a.minLevel - b.minLevel
    || a.rank - b.rank
    || a.id.localeCompare(b.id));

  return out;
}

/**
 * A próxima virada do dia pelo relógio local, em milissegundos absolutos.
 *
 * Existe como rede de segurança, não como fonte de verdade: quem diz que o dia
 * virou é `reset_at_ms` do servidor. Este horário só manda **reler** o estado,
 * porque o servidor não avisa o reset por push — sem isso uma conta logada a
 * noite toda só perceberia a virada no tique seguinte do intervalo.
 */
function nextLocalResetMs(nowMs = Date.now()) {
  const agora = new Date(Number(nowMs) || Date.now());
  const alvo = new Date(agora);
  alvo.setHours(LOCAL_RESET_HOUR, LOCAL_RESET_MINUTE, 0, 0);
  if (alvo.getTime() <= agora.getTime()) alvo.setDate(alvo.getDate() + 1);
  return alvo.getTime();
}

/**
 * A rodada do dia ainda está por fazer?
 *
 * Compara o `reset_at_ms` do estado recém-lido com o da última rodada
 * concluída. Enquanto forem iguais, o dia é o mesmo e não há nada a fazer.
 *
 * Estado sem `reset_at_ms` cai no lado seguro — "ainda por fazer" —, porque a
 * decisão final é dos próprios bosses: se todos vierem `done_today`, a fila sai
 * vazia e nada é enviado.
 */
function isNewDay(resetAtMs, lastRunResetAtMs) {
  const atual = int(resetAtMs);
  if (!atual) return true;
  return atual !== int(lastRunResetAtMs);
}

/**
 * Resumo de uma conta para a janela: quantos bosses existem, quantos já foram,
 * quantos faltam e quando o dia vira.
 */
function summarize(state, options = {}) {
  const s = state && state.read ? state : readState(state);
  const level = int(options.level);

  const feitos = s.bosses.filter(b => b.doneToday);
  const elegiveis = s.bosses.filter(b => eligible(b, level));
  const travados = s.bosses.filter(b => !b.doneToday && !eligible(b, level));

  return {
    total: s.bosses.length,
    done: feitos.length,
    pending: elegiveis.length,
    blocked: travados.length,
    resetAtMs: s.resetAtMs,
    active: s.active,
    /** Linha por boss, para a tela dizer qual é qual sem outra leitura. */
    bosses: s.bosses.map(b => ({
      id: b.id,
      bossId: b.bossId,
      bossLevel: b.bossLevel,
      minLevel: b.minLevel,
      doneToday: b.doneToday,
      myBestMs: b.myBestMs,
      eligible: eligible(b, level)
    }))
  };
}

module.exports = {
  defaultConfig,
  normalizeConfig,
  isConfigured,
  accountEnabled,
  readState,
  plan,
  summarize,
  eligible,
  resultTimeoutMs,
  nextLocalResetMs,
  isNewDay,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  BACKOFF_MS,
  RESULT_TIMEOUT_MS,
  RESULT_GRACE_MS
};
