/**
 * @file leveling-cambio.js
 * Regras do câmbio: concentrar o ouro de várias contas numa só. Decide, não envia.
 *
 * Mesma separação de `leveling-refill.js` e `leveling-autosell.js`: aqui está a
 * parte que precisa de teste ("de qual conta para qual?", "quanto pode sair sem
 * quebrar a conta?", "já passou tempo bastante?") e nada de socket, tempo
 * global ou estado.
 *
 * O pedido que este módulo atende, em uma frase: **descer o ouro pela cadeia,
 * da última conta até a primeira, uma troca por vez**.
 *
 *   conta 9 → conta 8 → conta 7 → ... → conta 2 → conta 1
 *
 * ## Por que cadeia, e não todas direto na conta 1
 *
 * Medido contra o servidor (`tools/trade-probe.js`, trades 17835 e 17837): a
 * troca **não cobra taxa** — `given_gold` e `received_gold` são iguais, e o
 * saldo das duas contas fecha exatamente. Então descer hop a hop custa o mesmo
 * que mandar direto, e a cadeia tem duas vantagens: cada conta só precisa ser
 * amiga da **vizinha** (a amizade é exigida, `trade.friends_only`), e o ouro de
 * uma conta sempre viaja com o que ela já recebeu da anterior, o que faz menos
 * trocas do que cada conta mandando a sua parte separada.
 *
 * ## A reserva
 *
 * Cada conta de origem fica com um piso intocado. Não é preciosismo: a conta
 * paga o próprio auto-refill com ouro próprio, e uma conta zerada para de
 * repor poção e revive, para de caçar e deixa de render — o ouro concentrado
 * sairia caro. A reserva padrão é 100.000, e `MIN_RESERVE` impede que a tela ou
 * um `prefs.json` editado à mão a derrubem abaixo disso.
 *
 * A conta de destino **não** tem reserva: ela é o fim da linha, só recebe.
 *
 * ## O ritmo
 *
 * Uma troca por vez no launcher inteiro, e a seguinte só depois de a anterior
 * ter fechado **e** o saldo ter sido conferido nos dois lados. Entre dois hops
 * entra o intervalo, com jitter: o hop em si leva ~3 s (medido), então o
 * intervalo é a única coisa que separa a operação de um padrão óbvio de
 * transferências em sequência.
 */

'use strict';

/** Intervalo entre hops. Mínimo de um minuto: o hop leva ~3 s, o resto é pausa. */
const MIN_INTERVAL_MS = 60000;
const MAX_INTERVAL_MS = 6 * 3600000;
/** Dez minutos, o ritmo que o pedido descreve. */
const DEFAULT_INTERVAL_MS = 600000;

/**
 * Piso de ouro que fica na conta de origem. O valor não é ajustável para baixo:
 * abaixo disto a conta não sustenta o próprio refill, e o ganho de raspar os
 * últimos milhares não paga uma conta parada.
 */
const MIN_RESERVE = 100000;
const DEFAULT_RESERVE = 100000;

/**
 * Chão do que vale uma troca. Transferir mil de ouro gasta um hop inteiro e o
 * intervalo que vem depois dele, para mover ruído.
 */
const MIN_AMOUNT = 1000;

/**
 * Variação aleatória aplicada ao intervalo, em fração. Trocas espaçadas por
 * exatamente dez minutos, hop após hop, são um padrão que se lê num gráfico.
 */
const JITTER = 0.2;

const int = (value, fallback = 0) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Configuração vazia: **desligada**.
 *
 * Câmbio move ouro de verdade e não tem desfazer. Nunca liga sozinho.
 */
function defaultConfig() {
  return {
    enabled: false,
    /** Conta que concentra tudo, 1-based como o painel mostra. */
    destino: 1,
    /** Última conta da cadeia, 1-based. Zero significa "a maior conta ativa". */
    origem: 0,
    reserva: DEFAULT_RESERVE,
    minimo: MIN_AMOUNT,
    intervaloMs: DEFAULT_INTERVAL_MS,
    /** Contas que não participam, 0-based como o resto do launcher. */
    disabled: []
  };
}

