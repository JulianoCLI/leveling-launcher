/**
 * @file leveling-expedition.js
 * Regras da auto-expedição. Decide, não envia.
 *
 * Mesma separação de `leveling-refill.js` e `leveling-sniper.js`: aqui está a
 * parte que precisa de teste ("esta expedição acabou?", "qual sombra mandar, e
 * para onde, e por quanto tempo?") e nada de socket, tempo global ou estado.
 *
 * O pedido que este módulo atende, em uma frase: **manter todas as vagas de
 * expedição da conta sempre ocupadas**, coletando o que terminou e mandando
 * logo em seguida, sem nunca tocar nas sombras do time.
 *
 * As três decisões, e por que são estas:
 *
 *   - **destino**: o de **menor nível** entre os liberados. Expedição não
 *     exige potência para render — o prêmio é por tempo, e o destino baixo é o
 *     que aceita qualquer sombra com chance alta. Mirar alto faria a sombra
 *     fraca falhar e voltar sem nada.
 *   - **sombra**: a **mais forte do armazém**, uma por expedição. O servidor já
 *     devolve os candidatos (`ExpeditionPanel.candidates`), que é a lista do
 *     que *pode* ir; o filtro daqui é o segundo cinto de segurança — sombra em
 *     time, sombra já em expedição e sombra morta ficam de fora mesmo que o
 *     servidor as ofereça.
 *   - **tempo**: o **maior** que a conta alcança. VIP chega a 24 h e tem uma
 *     vaga a mais; sem VIP o teto é 12 h. Os números não são escritos aqui:
 *     saem de `durations` / `vip_durations` do painel, que é o que o servidor
 *     aceita de verdade. As constantes abaixo são só o chão para quando o
 *     painel vem sem a lista.
 */

'use strict';

/** Intervalo entre leituras do painel, em milissegundos. */
const MIN_INTERVAL_MS = 15000;
const MAX_INTERVAL_MS = 600000;
/**
 * Um minuto. Expedição mais curta dura horas, então o que este intervalo
 * decide não é "quando mandar" — é quanto tempo uma vaga fica vazia depois de
 * a expedição terminar. Um minuto de vaga vazia em 12 horas é ruído.
 */
const DEFAULT_INTERVAL_MS = 60000;

/**
 * Chão de capacidade e de duração, para o caso de o painel chegar sem as
 * listas. Medidos no jogo: sem VIP são 4 vagas e 12 h; com VIP, 5 e 24 h.
 */
const FALLBACK_SLOTS = 4;
const FALLBACK_VIP_SLOTS = 5;
const FALLBACK_MINUTES = 720;
const FALLBACK_VIP_MINUTES = 1440;

const int = (value, fallback = 0) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const num = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const str = v => (typeof v === 'string' ? v.trim() : '');

/**
 * Configuração vazia: **desligada**.
 *
 * Expedição não gasta moeda, mas ocupa as sombras do armazém por até 24 h — e
 * sombra em expedição não pode ser fundida, equipada nem vendida. Ligar isso
 * sozinho atrapalharia quem está mexendo no exército.
 */
function defaultConfig() {
  return { enabled: false, intervalMs: DEFAULT_INTERVAL_MS, disabled: [] };
}

/**
 * Normaliza o que vem do disco ou da tela.
 *
 * As contas são listadas pelo que está **desligado**, não pelo que está
 * ligado: uma aba nova traz contas novas, e uma lista de permissões as
 * deixaria de fora em silêncio. Assim o padrão de qualquer conta é participar,
 * e a exceção é o que o usuário marcou.
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
 * Recorta o `ExpeditionPanel` do servidor no que as regras usam.
 *
 * Os nomes são convertidos para camelCase porque o resto do launcher fala
 * assim, e os números passam por `int`: proto3 omite o campo zero, então
 * metade deles chega ausente numa conta recém-criada.
 */