/**
 * Normaliza o que vem do disco ou da tela.
 *
 * Os tetos aqui são a última barreira antes de a decisão virar uma troca
 * irreversível: um `prefs.json` com `reserva: 0` levaria a cadeia a zerar cada
 * conta no caminho, e `intervaloMs: 1` faria oito trocas num segundo. Por isso
 * a reserva sobe para `MIN_RESERVE` em vez de ser aceita como está.
 */
function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const lista = Array.isArray(source.disabled) ? source.disabled : [];
  const disabled = [...new Set(lista.map(i => int(i, -1)).filter(i => i >= 0))]
    .sort((a, b) => a - b);

  return {
    enabled: !!source.enabled,
    destino: Math.max(1, int(source.destino, 1) || 1),
    origem: int(source.origem, 0),
    reserva: Math.max(MIN_RESERVE, int(source.reserva, DEFAULT_RESERVE)),
    minimo: Math.max(MIN_AMOUNT, int(source.minimo, MIN_AMOUNT)),
    intervaloMs: Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS,
      int(source.intervaloMs, DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS)),
    disabled
  };
}

/** Vale ligar o laço? */
function isConfigured(config) {
  return normalizeConfig(config).enabled;
}

/** Esta conta participa? `index` é 0-based. */
function includesAccount(config, index) {
  const cfg = normalizeConfig(config);
  if (!cfg.enabled) return false;
  return !cfg.disabled.includes(int(index, -1));
}

/**
 * A cadeia de hops, da conta mais alta até o destino.
 *
 * `ativos` são os índices 0-based das contas em modo monitor e conectadas. A
 * cadeia só liga contas **vizinhas na lista de ativas**, não vizinhas em
 * número: se a conta 7 está offline, o hop vai de 8 direto para 6, porque o
 * caminho tem de existir de fato. Uma conta excluída pelo usuário é tratada
 * como inexistente pelo mesmo motivo.
 *
 * O destino nunca aparece como origem de hop nenhum: ele é o fim da linha.
 */
function planCadeia(config, ativos) {
  const cfg = normalizeConfig(config);
  const destinoIdx = cfg.destino - 1;

  const lista = [...new Set((Array.isArray(ativos) ? ativos : []).map(i => int(i, -1)))]
    .filter(i => i >= 0)
    // O destino entra sempre, mesmo se o usuário o marcou como excluído: sem
    // ele não existe cadeia, e "excluído" quer dizer "não doa", não "não recebe".
    .filter(i => i === destinoIdx || includesAccount(cfg, i))
    .sort((a, b) => a - b);

  if (!lista.includes(destinoIdx)) return [];
  // Só o que está **acima** do destino desce até ele. Conta abaixo do destino
  // não tem para onde ir nesta cadeia.
  const acima = lista.filter(i => i > destinoIdx);
  if (!acima.length) return [];

  // Da conta mais alta para baixo: o ouro desce acumulando.
  const ordenado = [destinoIdx, ...acima];
  const hops = [];
  for (let i = ordenado.length - 1; i > 0; i--) {
    const limite = cfg.origem > 0 ? cfg.origem - 1 : Infinity;
    if (ordenado[i] > limite) continue;
    hops.push({ de: ordenado[i], para: ordenado[i - 1] });
  }
  return hops;
}

/**
 * Quanto sai de uma conta neste hop.
 *
 * Devolve `{ gold }` ou `{ skip, reason }`. O `skip` não é erro: a maior parte
 * das rodadas vai cair nele, porque a conta rende devagar e a reserva é alta.
 *
 * O valor é o saldo **menos a reserva**, inteiro. Não há teto por troca: medido,
 * o servidor aceitou 50.000 sem reclamar e nada no protocolo indica limite, e
 * fatiar só multiplicaria o número de trocas — que é justamente o que chama
 * atenção.
 */
function planHop(config, saldo) {
  const cfg = normalizeConfig(config);
  const ouro = int(saldo, 0);

  if (ouro <= cfg.reserva) {
    return { skip: true, reason: 'cambio.abaixoDaReserva', gold: 0, saldo: ouro };
  }
  const disponivel = ouro - cfg.reserva;
  if (disponivel < cfg.minimo) {
    return { skip: true, reason: 'cambio.poucoParaValer', gold: 0, saldo: ouro };
  }
  return { skip: false, gold: disponivel, saldo: ouro, reserva: cfg.reserva };
}

/**
 * Já pode mandar o próximo hop?
 *
 * `ultimoAtMs` é quando o hop anterior **fechou**, não quando começou: o pedido
 * é que o intervalo separe trocas confirmadas, e contar do início faria o
 * intervalo encurtar pelo tempo da própria troca.
 */
function hopLiberado(config, ultimoAtMs, agora = Date.now()) {
  const cfg = normalizeConfig(config);
  const ultimo = int(ultimoAtMs, 0);
  if (!ultimo) return true;
  return agora - ultimo >= cfg.intervaloMs;
}

/**
 * O intervalo desta vez, com jitter. Determinístico se `rand` for injetado,
 * que é o que deixa isso testável.
 */
function proximoIntervalo(config, rand = Math.random) {
  const cfg = normalizeConfig(config);
  const fator = 1 + (rand() * 2 - 1) * JITTER;
  return Math.max(MIN_INTERVAL_MS, Math.round(cfg.intervaloMs * fator));
}

/**
 * Confere o `TradeState` antes de travar a oferta.
 *
 * Esta é a última checagem antes do ponto sem volta. Medido: depois do
 * `lock` o servidor recusa mudar a oferta (`trade.locked`) e a trava não cai,
 * então o que for conferido aqui vale até o fim da troca.
 *
 * O que torna um estado inaceitável:
 *   - ouro ofertado diferente do planejado, para qualquer lado
 *   - **qualquer** item ou sombra na oferta, de qualquer lado — a automação só
 *     troca ouro, e ofertar uma peça por engano não tem desfazer
 *   - o parceiro ofertando algo: a troca é de mão única, quem recebe não dá nada
 *   - as contas não serem as esperadas
 */
function conferirOferta(state, esperado) {
  const s = state && typeof state === 'object' ? state : {};
  const me = s.me && typeof s.me === 'object' ? s.me : {};
  const partner = s.partner && typeof s.partner === 'object' ? s.partner : {};
  const plano = esperado && typeof esperado === 'object' ? esperado : {};

  const meuOuro = int(me.gold, 0);
  const ouroDele = int(partner.gold, 0);
  const alvo = int(plano.gold, 0);

  if (!s.id) return { ok: false, reason: 'cambio.semTrocaAberta' };
  if (meuOuro !== alvo) return { ok: false, reason: 'cambio.ouroDivergente', meuOuro, alvo };
  if (ouroDele !== 0) return { ok: false, reason: 'cambio.parceiroOfertou', ouroDele };

  const itens = (me.items || []).length + (partner.items || []).length;
  const sombras = (me.shadows || []).length + (partner.shadows || []).length;
  if (itens) return { ok: false, reason: 'cambio.itemNaOferta', itens };
  if (sombras) return { ok: false, reason: 'cambio.sombraNaOferta', sombras };

  if (plano.meAccount && String(me.account || '') !== String(plano.meAccount)) {
    return { ok: false, reason: 'cambio.contaErrada' };
  }
  if (plano.partnerAccount && String(partner.account || '') !== String(plano.partnerAccount)) {
    return { ok: false, reason: 'cambio.parceiroErrado' };
  }

  return { ok: true };
}

/**
 * Confere o fecho da troca contra o plano.
 *
 * Os dois lados recebem um `TradeCompleted` diferente: quem deu vê
 * `given_gold`, quem recebeu vê `received_gold`. Medido, os dois são iguais ao
 * planejado e não há taxa — então divergência aqui significa que algo saiu do
 * esperado, e a cadeia deve parar em vez de seguir para o hop seguinte.
 *
 * `mailed` vem falso nas trocas de ouro medidas: o valor cai direto no saldo.
 * Se um dia vier verdadeiro, o ouro está no correio e **não** foi conferido no
 * saldo — então isso é reportado para quem chamou decidir, não ignorado.
 */