function readPanel(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const vip = !!p.vip;

  const durations = (Array.isArray(p.durations) ? p.durations : []).map(int).filter(m => m > 0);
  const vipDurations = (Array.isArray(p.vip_durations) ? p.vip_durations : []).map(int).filter(m => m > 0);
  // VIP soma as duas listas: medido, `durations` traz as comuns e
  // `vip_durations` só o que o VIP acrescenta — não a lista inteira.
  const permitidas = vip ? durations.concat(vipDurations) : durations;
  const maxMinutes = permitidas.length
    ? Math.max(...permitidas)
    : (vip ? FALLBACK_VIP_MINUTES : FALLBACK_MINUTES);

  const slots = int(p.slots);
  const vipSlots = int(p.vip_slots);
  // A vaga extra por nível vem separada do total, então somar é obrigatório —
  // senão a conta de nível alto ficaria com uma vaga sempre vazia.
  const base = vip ? Math.max(vipSlots, slots) : slots;
  const capacity = (base || (vip ? FALLBACK_VIP_SLOTS : FALLBACK_SLOTS)) + int(p.level_extra_slot);

  const destinations = (Array.isArray(p.destinations) ? p.destinations : []).map(d => ({
    gate: str(d && d.gate),
    difficulty: str(d && d.difficulty),
    level: int(d && d.level),
    unlockLevel: int(d && d.unlock_level),
    unlocked: !!(d && d.unlocked)
  })).filter(d => d.gate);

  const active = (Array.isArray(p.active) ? p.active : []).map(a => ({
    id: int(a && a.id),
    gate: str(a && a.gate),
    difficulty: str(a && a.difficulty),
    minutes: int(a && a.minutes),
    startedAtMs: int(a && a.started_at_ms),
    endsAtMs: int(a && a.ends_at_ms),
    chance: num(a && a.chance),
    ready: !!(a && a.ready),
    shadows: (Array.isArray(a && a.shadows) ? a.shadows : []).map(s => ({
      uid: String((s && s.uid) || ''),
      name: str(s && s.name),
      rank: str(s && s.rank),
      power: num(s && s.stats && s.stats.power)
    }))
  })).filter(a => a.id);

  const candidates = (Array.isArray(p.candidates) ? p.candidates : []).map(c => {
    const s = (c && c.shadow) || {};
    return {
      uid: String(s.uid || ''),
      name: str(s.name),
      rank: str(s.rank),
      level: int(s.level),
      // A potência de `ExpeditionCandidate` é a que o servidor usa para medir
      // a chance; `shadow.stats.power` é o segundo melhor, para o caso de o
      // campo de fora vir vazio.
      power: num(c && c.power) || num(s.stats && s.stats.power),
      teamSlot: int(s.team_slot),
      expedition: int(s.expedition),
      dead: !!s.dead
    };
  }).filter(c => c.uid);

  return {
    /**
     * Marca de "já recortado".
     *
     * `plan` e `summarize` aceitam o painel cru ou o lido, e distinguir pelas
     * chaves não funciona: `active`, `destinations` e `candidates` existem nos
     * dois, com formatos diferentes — ler um painel já lido zerava os números,
     * porque `snake_case` não casa com nada. Uma marca explícita resolve sem
     * ambiguidade.
     */
    read: true,
    enabled: !!p.enabled,
    vip,
    slots,
    capacity,
    maxMinutes,
    durations: permitidas,
    squadMax: int(p.squad_max_vip) && vip ? int(p.squad_max_vip) : int(p.squad_max),
    minLevel: int(p.min_level),
    nowMs: int(p.now_ms),
    destinations,
    active,
    candidates,
    collected: int(p.collected),
    succeeded: int(p.succeeded)
  };
}

/**
 * A expedição terminou?
 *
 * `ready` é a palavra do servidor e vale mais que qualquer conta de tempo. O
 * prazo é a reserva: medido, `ready` só vira verdadeiro quando o painel é
 * relido depois do fim, e uma leitura que pega o instante exato da virada
 * traria `ready: false` com o prazo já vencido.
 *
 * `nowMs` vem do painel de propósito. O relógio do PC do usuário pode estar
 * minutos adiantado, e nesse caso usar `Date.now()` mandaria coletar uma
 * expedição que ainda está correndo — o servidor recusaria, e o log acusaria
 * uma falha que não existe.
 */
function isDone(active, nowMs) {
  if (!active) return false;
  if (active.ready) return true;
  const fim = int(active.endsAtMs);
  const agora = int(nowMs);
  return !!fim && !!agora && fim <= agora;
}

/**
 * O destino de menor nível entre os liberados.
 *
 * Empate pelo nível de liberação e depois pelo nome do portal, para a escolha
 * ser a mesma em duas leituras seguidas: destino que muda sozinho entre
 * tiques faria o log parecer aleatório.
 */
function pickDestination(destinations) {
  const livres = (destinations || []).filter(d => d && d.unlocked && d.gate);
  if (!livres.length) return null;
  return livres.slice().sort((a, b) =>
    a.level - b.level
    || a.unlockLevel - b.unlockLevel
    || a.gate.localeCompare(b.gate)
  )[0];
}

/**
 * As sombras que podem sair, da mais forte para a mais fraca.
 *
 * Três exclusões, e nenhuma delas é redundante mesmo que o servidor já filtre:
 * `teamSlot` protege o time de caçada, que é a regra explícita do usuário;
 * `expedition` evita mandar duas vezes a mesma sombra quando um painel velho
 * ainda não refletiu o envio anterior; e sombra morta não cumpre expedição.
 */