function conferirFecho(completedDe, completedPara, esperado) {
  const a = completedDe && typeof completedDe === 'object' ? completedDe : {};
  const b = completedPara && typeof completedPara === 'object' ? completedPara : {};
  const alvo = int((esperado || {}).gold, 0);

  const deu = int(a.given_gold, 0);
  const recebeu = int(b.received_gold, 0);

  if (!deu && !recebeu) return { ok: false, reason: 'cambio.semFecho' };
  if (deu !== alvo) return { ok: false, reason: 'cambio.deuDiferente', deu, alvo };
  if (recebeu !== alvo) return { ok: false, reason: 'cambio.recebeuDiferente', recebeu, alvo };

  return {
    ok: true,
    gold: alvo,
    /** Correio: não foi para o saldo, então a conferência de saldo não vale. */
    mailed: !!b.mailed,
    heldUntil: int(b.held_until_ms, 0)
  };
}

/**
 * Confere o saldo depois da troca.
 *
 * O `completed` é o que o servidor diz; isto é o que o saldo mostra. As duas
 * coisas têm de bater, senão a cadeia seguiria empilhando trocas sobre uma
 * premissa errada. Tolerância existe porque a conta pode estar caçando e
 * ganhando ouro no meio da troca — o saldo de quem recebe pode subir **mais**
 * que o transferido, nunca menos.
 */
function conferirSaldo(antesDe, depoisDe, antesPara, depoisPara, gold) {
  const esperadoSaida = int(antesDe, 0) - int(gold, 0);
  const saida = int(depoisDe, 0);
  const entrada = int(depoisPara, 0) - int(antesPara, 0);

  // Quem deu pode ter ganho ouro caçando, então o saldo pode estar acima do
  // esperado; abaixo é que seria inexplicável.
  if (saida < esperadoSaida) {
    return { ok: false, reason: 'cambio.saldoOrigemBaixo', saida, esperadoSaida };
  }
  if (entrada < int(gold, 0)) {
    return { ok: false, reason: 'cambio.saldoDestinoBaixo', entrada, gold: int(gold, 0) };
  }
  return { ok: true, entrada, saida };
}

/**
 * Precisa pedir amizade antes de trocar?
 *
 * Medido: `trade_request{invite}` entre contas que não são amigas responde
 * `error{code:"trade.friends_only"}`. A amizade é persistente, então isto é
 * verdade uma vez por par e nunca mais.
 */
function precisaAmizade(friendList, accountId) {
  const lista = (friendList && Array.isArray(friendList.friends)) ? friendList.friends : [];
  const alvo = String(accountId == null ? '' : accountId);
  if (!alvo) return false;
  return !lista.some(f => f && String(f.account || '') === alvo);
}

/**
 * Entradas do correio que o câmbio pode resgatar: as que trazem **só ouro**.
 *
 * O critério é deliberadamente o mais estreito possível, e por três motivos.
 * Item no correio exige espaço na bolsa, e um resgate com a bolsa cheia é
 * **parcial** — o estrago seria invisível. Recompensa de evento e prêmio com
 * prazo podem estar ali de propósito, e esvaziá-los não teria volta. E o
 * câmbio não precisa de nada disso: o que falta ao hop é ouro que já é da
 * conta mas ainda não está no saldo.
 *
 * Diamante também barra a entrada. Uma entrada com ouro **e** diamante é
 * quase sempre recompensa, não venda, e o ouro dela não vale abrir essa porta.
 *
 * As retidas para análise ficam de fora: o servidor recusa o `claim` antes do
 * prazo, e tentar só gastaria um pedido por hop para receber a mesma recusa.
 */
function correioDoCambio(entries, agora = Date.now()) {
  return (Array.isArray(entries) ? entries : [])
    .filter(e => e
      && !e.claimed
      && (Number(e.gold) || 0) > 0
      && !(Number(e.items) || 0)
      && !(Number(e.diamonds) || 0)
      && !((Number(e.heldUntil) || 0) > agora))
    .map(e => String(e.id));
}

module.exports = {
  correioDoCambio,
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
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
  MIN_RESERVE,
  DEFAULT_RESERVE,
  MIN_AMOUNT,
  JITTER
};