function availableShadows(candidates) {
  return (candidates || [])
    .filter(c => c && c.uid && !c.teamSlot && !c.expedition && !c.dead)
    .slice()
    .sort((a, b) => b.power - a.power || a.uid.localeCompare(b.uid));
}

/**
 * O que fazer com o painel desta conta, agora.
 *
 * Função pura: recebe o painel lido e a configuração, devolve a lista de
 * coletas e a lista de envios. Quem executa é o serviço.
 *
 * As coletas vêm antes dos envios no resultado e precisam ser executadas nessa
 * ordem: a vaga só abre depois de a expedição terminada ser recolhida, então
 * contar a vaga liberada antes de coletar faria o servidor recusar o envio.
 *
 * @param {object} input
 * @param {object} input.panel Painel cru do servidor ou já lido.
 * @param {object} [input.config] Configuração; `enabled` desligado devolve nada.
 * @param {number} [input.index] Índice da conta, para a lista de exceções.
 * @returns {{collect:number[], sends:Array, capacity:number, free:number, skipped:Array}}
 */
function plan({ panel, config, index = 0 } = {}) {
  const cfg = normalizeConfig(config);
  const p = panel && panel.read ? panel : readPanel(panel);

  const out = {
    collect: [], sends: [], capacity: p.capacity, free: 0, skipped: [], panel: p
  };

  if (!cfg.enabled) {
    out.skipped.push({ reason: 'exp.off' });
    return out;
  }
  if (cfg.disabled.includes(int(index, -1))) {
    out.skipped.push({ reason: 'exp.accountOff' });
    return out;
  }
  if (!p.enabled) {
    // O servidor diz que a conta ainda não tem expedição liberada.
    out.skipped.push({ reason: 'exp.locked' });
    return out;
  }

  // Coletar primeiro, sempre: é de graça, abre vaga e é metade do pedido.
  for (const active of p.active) {
    if (isDone(active, p.nowMs)) out.collect.push(active.id);
  }

  const ocupadas = p.active.length - out.collect.length;
  const free = Math.max(0, p.capacity - ocupadas);
  out.free = free;
  if (!free) {
    out.skipped.push({ reason: 'exp.full' });
    return out;
  }

  const destino = pickDestination(p.destinations);
  if (!destino) {
    out.skipped.push({ reason: 'exp.noDestination' });
    return out;
  }

  const sombras = availableShadows(p.candidates);
  if (!sombras.length) {
    out.skipped.push({ reason: 'exp.noShadows' });
    return out;
  }

  // Uma sombra por expedição: é assim que o jogo rende mais vagas ocupadas com
  // o mesmo exército, e é o que o usuário pediu.
  for (let i = 0; i < free && i < sombras.length; i++) {
    const sombra = sombras[i];
    out.sends.push({
      gate: destino.gate,
      difficulty: destino.difficulty,
      minutes: p.maxMinutes,
      uids: [sombra.uid],
      shadow: { uid: sombra.uid, name: sombra.name, rank: sombra.rank, power: sombra.power },
      destination: { gate: destino.gate, difficulty: destino.difficulty, level: destino.level }
    });
  }

  if (sombras.length < free) {
    out.skipped.push({ reason: 'exp.fewShadows', missing: free - sombras.length });
  }

  return out;
}

/**
 * Resumo de uma conta para a janela: quantas sombras estão fora e quando a
 * primeira volta.
 *
 * `nextEndsAtMs` é o menor prazo, não o maior: a pergunta da tela é "quando
 * tem novidade", e a novidade é a primeira que chega.
 */
function summarize(panel) {
  const p = panel && panel.read ? panel : readPanel(panel);
  const prazos = p.active.map(a => a.endsAtMs).filter(Boolean);
  const prontas = p.active.filter(a => isDone(a, p.nowMs)).length;
  return {
    enabled: p.enabled,
    vip: p.vip,
    capacity: p.capacity,
    maxMinutes: p.maxMinutes,
    active: p.active.length,
    // Com uma sombra por expedição os dois números coincidem hoje; contar as
    // sombras de verdade mantém a tela certa se isso mudar.
    shadows: p.active.reduce((total, a) => total + (a.shadows.length || 1), 0),
    ready: prontas,
    free: Math.max(0, p.capacity - p.active.length),
    nextEndsAtMs: prazos.length ? Math.min(...prazos) : 0,
    lastEndsAtMs: prazos.length ? Math.max(...prazos) : 0,
    available: availableShadows(p.candidates).length,
    nowMs: p.nowMs
  };
}

module.exports = {
  defaultConfig,
  normalizeConfig,
  isConfigured,
  accountEnabled,
  readPanel,
  summarize,
  plan,
  isDone,
  pickDestination,
  availableShadows,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  FALLBACK_SLOTS,
  FALLBACK_VIP_SLOTS,
  FALLBACK_MINUTES,
  FALLBACK_VIP_MINUTES
};
