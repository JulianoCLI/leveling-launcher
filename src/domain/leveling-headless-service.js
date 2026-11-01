/**
 * @file leveling-headless-service.js
 * Monitor headless do Leveling Idle 2D (wss://game.levelingidle2d.com.br:8443/ws).
 *
 * LEITURA E REPOSIÇÃO. A caçada e toda a automação ficam do lado do servidor,
 * já configuradas na conta; este cliente observa e, quando o auto-refill está
 * ligado, repõe os consumíveis que essa automação gasta sozinha.
 *
 * Lista fechada de pacotes que podem sair daqui:
 *   `login` / `resume`   autenticar
 *   `ping`               manter o elo vivo
 *   `party_request{get}` leitura inicial do grupo
 *   `party_request{create|invite|answer|leave|disband}`
 *                        montar o grupo das contas da aba, a pedido do usuário
 *   `buy_consumable`     repor poções e revives
 *   `buy_essence`        repor essência
 *   `travel`             ir à cidade onde a loja existe
 *   `move_to`            chegar ao balcão
 *   `interact`           abrir a loja no NPC
 *   `start_hunt`         voltar à caçada que a conta já estava fazendo, ou
 *                        trocar de caçada quando o usuário escolhe outra
 *   `market_request{history|config|price_hint|search|get}`
 *                        ler preços do mercado. Só leitura: `create`, `buy`,
 *                        `cancel` e as ofertas continuam fora da lista
 *   `expedition{panel|collect|send}`
 *                        auto-expedição: lê o painel, recolhe o que terminou e
 *                        manda a sombra mais forte do armazém para o destino
 *                        mais baixo, pelo maior tempo que a conta alcança
 *   `daily_boss{info|start}`
 *                        auto-boss: lê quais bosses diários a conta ainda não
 *                        fez hoje e entra em cada um, do mais fraco ao mais
 *                        forte, uma vez por dia
 *
 * Os quatro últimos existem porque o servidor não vende à distância: medido
 * contra ele, `buy_consumable` numa cena de caçada responde `shop.npcRequired`,
 * e `interact` sem o personagem ter andado até o NPC é ignorado em silêncio.
 * Repor consumível obriga a viagem completa — cerca de 3,3 s fora da caçada,
 * só quando falta estoque. O `start_hunt` do refill nunca escolhe caçada:
 * devolve exatamente o `gate_id`/`tier_min`/`difficulty` que o monitor leu.
 *
 * Os `party_request` de escrita só saem quando o usuário clica em montar o
 * grupo, nunca por conta própria. Eles exigem o mesmo `start_hunt` de retorno:
 * medido, `leave` manda a conta para a cidade (`party.left.to_city`), e um
 * `start_hunt` do líder puxa o grupo todo de volta (`party.follow.pulled`).
 *
 * A troca de caçada é a única escolha de caçada que sai daqui, e só por pedido
 * explícito: `setHunt()` existe para o usuário trocar de mapa sem desligar o
 * monitor, que antes exigia voltar para a WebView. Ela passa a valer como novo
 * bilhete de volta, senão o refill seguinte devolveria a conta ao mapa antigo.
 * Nada aqui escolhe caçada por conta própria.
 *
 * O auto-boss usa o mesmo bilhete de volta, e pela mesma razão do refill:
 * medido, terminar um boss diário devolve a conta à cidade. A diferença é que
 * ele enfileira vários bosses, então o `start_hunt` sai **uma vez**, depois do
 * último — devolver a conta à caçada entre dois bosses pagaria duas trocas de
 * cena por nada.
 *
 * Continua proibido: `leave_hunt`, `set_automation`, `use_consumable` e
 * `revive`.
 *
 * O servidor aceita uma sessão por conta e substitui a anterior, então ativar
 * o headless derruba a aba do jogo e vice-versa — é o mecanismo de troca de
 * modo. Por isso `session_ended` com código de substituição nunca reconecta:
 * significa que a conta assumiu em outro lugar. Os outros códigos são queda de
 * sessão e reconectam normalmente; confundir os dois fazia o monitor desistir
 * sozinho depois de horas.
 */

'use strict';

const EventEmitter = require('events');
const { getCodec } = require('./leveling-codec');
const refill = require('./leveling-refill');
const party = require('./leveling-party');
const hunts = require('./leveling-hunts');
const marketCatalog = require('./leveling-market-catalog');
const sniper = require('./leveling-sniper');
const expedition = require('./leveling-expedition');
const boss = require('./leveling-boss');
// `listingRules` e não `listing`: `pollSniper` tem laços com uma variável
// `listing` por anúncio, e um módulo sombreado ali seria um erro silencioso.
const listingRules = require('./leveling-listing');
const autosell = require('./leveling-autosell');
const cambio = require('./leveling-cambio');

const WS_URL = 'wss://game.levelingidle2d.com.br:8443/ws';
const ORIGIN = 'https://levelingidle2d.com.br';

/**
 * Heartbeat. O servidor derruba sessão ociosa, mas não precisa de 1 Hz: cada
 * ping é um round-trip protobuf com Promise e timeout por conta, e a 1 Hz isso
 * era o maior custo fixo do monitor. 15 s mantém o elo vivo com folga.
 */
const PING_INTERVAL_MS = 15000;
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Cadência de atualização do painel. Os números da caçada são por hora, então
 * um segundo não melhora a leitura; o que esse tick realmente faz é recalcular
 * taxas quando nada chegou do servidor.
 */
const TICK_INTERVAL_MS = 2000;

const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;

/**
 * O servidor limita tentativas de autenticação (`ratelimit.login`). Insistir no
 * backoff normal só renova a punição, então erro de limite espera bem mais.
 */
const RATELIMIT_RETRY_MS = 180000;

/**
 * Espera entre refills da mesma conta. O estoque muda a cada poção usada, e um
 * `character_patch` chega junto: sem esse intervalo, uma caçada ativa dispararia
 * uma compra por segundo.
 */
const REFILL_INTERVAL_MS = 30000;

/**
 * Recuo após o servidor recusar a compra (ouro insuficiente, nível, limite).
 * O estoque continua abaixo do mínimo, então sem isso o cliente repetiria a
 * recusa para sempre.
 */
const REFILL_BACKOFF_MS = 300000;

/**
 * Teto do ciclo de viagem inteiro. Medido, o ciclo leva ~3,3 s; este limite é
 * o seguro contra o caso em que um pacote esperado nunca chega e a conta
 * ficaria parada na cidade sem ninguém a devolver à caçada.
 */
const TRIP_TIMEOUT_MS = 45000;

/** Distância em que o servidor aceita `interact` no NPC. Medido ≤700. */
const NPC_REACH = 700;

/**
 * Intervalo do coletor do mercado. Medido: `market_request{history}` devolve
 * 100 vendas cobrindo ~30 min, ou seja ~3,4 vendas por minuto. Ler a cada
 * minuto reamostra a mesma janela trinta vezes de propósito: a sobreposição é
 * o que garante que nada se perca se uma leitura falhar, e o banco descarta a
 * repetição pela chave primária da venda.
 */
const MARKET_POLL_MS = 60000;

/**
 * Intervalo entre leituras do painel de expedição de uma conta.
 *
 * Folgado de propósito: a expedição mais curta que a automação manda dura
 * horas, então o que este número decide não é "quando mandar" — é quanto
 * tempo uma vaga fica vazia depois de terminar. Um minuto de vaga ociosa em
 * doze horas não muda o rendimento, e ler de segundo em segundo seria tráfego
 * puro.
 */
const EXPEDITION_POLL_MS = 60000;

/**
 * Recuo após o servidor recusar um envio. O painel continuaria pedindo o mesmo
 * envio no tique seguinte, então sem isto uma recusa viraria um erro por
 * minuto para sempre.
 */
const EXPEDITION_BACKOFF_MS = 600000;

/**
 * Intervalo entre leituras do estado de boss diário de uma conta.
 *
 * Bem mais folgado que a expedição porque o estado muda **uma vez por dia**:
 * este número não decide quando os bosses são feitos — o relógio da virada
 * decide. Ele só limita em quanto tempo o launcher percebe um reset que o
 * relógio local perdeu, como num PC que estava suspenso na virada ou numa
 * conta que logou depois dela.
 */
const BOSS_POLL_MS = 600000;

/**
 * Recuo após o servidor recusar a entrada no boss. Diferente da expedição, a
 * recusa aqui costuma ser definitiva no dia (`boss.doneToday`), então o recuo
 * existe para o caso transitório — e é largo porque a rodada seguinte legítima
 * só vem no dia seguinte.
 */
const BOSS_BACKOFF_MS = 900000;

/**
 * Espera entre o fim de um boss e a entrada no próximo.
 *
 * Medido: o resultado chega antes de a conta sair da cena do boss, e um
 * `daily_boss{start}` enviado nesse intervalo é recusado com a conta ainda em
 * cena. Dois segundos é a folga que fez a fila passar inteira sem recusa.
 */
const BOSS_GAP_MS = 2000;

/**
 * Tamanho do log do sniper.
 *
 * O log é gravado em disco (`sniperLogSink`) porque a pergunta que ele responde
 * — "o item entrou dentro do teto e quem levou?" — é a que se faz na manhã
 * seguinte, depois de deixar o launcher rodando. O teto é o que o mantém um
 * registro recente e não um histórico: o mercado nunca para de anunciar, e o
 * que importa de verdade (a venda) o banco do mercado já guarda.
 */
const SNIPER_LOG_MAX = 300;

/**
 * Anúncios que sumiram e são investigados por rodada. Um pedido por anúncio,
 * em série, igual ao enriquecedor de nível: um teto evita que uma lista grande
 * de regras vire uma rajada de dezenas de pedidos num tique de poucos
 * segundos.
 */
const SNIPER_RESOLVE_MAX = 10;

/**
 * Tamanho do relatório do auto-anunciar.
 *
 * Mesma razão do log do sniper, com um motivo extra: aqui o launcher **vende**
 * sozinho, e a pergunta da manhã seguinte é "o que ele anunciou, e por quanto".
 * Cada linha carrega a conta do preço — mediana, rival e piso — porque um
 * anúncio automático que não dá para auditar depois é um anúncio em que não se
 * pode confiar.
 *
 * O teto é mais folgado que o do sniper: uma rodada escreve no máximo dois
 * itens, então 300 linhas cobrem semanas em vez de uma noite.
 */
const AUTOSELL_LOG_MAX = 300;

/**
 * Recusas de compra que significam "outra pessoa levou", não "deu erro". O
 * sniper corre contra outros compradores por desenho, então perder é o caso
 * comum e o log tem de dizer isso em vez de mostrar falha.
 */
/**
 * Moedas do mercado por número. O nome é como o enum chega no `decode`, e o
 * número é o que `encode` aceita — `verify` recusa o nome, igual às tiers de
 * poção no refill.
 */
/** Tipos de anúncio por número. Mesma razão das moedas: `verify` recusa nome. */
const MARKET_KIND_NUM = {
  MARKET_KIND_ITEM: 1,
  MARKET_KIND_SHADOW: 2,
  MARKET_KIND_EXCHANGE: 3
};

const MARKET_CURRENCY_NUM = {
  MARKET_CURRENCY_GOLD: 1,
  MARKET_CURRENCY_DIAMOND: 2,
  MARKET_CURRENCY_TOKEN: 3
};

/**
 * Direção do `warehouse_move` por número. Mesma razão das moedas: `verify`
 * recusa o nome do enum e aceita só o número.
 */
const WAREHOUSE_DIRECTION_NUM = {
  TO_WAREHOUSE: 1,
  TO_BAG: 2
};

const SNIPER_LOST_CODES = new Set([
  'market.notFound', 'market.notActive', 'market.sold', 'market.gone',
  'market.quantity', 'market.expired'
]);

/**
 * Tráfego de simulação de mundo: chega a 20 Hz e não alimenta nenhum número do
 * painel. Descartado no `peek`, antes de desserializar, para que o headless não
 * pague CPU por ~500 pacotes a cada 25 segundos.
 */
const IGNORED_CASES = new Set([
  'world_snapshot',
  'world_events',
  'entity_spawn',
  'entity_despawn',
  'move_ack',
  'npc_interaction'
]);

/**
 * Exceções a `IGNORED_CASES`, válidas só durante o ciclo de refill. A posição
 * do personagem é a única forma de saber que ele chegou ao balcão, e
 * `npc_interaction` é a confirmação de que a loja abriu. Fora do ciclo os dois
 * voltam a ser puro volume e continuam descartados no `peek`.
 */
const TRIP_CASES = new Set(['world_snapshot', 'npc_interaction']);

/**
 * Exceções a `IGNORED_PUSHES`, válidas só durante um hop de câmbio.
 *
 * `trade_push` é o único canal pelo qual a troca avança: o `TradeState` de cada
 * etapa e o `TradeCompleted` do fecho chegam por ele, e sem eles o hop não teria
 * como saber que o parceiro travou nem que o ouro passou. `social_push` entra
 * porque é por ele que o pedido de amizade é visto do outro lado.
 *
 * Fora do hop os dois voltam a ser descartados no `peek`: `social_push` chega em
 * rajada a cada login (presença de cada amigo) e não alimenta número nenhum do
 * painel.
 */
const CAMBIO_CASES = new Set(['trade_push', 'social_push']);

/**
 * `FriendAction.Kind` como número.
 *
 * Medido: o `verify` do codec responde `enum value expected` ao nome
 * (`KIND_REQUEST`), porque o enum é aninhado em `FriendAction` e o nome só
 * resolve no escopo do pai. É o mesmo motivo de `MARKET_KIND_NUM` existir.
 *
 * Só `REQUEST` e `ACCEPT` estão aqui: `DECLINE`, `REMOVE`, `BLOCK` e `UNBLOCK`
 * mexeriam na lista social do usuário, que não é assunto de nenhuma automação.
 */
const FRIEND_KIND = { REQUEST: 1, ACCEPT: 2 };

/**
 * Operações de troca que podem sair daqui. Lista fechada, como a do serviço
 * inteiro.
 *
 * `candidates` fica de fora de propósito: é a listagem de itens e sombras
 * ofertáveis, e o câmbio transfere só ouro — nada aqui tem motivo para
 * descobrir quais peças poderiam entrar numa oferta.
 */
const TRADE_OPS = new Set([
  'invite', 'respond', 'set_offer', 'lock', 'confirm', 'cancel', 'get_state'
]);

/**
 * Tique do laço do câmbio. Curto de propósito e sem relação com o intervalo
 * entre trocas: quem decide se já pode trocar é `pollCambio`, contra
 * `cambioLastAtMs`. Um `setInterval` do tamanho do intervalo faria o primeiro
 * hop esperar o intervalo inteiro depois de ligar.
 */
const CAMBIO_TICK_MS = 15000;

/**
 * Teto para um hop. Medido, a troca inteira leva ~3 s de `invite` a
 * `completed`, e a `TradeState` do servidor só expira em 300 s. Quarenta e
 * cinco segundos é o mesmo teto do refill, pela mesma razão: nenhuma etapa pode
 * prender **duas** contas fora da caçada.
 */
const CAMBIO_HOP_TIMEOUT_MS = 45000;

const CAMBIO_LOG_MAX = 300;

/**
 * Pushes que o painel não mostra. `shadow_delta` e `content_catalog` entram
 * aqui por volume: o catálogo passa de 1 MB e a lista de sombras é grande,
 * enquanto nenhum dos dois alimenta um número da caçada.
 *
 * O catálogo é a única exceção condicional: ele é lido **uma vez**, e só
 * quando algo precisa dele — os preços dos consumíveis, para o auto-refill, e a
 * lista de portais, para a troca de caçada. O objeto de 1 MB é descartado em
 * seguida; sobram alguns kilobytes.
 *
 * `market_push` saiu desta lista: é raro (só dispara em venda da própria
 * conta) e é a única via que informa quem comprou — o feed público do mercado
 * anonimiza vendedor e comprador.
 */
const IGNORED_PUSHES = new Set([
  'social_push', 'guild_push', 'commerce_push', 'admin_push',
  'mail_push', 'trade_push', 'pool_push', 'pvp_push', 'gvg_push',
  'housing_push', 'training_push', 'guild_boss_push', 'news_push', 'tower_push',
  'team_war_push', 'tournament_push', 'dungeon_break_push', 'missions_push',
  'battle_pass_push', 'wallet_push',
  'content_catalog', 'shadow_delta', 'shadow_page', 'shadow_species_page',
  'inventory_page', 'fight_rules'
]);

/**
 * Códigos de `session_ended` que significam "outra sessão assumiu". Só estes
 * são handoff deliberado — a conta foi para a WebView ou para outra instância,
 * e brigar pela sessão só derrubaria o usuário de onde ele está.
 *
 * Qualquer outro código é queda: expiração de sessão, reinício do servidor,
 * ociosidade. Tratá-los como handoff fazia o monitor desistir sozinho depois de
 * horas e a conta voltar ao modo normal sem ninguém ter pedido.
 */
const REPLACED_CODES = new Set(['session.replaced', 'session.duplicate']);

/** O encerramento foi a conta assumindo em outro lugar, e não uma queda? */
function isHandoff(code) {
  return REPLACED_CODES.has(code);
}

/** Falha de autenticação por limite de tentativas, não por credencial ruim. */
const RATELIMIT_CODES = new Set(['ratelimit.login', 'ratelimit.auth']);

/**
 * Recusas de autenticação em que insistir não serve para nada: a credencial
 * está errada ou a conta não pode entrar. Tentar de novo só geraria ratelimit,
 * então a conta é encerrada e o usuário tem de agir.
 *
 * Lista fechada de propósito. Qualquer outro código é tratado como falha
 * transitória e reconecta — manutenção do servidor, erro interno, um
 * `session.multi_account_ip` por duas contas saírem juntas pela mesma rota.
 * O contrário (desistir de tudo que não fosse ratelimit) matava o monitor
 * sozinho e exigia reativar a conta à mão.
 */
const FATAL_AUTH_CODES = new Set([
  'account.invalid_credentials',
  'account.not_found',
  'account.banned',
  'account.suspended',
  'auth.invalid_credentials'
]);

/**
 * Rota de saída da conta. O servidor recusa várias contas vindo do mesmo IP
 * (`session.multi_account_ip`), então o monitor precisa sair pelo mesmo proxy
 * que a WebView daquela conta usa.
 *
 * O `WebSocket` do Node é o do `undici`, que não lê variáveis de ambiente de
 * proxy nem aceita um agente genérico: a rota entra pela opção `dispatcher`.
 * Um agente por URL de proxy é reaproveitado entre contas que compartilham a
 * mesma rota, para não abrir pools duplicados.
 */
const dispatchers = new Map();

/**
 * Converte um uid para o que o `verify` do codec aceita num campo `uint64`.
 *
 * Medido: `verify` responde `integer|Long[] expected` a uma string, e o
 * inventário e o painel de sombras entregam uid como string — `decode` roda
 * com `longs: String` justamente para não perder precisão. Número cru só vale
 * até 2^53; acima disso a conversão passa por `Long`, que é o que o
 * protobufjs usa internamente.
 */
function uint64(value) {
  const texto = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(texto)) return null;
  const n = Number(texto);
  if (Number.isSafeInteger(n)) return n > 0 ? n : null;
  try {
    return require('protobufjs').util.Long.fromString(texto, true);
  } catch {
    return null;
  }
}

/**
 * Espera um prazo. É a única pausa por tempo do serviço, e existe para a fila
 * do boss: entre dois bosses o que separa um do outro não é um pacote, é a
 * saída da conta da cena anterior — e o servidor não a anuncia.
 */
function sleep(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
  });
}

function proxyDispatcher(proxyUrl) {
  if (!proxyUrl) return null;
  if (dispatchers.has(proxyUrl)) return dispatchers.get(proxyUrl);

  let dispatcher = null;
  try {
    const undici = require('undici');
    const socks = /^socks/i.test(proxyUrl);
    const Agent = socks ? undici.Socks5ProxyAgent : undici.ProxyAgent;
    if (!Agent) throw new Error(`proxy ${socks ? 'SOCKS' : 'HTTP'} não suportado por esta versão do undici`);
    dispatcher = new Agent(proxyUrl);
  } catch (err) {
    // Guardar o nulo evitaria tentar de novo, mas aqui a falha é de
    // configuração: vale repetir quando o usuário corrigir a URL.
    throw new Error('proxy inválido: ' + err.message);
  }

  dispatchers.set(proxyUrl, dispatcher);
  return dispatcher;
}

class LevelingHeadlessClient extends EventEmitter {
  constructor(accountIndex, options = {}) {
    super();
    this.index = accountIndex;
    this.wsUrl = options.wsUrl || WS_URL;
    this.origin = options.origin || ORIGIN;
    this.username = options.username || '';
    this.password = options.password || '';
    this.token = options.token || '';
    /** URL de proxy já normalizada, ou vazio para sair pelo IP local. */
    this.proxy = options.proxy || '';
    this.codec = options.codec || getCodec();
    this.webSocketImpl = options.WebSocket || null;
    // Injetáveis para que os testes não precisem esperar o intervalo real.
    this.pingIntervalMs = options.pingIntervalMs || PING_INTERVAL_MS;
    this.tickIntervalMs = options.tickIntervalMs || TICK_INTERVAL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs || REQUEST_TIMEOUT_MS;
    this.refillIntervalMs = options.refillIntervalMs || REFILL_INTERVAL_MS;
    this.refillBackoffMs = options.refillBackoffMs || REFILL_BACKOFF_MS;
    this.expeditionIntervalMs = options.expeditionIntervalMs || EXPEDITION_POLL_MS;
    this.expeditionBackoffMs = options.expeditionBackoffMs || EXPEDITION_BACKOFF_MS;
    this.bossIntervalMs = options.bossIntervalMs || BOSS_POLL_MS;
    this.bossBackoffMs = options.bossBackoffMs || BOSS_BACKOFF_MS;
    this.bossGapMs = options.bossGapMs === undefined ? BOSS_GAP_MS : options.bossGapMs;

    /**
     * Auto-refill. Desligado por padrão: o monitor não deve gastar ouro de uma
     * conta sem o usuário ter pedido item por item.
     */
    this.refillConfig = refill.normalizeConfig(options.refillConfig);
    /** Preços extraídos do `content_catalog`; `null` até o primeiro login. */
    this.catalog = null;
    /**
     * Portais, faixas e dificuldades, para a troca de caçada. Sai do mesmo
     * `content_catalog` e pelo mesmo motivo de `catalog`: o objeto de 1 MB é
     * lido uma vez e descartado, e o que sobra são alguns kilobytes.
     *
     * Compartilhado entre contas, porque é conteúdo do jogo e não da conta: o
     * primeiro login do launcher o preenche e os outros não pagam a leitura.
     */
    this.huntStore = options.huntStore || { value: null };
    /**
     * Ícones, cores de raridade e sprites de monstro, para a tela de preços.
     * Mesma origem e mesma regra de `huntStore`: conteúdo do jogo, uma
     * leitura por execução do launcher, compartilhada entre as contas.
     */
    this.marketCatalogStore = options.marketCatalogStore || { value: null, fresh: false };
    /** O catálogo já foi desserializado nesta sessão? Ele chega uma vez só. */
    this.catalogRead = false;
    /** `InventorySummary.materials` cru, até o id da essência ser conhecido. */
    this.materials = null;
    this.refillAt = 0;
    this.refillBusy = false;
    /**
     * Preço unitário real por item, aprendido do `gold_cost` das compras. O
     * catálogo erra por um fator de ~5 e o fator não é o mesmo entre itens,
     * então orçar sem isto fura a reserva de ouro.
     */
    this.learnedPrices = {};
    /**
     * Viagem em andamento. Guarda o bilhete de volta (`hunt`), o NPC de loja e
     * a posição do personagem — nada disso é estado de painel, e sem o bilhete
     * a conta ficaria parada na cidade.
     */
    this.trip = null;
    /** Esperas por push, só abertas durante o ciclo: `caseName` → entradas. */
    this.waiters = new Map();

    /**
     * Auto-expedição. Desligada por padrão, pelo mesmo princípio do refill: ela
     * ocupa as sombras do armazém por até 24 h, e sombra em expedição não pode
     * ser fundida nem equipada — ligar isso sozinho atrapalharia quem está
     * mexendo no exército.
     */
    this.expeditionConfig = expedition.normalizeConfig(options.expeditionConfig);
    /** Último painel lido, já recortado. `null` até a primeira leitura. */
    this.expeditionPanel = null;
    this.expeditionAt = 0;
    this.expeditionBusy = false;
    this.expeditionTimer = null;
    this.expeditionStats = { polls: 0, collected: 0, sent: 0, lastAtMs: 0, lastError: '' };

    /**
     * Auto-boss diário. Desligado por padrão, e por um motivo mais forte que o
     * da expedição: a tentativa do boss é **uma por dia e não volta**. Uma conta
     * que entra sem equipamento perde a chance até o reset seguinte, e isso o
     * usuário não pode desfazer.
     */
    this.bossConfig = boss.normalizeConfig(options.bossConfig);
    /** Último estado lido, já recortado. `null` até a primeira leitura. */
    this.bossState = null;
    /**
     * `reset_at_ms` do dia em que a última rodada foi concluída.
     *
     * É o que impede duas rodadas no mesmo dia, e vem do **servidor** em vez do
     * relógio do PC de propósito: duas contas podem logar em horas diferentes, e
     * uma reconexão no meio do dia não pode valer como dia novo.
     */
    this.bossRunResetAtMs = 0;
    /** Relatório da última rodada, para a janela e para o painel. */
    this.bossLastRun = null;
    this.bossAt = 0;
    this.bossBusy = false;
    this.bossTimer = null;
    /** Despertador da virada local; só manda reler, não decide o dia. */
    this.bossResetTimer = null;
    this.bossStats = { runs: 0, polls: 0, done: 0, failed: 0, lastAtMs: 0, lastError: '' };

    this.ws = null;
    this.status = 'disconnected';
    this.lastError = '';
    /** Preenchido quando o servidor encerra a sessão; bloqueia a reconexão. */
    this.endedReason = null;

    this.nextRequestId = 1;
    this.pending = new Map();
    this.pingTimer = null;
    this.tickTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.autoReconnect = options.autoReconnect !== false;

    /** Caçada lida na entrada, para `start_hunt` devolver a conta a ela. */
    this.huntTicket = null;
    /** Entidade do próprio personagem na cena corrente. */
    this.ownEntity = 0;
    /** NPCs da cena corrente; o de loja é achado por `NPC_SERVICE_SHOP`. */
    this.sceneNpcs = [];
    /** Viagem que não chegou ao `start_hunt`; o próximo login resgata. */
    this.tripInterrupted = false;
    /**
     * Montagem de grupo em curso. Abre as esperas por `party_push`, que fora
     * disso não são aguardadas por ninguém: o fluxo normal do painel só reage
     * ao push quando ele chega.
     */
    this.partyBusy = false;
    /**
     * Hop de câmbio em curso. Abre as esperas por `trade_push`, que fora disso
     * é descartado no `peek`, e protege a conta de refill, boss e troca de
     * caçada no meio de uma transferência de ouro.
     */
    this.cambioBusy = false;
    /**
     * Cena em que a conta estava quando o hop começou. Um `scene_enter`
     * diferente disto durante a troca significa que algo arrastou a conta —
     * medido na sonda, o líder do grupo faz isso com `party.follow.pulled` — e
     * o hop tem de abortar antes de confirmar.
     */
    this.cambioScene = '';
    /** Marcada por `applyScene` quando algo tira a conta da cena no meio do hop. */
    this.cambioDragged = false;
    /**
     * Convites de grupo já recebidos, por id de quem convidou.
     *
     * Existe por causa de uma corrida medida: o `party_push{invite}` chega no
     * convidado **antes** de o `party_response` do `invite` voltar para o
     * líder. Como `waitForInvite` só é chamado depois dessa resposta, o push
     * caía num `wake` sem ouvintes e sumia — a conta ficava de fora com
     * `party.inviteNotReceived`, e o convite pendente que sobrava no servidor
     * fazia a tentativa seguinte falhar com `party.invite.already`.
     */
    this.partyInvites = new Map();

    this.sessionStartTime = 0;
    this.state = this.initialState(options);
  }

  initialState(options = {}) {
    return {
      ok: true,
      i: this.index,
      game: 'leveling-idle',
      name: options.username || '',
      accountId: null,
      level: 0,
      levelCap: 0,
      classId: '',
      hunterRank: 0,
      gold: 0,
      diamonds: 0,
      xp: 0,
      xpToNext: 0,
      hp: 0,
      maxHp: 0,
      power: 0,
      online: 0,
      /** Caçada corrente, acumulada a partir dos deltas de `hunt_session`. */
      hunt: {
        gateId: '',
        tierMin: 0,
        difficulty: '',
        bossId: '',
        startedAtMs: 0,
        kills: 0,
        xp: 0,
        gold: 0,
        chests: 0,
        goldSpent: 0,
        wave: 0,
        streak: 0,
        bestStreak: 0,
        redPortalUntilMs: 0,
        drops: {}
      },
      death: null,
      scene: { id: '', kind: '', channel: 0, instanceId: '' },
      consumables: {},
      /** Poções somadas por tipo; as tiers vêm separadas no protocolo. */
      potions: { hp: 0, mana: 0, revives: 0, shadowPotions: 0, shadowRevives: 0 },
      /**
       * O mesmo estoque sem somar as tiers, que é o que o auto-refill precisa:
       * repor "poção grande" não é a mesma compra que repor "poção pequena".
       * `essence` não existe como campo no protocolo — vem de
       * `InventorySummary.materials`, pelo id que o catálogo da loja informa.
       */
      stock: {
        hp: { pequena: 0, media: 0, grande: 0 },
        mana: { pequena: 0, media: 0, grande: 0 },
        revives: { pequena: 0, media: 0, grande: 0 },
        // Consumíveis de sombra não têm tier no protocolo: são contadores.
        shadowPotions: 0,
        shadowRevives: 0,
        essence: 0
      },
      /** Último refill executado, para o HUD mostrar o que foi comprado. */
      refill: null,
      /**
       * Expedições da conta: quantas sombras estão fora e quando a primeira
       * volta. É o que a janela de auto-expedição mostra por conta, e fica no
       * estado — e não só numa resposta de IPC — para a tela acompanhar sem
       * perguntar, mesmo com a janela aberta em segundo plano.
       */
      expedition: null,
      /**
       * Bosses diários da conta: quantos já foram hoje, quantos faltam e quando
       * o dia vira. Fica no estado — e não só numa resposta de IPC — para a
       * janela acompanhar sem perguntar, mesmo em segundo plano, e para o HUD
       * poder mostrar a pendência do dia.
       */
      boss: null,
      /**
       * Rodada de boss em curso. O HUD mostra pelo mesmo motivo de
       * `refillTrip`: é um momento em que a conta está fora da caçada por
       * decisão do launcher, e sem o aviso a cena mudaria sem explicação.
       */
      bossRun: false,
      /**
       * Viagem de reposição em curso. O HUD mostra isto porque é o único
       * momento em que a conta está fora da caçada por decisão do launcher: sem
       * o aviso, o usuário veria a cena mudar para a cidade sem explicação.
       */
      refillTrip: false,
      /** Pontos não gastos: status e as três árvores de talento. */
      points: { stat: 0, talent: 0, shadowTalent: 0, ambitionTalent: 0 },
      /** Grupo atual; vazio quando a conta caça sozinha. */
      party: { id: '', maxMembers: 0, members: [] },
      multipliers: {},
      boosts: {},
      /** Extração de sombras (ARISE), que roda automática no servidor. */
      shadows: { attempts: 0, captured: 0, awakened: 0, newSpecies: 0, lastMonsterId: '' },
      inventory: { usedSlots: 0, capacity: 0 },
      a: { seconds: 0, xph: 0, goldph: 0, killsph: 0 }
    };
  }

  // ------------------------------------------------------------- ciclo de vida

  connect() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    if (this.endedReason) {
      // Outra sessão assumiu a conta; reconectar só brigaria com ela.
      return;
    }

    this.clearReconnect();
    this.setStatus('connecting');

    const WS = this.webSocketImpl || globalThis.WebSocket;
    if (!WS) {
      this.fail('WebSocket não disponível no ambiente.');
      return;
    }

    let ws;
    try {
      const init = { headers: { Origin: this.origin } };
      const dispatcher = proxyDispatcher(this.proxy);
      if (dispatcher) init.dispatcher = dispatcher;
      ws = new WS(this.wsUrl, init);
    } catch (err) {
      this.fail(err.message);
      this.scheduleReconnect();
      return;
    }

    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.authenticate().catch(err => {
        // O `request` da autenticação rejeita por timeout ou socket fechado.
        // Só anotar o erro deixava o monitor pendurado para sempre: socket
        // aberto, sem ping, sem painel e sem reconexão agendada. Fechar e
        // reagendar é o que faz a conta voltar sozinha.
        if (this.ws !== ws) return;
        this.fail(err.message);
        this.close();
        this.scheduleReconnect();
      });
    };

    ws.onmessage = event => {
      if (this.ws !== ws) return;
      this.handlePacket(event.data);
    };

    ws.onerror = err => {
      if (this.ws !== ws) return;
      this.lastError = (err && err.message) || 'erro de conexão no WebSocket';
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.teardown();
      this.setStatus('disconnected');
      this.scheduleReconnect();
    };
  }

  async proxyPublicIp() {
    if (!this.proxy) return { ip: '', error: 'proxy.notConfigured' };
    try {
      const undici = require('undici');
      const res = await undici.request('https://api.ipify.org?format=json', {
        dispatcher: proxyDispatcher(this.proxy), headersTimeout: 8000, bodyTimeout: 8000
      });
      const body = await res.body.json();
      if (res.statusCode < 200 || res.statusCode >= 300 || !body.ip) throw new Error(`HTTP ${res.statusCode}`);
      return { ip: String(body.ip) };
    } catch (e) { return { ip: '', error: e.message || 'proxy.ipFailed' }; }
  }

  async authenticate() {
    // `resume` preserva o lugar na fila de sessão; `login` é o primeiro acesso.
    const useResume = !!this.token;
    const result = useResume
      ? await this.request('resume', { token: this.token })
      : await this.request('login', { username: this.username, password: this.password });

    if (result.caseName === 'error') {
      const code = (result.value && result.value.code) || 'auth.failed';

      // Limite de tentativas: a credencial pode estar certa, então vale
      // esperar bem mais em vez de desistir da conta.
      if (RATELIMIT_CODES.has(code)) {
        this.fail(code);
        this.reconnectDelay = RATELIMIT_RETRY_MS;
        this.close();
        this.scheduleReconnect();
        return;
      }

      if (useResume) {
        // Token velho: cai para credenciais, se houver. O token é descartado de
        // qualquer forma — ele não serve mais, e guardá-lo faria toda
        // reconexão seguinte gastar um `resume` que já se sabe recusado.
        this.token = '';
        this.emit('token', { index: this.index, token: '' });
        if (this.username && this.password) return this.authenticate();
      }

      // Credencial errada ou conta impedida: insistir só geraria ratelimit, e
      // nenhuma espera resolve. A conta é encerrada e o usuário tem de agir.
      if (FATAL_AUTH_CODES.has(code)) {
        this.endedReason = code;
        this.autoReconnect = false;
        this.fail(code);
        this.close();
        return;
      }

      // Qualquer outro código é tratado como transitório: manutenção, erro
      // interno, colisão de IP entre duas contas. Desistir aqui era o que
      // derrubava o monitor sozinho por uma falha que passa.
      this.fail(code);
      this.close();
      this.scheduleReconnect();
      return;
    }

    const auth = result.value || {};
    if (auth.token && auth.token !== this.token) {
      this.token = auth.token;
      this.emit('token', { index: this.index, token: auth.token });
    }
    this.state.accountId = auth.account_id != null ? String(auth.account_id) : null;
    if (auth.username) this.state.name = auth.username;

    this.sessionStartTime = Date.now();
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.setStatus('connected');
    this.startTimers();
    this.fetchParty();
    this.rescueTrip();
    // A expedição é a única automação que precisa de um relógio próprio: ela
    // não é disparada por nenhum push, e o que a aciona é um prazo de horas
    // vencendo. Ligar aqui, e não no construtor, garante que ela só começa com
    // a sessão de pé.
    this.syncExpeditionTimer();
    this.maybeExpedition();
    // O boss é a segunda automação com relógio próprio, e pela mesma razão: o
    // que a aciona é a virada do dia, não um push. Ligar no login também cobre
    // a conta que só entrou depois da 00:01 — o despertador daquele dia já
    // passou, e sem esta chamada ela esperaria até a virada seguinte.
    this.syncBossTimer();
    this.maybeBoss();
    this.emitUpdate();
  }

  /**
   * O grupo não vem no `character_state`: só em `party_push`, que o servidor
   * manda quando alguém entra ou sai. Sem este `get` inicial a conta apareceria
   * sem grupo até a próxima mudança. Continua sendo leitura.
   */
  fetchParty() {
    this.request('party_request', { get: {} })
      .then(res => {
        if (res.caseName !== 'party_response') return;
        if (this.applyParty((res.value || {}).state)) this.emitUpdate();
      })
      .catch(() => {});
  }

  ping() {
    if (!this.isOpen()) return;
    this.request('ping', { client_time_ms: Date.now() })
      .then(res => {
        if (res.caseName === 'pong' && res.value && res.value.online != null) {
          this.state.online = Number(res.value.online) || 0;
        }
      })
      .catch(() => {});
  }

  startTimers() {
    clearInterval(this.pingTimer);
    // Um ping imediato preenche `online` sem esperar o primeiro intervalo.
    this.ping();
    this.pingTimer = setInterval(() => this.ping(), this.pingIntervalMs);

    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      if (this.status !== 'connected') return;
      // Só avisa se algum número de fato mudou: com a caçada parada, o tick não
      // custa IPC nem repintura.
      if (this.recomputeRates()) this.emitUpdate();
    }, this.tickIntervalMs);

    // `unref` nos dois, como no coletor e no sniper: manter o elo vivo e
    // recontar taxas acompanham uma conexão, não são motivo para o processo
    // continuar de pé. Sem isto um monitor que ninguém desligou deixa o Node
    // rodando para sempre — é o que prendia a suíte depois do último teste.
    if (this.pingTimer.unref) this.pingTimer.unref();
    if (this.tickTimer.unref) this.tickTimer.unref();
  }

  /**
   * Taxas por hora derivadas do início real da caçada, não da conexão.
   * Devolve `true` se algum valor mudou.
   */
  recomputeRates() {
    const startedAt = this.state.hunt.startedAtMs || this.sessionStartTime;
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const a = this.state.a;
    let changed = a.seconds !== seconds;
    a.seconds = seconds;
    if (seconds > 0) {
      const perHour = 3600 / seconds;
      const next = {
        xph: Math.round(this.state.hunt.xp * perHour),
        goldph: Math.round(this.state.hunt.gold * perHour),
        killsph: Math.round(this.state.hunt.kills * perHour)
      };
      for (const [key, value] of Object.entries(next)) {
        if (a[key] !== value) {
          a[key] = value;
          changed = true;
        }
      }
    }
    return changed;
  }

  // ----------------------------------------------------------------- requests

  isOpen() {
    return !!this.ws && this.ws.readyState === 1;
  }

  request(caseName, value = {}) {
    if (!this.isOpen()) return Promise.reject(new Error('socket fechado'));
    const id = this.nextRequestId;
    this.nextRequestId = this.nextRequestId >= 0xffffffff ? 1 : this.nextRequestId + 1;

    let payload;
    try {
      payload = this.codec.encode(id, caseName, value);
    } catch (err) {
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout em ${caseName}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: res => { clearTimeout(timer); resolve(res); },
        reject: err => { clearTimeout(timer); reject(err); }
      });
      try {
        this.ws.send(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  // ---------------------------------------------------------------- recepção

  handlePacket(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let head;
    try {
      head = this.codec.peek(buf);
    } catch {
      return;
    }

    // Descarte barato: o pacote nunca é desserializado.
    if (!head.caseName) return;
    if (!head.requestId && (IGNORED_CASES.has(head.caseName) || IGNORED_PUSHES.has(head.caseName))) {
      // Duas exceções condicionais. O catálogo é lido uma vez, com o refill
      // ligado, pelos níveis mínimos e pelo id da essência. Posição e interação
      // com NPC só interessam enquanto o ciclo de compra está em curso.
      const catalogo = head.caseName === 'content_catalog' && this.wantsCatalog();
      const viagem = this.trip && TRIP_CASES.has(head.caseName);
      // Terceira exceção: a troca de ouro avança por `trade_push`, e só
      // enquanto um hop está em curso.
      const cambio = this.cambioBusy && CAMBIO_CASES.has(head.caseName);
      if (!catalogo && !viagem && !cambio) return;
    }

    let packet;
    try {
      packet = this.codec.decode(buf);
    } catch (err) {
      this.emit('error', { index: this.index, error: err });
      return;
    }

    if (packet.requestId && this.pending.has(packet.requestId)) {
      const entry = this.pending.get(packet.requestId);
      this.pending.delete(packet.requestId);
      entry.resolve(packet);
      return;
    }

    const changed = this.reduce(packet);
    // O ciclo de refill espera pacotes em vez de dormir. Acordar depois do
    // `reduce` garante que quem esperava já lê o estado novo. A montagem de
    // grupo usa o mesmo mecanismo, esperando o `party_push` do convite.
    if (this.trip || this.partyBusy || this.bossBusy || this.cambioBusy) {
      this.wake(packet.caseName, packet.value);
    }
    if (changed) this.emitUpdate();
  }

  /**
   * Espera um push específico. É isto que substitui qualquer sleep no ciclo de
   * compra: cada etapa prossegue no pacote que a confirma, não num prazo.
   * Resolve `null` no timeout, para o chamador decidir se aborta.
   */
  waitFor(caseName, timeoutMs) {
    return new Promise(resolve => {
      const list = this.waiters.get(caseName) || [];
      const entry = { resolve };
      entry.timer = setTimeout(() => {
        const current = this.waiters.get(caseName) || [];
        const i = current.indexOf(entry);
        if (i >= 0) current.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      list.push(entry);
      this.waiters.set(caseName, list);
    });
  }

  wake(caseName, value) {
    const list = this.waiters.get(caseName);
    if (!list || !list.length) return;
    this.waiters.set(caseName, []);
    for (const entry of list) {
      clearTimeout(entry.timer);
      entry.resolve(value || {});
    }
  }

  /** Solta todas as esperas; usado quando a conexão cai no meio do ciclo. */
  clearWaiters() {
    for (const list of this.waiters.values()) {
      for (const entry of list) {
        clearTimeout(entry.timer);
        entry.resolve(null);
      }
    }
    this.waiters.clear();
  }

  /** Envio sem resposta: `travel`, `move_to` e `interact` não respondem. */
  emitPacket(caseName, value) {
    if (!this.isOpen()) throw new Error('socket fechado');
    const id = this.nextRequestId;
    this.nextRequestId = this.nextRequestId >= 0xffffffff ? 1 : this.nextRequestId + 1;
    this.ws.send(this.codec.encode(id, caseName, value));
  }

  /** Traduz um push em estado de painel. Devolve `true` se algo mudou. */
  reduce(packet) {
    const { caseName, value } = packet;
    if (!value) return false;

    switch (caseName) {
      case 'session_ended':
        return this.onSessionEnded(value);

      case 'character_state':
        // Snapshot completo: campo ausente significa zero, não "sem mudança".
        return this.applyCharacter(value, true);

      case 'character_patch':
        return this.applyCharacter(value);

      case 'hunt_session':
        return this.applyHuntSession(value);

      case 'scene_enter':
        return this.applyScene(value);

      case 'death_state':
        return this.applyDeath(value);

      case 'arise_result':
        return this.applyArise(value);

      case 'inventory_delta':
        return this.applyInventoryDelta(value);

      case 'party_push':
        // O convite é guardado sempre, mesmo fora da montagem: ele chega antes
        // da resposta que faz o convidado começar a esperar por ele.
        this.rememberInvites(value);
        // `state` ausente num push de convite/medidor não significa sem grupo.
        return value.state ? this.applyParty(value.state) : false;

      case 'party_response':
        return this.applyParty(value.state);

      case 'content_catalog':
        // Só chega aqui com o refill ligado; o `peek` descarta o resto.
        return this.applyCatalog(value);

      // Só chegam aqui durante o ciclo de compra, e não são estado de painel:
      // a posição diz se o personagem alcançou o balcão.
      case 'world_snapshot':
        return this.applyTripPosition(value);

      case 'npc_interaction':
        return false;

      // O servidor reemite o estado do boss quando algo muda nele — entrar num
      // boss, terminar, o dia virar. Aproveitar o push mantém o painel em dia
      // sem outra leitura, e é o que faz a contagem do dia aparecer certa logo
      // depois de um boss feito à mão na WebView.
      case 'daily_boss_state':
        this.bossState = boss.readState(value);
        this.applyBoss(this.bossState);
        return false;

      // O resultado é consumido pela fila através de `waitFor`; aqui ele não é
      // estado de painel. O `daily_boss_state` que vem junto é que atualiza a
      // contagem.
      case 'daily_boss_result':
        return false;

      // A automação do servidor gasta pontos e poções sozinha. Estes resultados
      // trazem o saldo novo e evitam o painel esperar o próximo snapshot.
      case 'allocate_stats_result':
        return this.setPoints('stat', value.remaining_points);

      case 'allocate_talent_result':
        return this.setPoints('talent', value.remaining_points);

      // `use_consumable_result` não entra aqui: o `remaining` dele é da tier
      // usada, e o `character_patch` seguinte traz `consumables` inteiro.

      // Venda própria. O feed público (`market_request{history}`) anonimiza
      // vendedor e comprador; este push é a única via que traz o comprador,
      // porque é dirigido a quem vendeu. Vale uma linha no banco com dados
      // que nenhuma leitura do feed teria.
      case 'market_push':
        if (value.sold) this.emit('market-sold', { index: this.index, sold: value.sold });
        return false;

      case 'notice':
        this.emit('notice', { index: this.index, notice: value });
        return false;

      case 'error':
        this.lastError = value.code || 'erro';
        return false;

      default:
        return false;
    }
  }

  /**
   * Fim de sessão anunciado pelo servidor. Dois casos muito diferentes vêm no
   * mesmo pacote, e separá-los é o que mantém o monitor de pé:
   *
   *   handoff  a conta assumiu no navegador ou em outra instância. Ceder é a
   *            única resposta certa: reconectar derrubaria o usuário de onde
   *            ele está, e é assim que o botão de ligar/desligar funciona.
   *   queda    sessão expirada, servidor reiniciado, ociosidade. A conta não
   *            está em uso em nenhum outro lugar, então o lugar é do monitor e
   *            ele reconecta pelo backoff normal.
   *
   * Marcar `endedReason` nos dois casos era o bug: ele bloqueia
   * `scheduleReconnect`, e o manager desmontava o cliente. Depois de algumas
   * horas qualquer queda de sessão devolvia a conta ao modo normal.
   */
  onSessionEnded(value) {
    const code = value.code || 'session.ended';
    const handoff = isHandoff(code);

    if (handoff) {
      this.endedReason = code;
      this.autoReconnect = false;
    } else {
      // O socket desta sessão já não vale. Fechar aqui em vez de esperar o
      // `onclose` do servidor: ele pode nunca chegar, e um socket meio morto
      // deixaria o monitor parado sem painel nem reconexão. `close()` zera
      // `this.ws`, o que faz o `onclose` tardio ser ignorado — então o reagendar
      // é explícito. O token é preservado: a sessão morreu, a credencial não.
      this.lastError = code;
      this.close();
      this.setStatus('disconnected');
      this.scheduleReconnect();
    }

    this.emit('ended', {
      index: this.index,
      code,
      handoff,
      params: value.params || {}
    });
    return false;
  }

  /**
   * @param {boolean} full snapshot (`character_state`) em vez de patch.
   *   Importa para `points` e `consumables`: `decode` usa `defaults: false`, e
   *   proto3 omite zeros. Gastar o último ponto não manda `points: {stat: 0}`,
   *   manda `points` ausente — num patch isso é "sem mudança", num snapshot é
   *   zero. Sem essa distinção o painel congelava no último valor não nulo.
   */
  applyCharacter(value, full = false) {
    const s = this.state;
    let changed = false;
    const set = (key, next) => {
      if (next === undefined || next === null) return;
      if (s[key] !== next) { s[key] = next; changed = true; }
    };

    if (value.identity) {
      set('name', value.identity.name);
      set('classId', value.identity.class_id);
      set('hunterRank', Number(value.identity.hunter_rank) || s.hunterRank);
    }
    if (value.progress) {
      const p = value.progress;
      set('level', Number(p.level) || s.level);
      set('levelCap', Number(p.level_cap) || s.levelCap);
      set('xp', Number(p.xp) || 0);
      set('xpToNext', Number(p.xp_to_next) || 0);
      set('hp', Number(p.hp) || 0);
    }
    if (value.wallet) {
      set('gold', Number(value.wallet.gold) || 0);
      set('diamonds', Number(value.wallet.diamonds) || 0);
    }
    if (value.derived) {
      set('maxHp', Number(value.derived.max_hp) || s.maxHp);
      set('power', Number(value.derived.power) || s.power);
    }
    if (value.hunt) {
      const h = value.hunt;
      if (h.streak != null) { s.hunt.streak = Number(h.streak) || 0; changed = true; }
      if (h.best_streak != null) { s.hunt.bestStreak = Number(h.best_streak) || 0; changed = true; }
      if (h.tier_min != null) { s.hunt.tierMin = Number(h.tier_min) || 0; changed = true; }
      if (h.difficulty) { s.hunt.difficulty = h.difficulty; changed = true; }
    }
    if (value.points || full) {
      const p = value.points || {};
      const points = {
        stat: Number(p.stat_points) || 0,
        talent: Number(p.talent_points) || 0,
        shadowTalent: Number(p.shadow_talent_points) || 0,
        ambitionTalent: Number(p.ambition_talent_points) || 0
      };
      for (const [key, next] of Object.entries(points)) {
        if (s.points[key] !== next) { s.points[key] = next; changed = true; }
      }
    }
    if (value.consumables || full) {
      s.consumables = value.consumables || {};
      changed = this.applyPotions(s.consumables) || changed;
    }
    if (value.inventory) {
      changed = this.applyMaterials(value.inventory) || changed;
    }
    if (value.multipliers) { s.multipliers = value.multipliers; changed = true; }
    if (value.boosts) { s.boosts = value.boosts; changed = true; }

    // O estoque ou o ouro podem ter mudado; é o único gatilho do refill.
    if (changed) this.maybeRefill();

    return changed;
  }

  /**
   * Poções chegam divididas em pequena/média/grande. O painel mostra o total
   * por tipo — o que interessa na leitura é se ainda há poção, não qual tier —
   * mas o auto-refill precisa das tiers separadas, porque cada uma é uma compra
   * diferente. Os dois ficam no estado: `potions` soma, `stock` detalha.
   */
  applyPotions(consumables) {
    const counts = value => {
      const c = value || {};
      return {
        pequena: Number(c.pequena) || 0,
        media: Number(c.media) || 0,
        grande: Number(c.grande) || 0
      };
    };
    const total = c => c.pequena + c.media + c.grande;

    const detailed = {
      hp: counts(consumables.hp_potions),
      mana: counts(consumables.mana_potions),
      revives: counts(consumables.revives)
    };
    const next = {
      hp: total(detailed.hp),
      mana: total(detailed.mana),
      revives: total(detailed.revives),
      shadowPotions: Number(consumables.shadow_potions) || 0,
      shadowRevives: Number(consumables.shadow_revives) || 0
    };

    const potions = this.state.potions;
    let changed = false;
    for (const [key, value] of Object.entries(next)) {
      if (potions[key] !== value) { potions[key] = value; changed = true; }
    }

    const stock = this.state.stock;
    for (const [group, tiers] of Object.entries(detailed)) {
      for (const [tier, value] of Object.entries(tiers)) {
        if (stock[group][tier] !== value) { stock[group][tier] = value; changed = true; }
      }
    }
    // Sombras entram no `stock` como o contador que são: o refill lê daqui, e
    // sem isto o planejador veria sempre zero e compraria sem parar.
    for (const key of ['shadowPotions', 'shadowRevives']) {
      if (stock[key] !== next[key]) { stock[key] = next[key]; changed = true; }
    }
    return changed;
  }

  /**
   * Saldo de essência. Ela não tem campo próprio no protocolo: é um material
   * comum em `InventorySummary.materials`, identificado pelo `item_def_id` que
   * a oferta de essência do catálogo informa. Sem catálogo não há como saber
   * qual material é, então o saldo fica em zero e o planejador recusa a compra.
   */
  applyMaterials(summary) {
    const materials = Array.isArray(summary.materials) ? summary.materials : [];
    // O catálogo chega junto do login, mas a ordem não é garantida e o refill
    // pode ser ligado depois. Guardar a lista crua permite resolver o saldo
    // quando o id finalmente for conhecido, sem esperar outro snapshot.
    if (materials.length) this.materials = materials;

    const defId = this.catalog && this.catalog.essence && this.catalog.essence.defId;
    if (!defId) return false;
    const found = this.materials && this.materials.find(m => m && m.def_id === defId);
    const next = found ? Number(found.qty) || 0 : 0;
    if (this.state.stock.essence === next) return false;
    this.state.stock.essence = next;
    return true;
  }

  /** Saldo de pontos vindo de um resultado de alocação. */
  setPoints(key, remaining) {
    if (remaining == null) return false;
    const next = Number(remaining) || 0;
    if (this.state.points[key] === next) return false;
    this.state.points[key] = next;
    return true;
  }

  /** Grupo atual, reduzido ao que o painel mostra de cada membro. */
  applyParty(state) {
    const party = this.state.party;
    const value = state || {};
    const id = value.party_id != null ? String(value.party_id) : '';

    // Sem id o servidor está dizendo que a conta não está em grupo.
    if (!id || id === '0') {
      if (!party.id && !party.members.length) return false;
      this.state.party = { id: '', maxMembers: 0, members: [] };
      return true;
    }

    const members = (Array.isArray(value.members) ? value.members : []).map(m => ({
      accountId: m.account_id != null ? String(m.account_id) : '',
      name: m.name || '',
      classId: m.class_id || '',
      level: Number(m.level) || 0,
      hp: Number(m.hp) || 0,
      maxHp: Number(m.max_hp) || 0,
      online: !!m.online,
      leader: !!m.leader,
      dead: !!m.dead,
      role: m.role || '',
      // O próprio monitor aparece na lista; marcar evita confundir na leitura.
      self: this.state.accountId != null && String(m.account_id) === this.state.accountId
    }));

    const next = { id, maxMembers: Number(value.max_members) || 0, members };
    if (JSON.stringify(next) === JSON.stringify(party)) return false;
    this.state.party = next;
    return true;
  }

  /**
   * `hunt_session` é delta esparso: proto3 omite zeros, então campos ausentes
   * significam "sem mudança", não "zerado". Só um `started_at_ms` diferente
   * indica caçada nova e autoriza reiniciar os contadores.
   */
  applyHuntSession(value) {
    const hunt = this.state.hunt;
    const startedAtMs = Number(value.started_at_ms) || 0;
    let changed = false;

    // Caçada nova: zerar os acumuladores, preservando o recorde de streak,
    // que é da conta e não da sessão.
    if (startedAtMs && startedAtMs !== hunt.startedAtMs) {
      const bestStreak = hunt.bestStreak;
      Object.assign(hunt, this.initialState().hunt, { startedAtMs, bestStreak });
      changed = true;
    }

    const num = (key, field) => {
      if (value[field] == null) return false;
      const next = Number(value[field]) || 0;
      if (hunt[key] === next) return false;
      hunt[key] = next;
      return true;
    };
    const text = (key, field) => {
      if (!value[field]) return false;
      if (hunt[key] === value[field]) return false;
      hunt[key] = value[field];
      return true;
    };

    changed = text('gateId', 'gate_id') || changed;
    changed = text('difficulty', 'difficulty') || changed;
    changed = text('bossId', 'boss_id') || changed;
    changed = num('tierMin', 'tier_min') || changed;
    changed = num('kills', 'kills') || changed;
    changed = num('xp', 'xp') || changed;
    changed = num('gold', 'gold') || changed;
    changed = num('chests', 'chests') || changed;
    changed = num('goldSpent', 'gold_spent') || changed;
    changed = num('wave', 'wave') || changed;
    changed = num('streak', 'streak') || changed;
    changed = num('redPortalUntilMs', 'red_portal_until_ms') || changed;

    if (Array.isArray(value.drops) && value.drops.length) {
      for (const drop of value.drops) {
        const id = drop.item_id || drop.id;
        if (id == null) continue;
        hunt.drops[id] = Number(drop.qty || drop.count || 0) || 0;
      }
      changed = true;
    }

    if (changed) this.recomputeRates();
    return changed;
  }

  applyScene(value) {
    const scene = this.state.scene;
    scene.id = value.scene_id || '';
    scene.kind = value.kind || '';
    scene.channel = Number(value.channel) || 0;
    scene.instanceId = value.instance_id != null ? String(value.instance_id) : '';

    // O bilhete de volta. Guardado fora do painel porque é o que recoloca a
    // conta na caçada depois da compra: se o monitor entrar já na cidade, não
    // existe bilhete e o refill não parte.
    if (value.hunt && value.hunt.gate_id) {
      this.huntTicket = {
        gate_id: value.hunt.gate_id,
        tier_min: Number(value.hunt.tier_min) || 0,
        difficulty: value.hunt.difficulty || ''
      };
    }
    // Entidade própria e NPCs da cena: a viagem precisa dos dois para andar até
    // o balcão, e só valem para a cena que acabou de chegar.
    this.ownEntity = Number(value.your_entity) || 0;
    this.sceneNpcs = Array.isArray(value.npcs) ? value.npcs : [];
    if (this.trip) this.trip.pos = null;

    // Arrasto durante um hop de câmbio. Medido na sonda: o líder do grupo troca
    // de caçada e leva a conta com ele (`party.follow.pulled`), e isso chegou no
    // meio de uma medição. Se acontecer durante a troca, a conta já está em
    // outra cena ou canal e a troca não pode prosseguir — a marca é lida pelo
    // hop, que aborta antes de confirmar.
    if (this.cambioBusy && this.cambioScene && scene.id !== this.cambioScene) {
      this.cambioDragged = true;
    }

    if (value.hunt) {
      const h = value.hunt;
      if (h.gate_id) this.state.hunt.gateId = h.gate_id;
      if (h.tier_min != null) this.state.hunt.tierMin = Number(h.tier_min) || 0;
      if (h.difficulty) this.state.hunt.difficulty = h.difficulty;
      if (h.boss_id) this.state.hunt.bossId = h.boss_id;
    }
    return true;
  }

  /** Resultado de uma extração automática de sombra; só contabiliza. */
  applyArise(value) {
    const shadows = this.state.shadows;
    shadows.attempts += Number(value.attempts) || 1;
    if (value.monster_id) shadows.lastMonsterId = value.monster_id;
    if (!value.success) return true;

    shadows.captured++;
    if (value.awakened) shadows.awakened++;
    if (value.new_species) shadows.newSpecies++;
    this.emit('arise', {
      index: this.index,
      monsterId: value.monster_id || '',
      rank: value.rank || '',
      awakened: !!value.awakened,
      newSpecies: !!value.new_species
    });
    return true;
  }

  /** Só a ocupação da mochila interessa: itens em si ficam na WebView. */
  applyInventoryDelta(value) {
    const inv = this.state.inventory;
    const used = Number(value.used_slots);
    const capacity = Number(value.capacity);
    let changed = false;
    if (!Number.isNaN(used) && used !== inv.usedSlots) { inv.usedSlots = used; changed = true; }
    if (!Number.isNaN(capacity) && capacity && capacity !== inv.capacity) {
      inv.capacity = capacity;
      changed = true;
    }
    return changed;
  }

  /**
   * Posição do próprio personagem, extraída da snapshot de mundo. Só roda
   * durante o ciclo de compra e não mexe no painel, então nunca devolve `true`.
   */
  applyTripPosition(value) {
    if (!this.trip || !this.ownEntity) return false;
    // `WorldSnapshot.entities` é `EntityState` direto: `x`/`y` estão no próprio
    // elemento, sem invólucro. Ler um campo aninhado aqui deixava a posição
    // sempre nula, e com ela o monitor nunca saberia que chegou ao balcão.
    for (const ent of value.entities || []) {
      if (ent && Number(ent.id) === this.ownEntity) {
        this.trip.pos = { x: Number(ent.x) || 0, y: Number(ent.y) || 0 };
        break;
      }
    }
    return false;
  }

  /** Morte é só reportada: o `auto_revive` da conta resolve no servidor. */
  applyDeath(value) {
    if (!value.dead) {
      if (!this.state.death) return false;
      this.state.death = null;
      return true;
    }
    this.state.death = {
      dead: true,
      diedAtMs: Number(value.died_at_ms) || 0,
      autoReturnAtMs: Number(value.auto_return_at_ms) || 0,
      xpLost: Number(value.xp_lost) || 0,
      xpLostPct: Number(value.xp_lost_pct) || 0,
      reviveBlocked: !!value.revive_blocked
    };
    this.emit('death', { index: this.index, death: this.state.death });
    return true;
  }

  // ----------------------------------------------------------------- refill

  /**
   * Vale desserializar o catálogo? São mais de 1 MB por login, então só uma vez
   * por sessão e só se algo de fato o usar: os preços, para o refill, ou a
   * lista de portais, para a troca de caçada.
   *
   * A lista de portais é compartilhada entre as contas, então a segunda em
   * diante não paga a leitura — só a primeira do launcher.
   *
   * A cópia salva em disco não dispensa a leitura: ela existe para o seletor
   * abrir cheio antes de qualquer login, mas pode estar velha em relação ao
   * jogo. Uma leitura por execução do launcher é o que a mantém em dia.
   */
  wantsCatalog() {
    if (this.catalogRead) return false;
    if (!this.catalog && refill.isConfigured(this.refillConfig)) return true;
    // A aparência do mercado (ícones, cores de raridade, sprites de monstro)
    // também só existe aqui dentro. Como as duas outras leituras, é uma por
    // execução do launcher e compartilhada entre as contas.
    if (!this.marketCatalogStore.fresh) return true;
    return !this.huntStore.fresh;
  }

  /**
   * Guarda só preços, níveis mínimos, o id da essência e o catálogo de
   * caçadas. O objeto grande sai de escopo aqui e nunca fica preso no cliente.
   */
  applyCatalog(value) {
    this.catalogRead = true;
    // A tabela de preços só é guardada se o refill de fato for usá-la: ela é
    // inútil com a reposição desligada, e o catálogo pode ter sido
    // desserializado apenas pelos portais.
    if (!this.catalog && refill.isConfigured(this.refillConfig)) {
      this.catalog = refill.readCatalog(value);
    }

    const lido = hunts.readHuntCatalog(value);
    if (hunts.hasHunts(lido)) {
      this.huntStore.value = lido;
      // Lido do servidor nesta execução: a cópia de disco pode ser substituída.
      this.huntStore.fresh = true;
      // Interessa à interface mesmo sem nenhuma mudança de estado da conta: é
      // o que preenche a lista de mapas do seletor de caçada.
      this.emit('hunts', { index: this.index, catalog: lido });
    }

    if (!this.marketCatalogStore.fresh) {
      // `fresh` marca "já olhei", não "achei algo". Se dependesse do conteúdo,
      // um catálogo sem itens faria toda conta seguinte desserializar 1 MB de
      // novo para chegar à mesma resposta vazia.
      this.marketCatalogStore.fresh = true;
      const mkt = marketCatalog.readMarketCatalog(value);
      if (marketCatalog.hasCatalog(mkt)) {
        this.marketCatalogStore.value = mkt;
        this.emit('market-catalog', { index: this.index, catalog: mkt });
      }
    }

    // O saldo de essência só pode ser resolvido agora que o id dela é conhecido.
    const changed = this.applyMaterials({});
    this.maybeRefill();
    return changed;
  }

  /** O catálogo de caçadas conhecido, ou `null` antes do primeiro login. */
  getHuntCatalog() {
    return this.huntStore.value;
  }

  /** Troca a configuração em execução, sem derrubar a sessão. */
  setRefillConfig(config) {
    this.refillConfig = refill.normalizeConfig(config);
    // Mudar a configuração é um pedido explícito: não esperar o intervalo.
    this.refillAt = 0;
    if (this.status === 'connected') this.maybeRefill();
  }

  /**
   * Repõe o que está abaixo do mínimo. O planejamento é de `leveling-refill`;
   * aqui ficam só as guardas de execução: um refill por vez, intervalo entre
   * eles e recuo quando o servidor recusa.
   */
  maybeRefill() {
    if (this.refillBusy || !this.isOpen() || this.status !== 'connected') return;
    if (!refill.isConfigured(this.refillConfig)) return;
    if (Date.now() < this.refillAt) return;
    // A rodada de boss guardou o bilhete de volta e vai restaurá-lo no fim. Uma
    // viagem de compra no meio disso faria os dois `finally` brigarem pelo mesmo
    // bilhete, e a conta acabaria na cidade ou na cena errada. A espera custa
    // alguns minutos, e a rodada é uma por dia.
    if (this.bossBusy) return;
    // Mesmo motivo durante um hop de câmbio: a conta está na cidade com uma
    // troca aberta, e o hop guardou o bilhete para devolvê-la no fim. O hop
    // leva segundos; o refill pega a próxima janela.
    if (this.cambioBusy) return;

    if (!this.catalog) {
      // O catálogo chega no login; se o refill foi ligado depois, ele não vem
      // de novo sozinho. Pedir aqui seria um case a mais de escrita, então o
      // refill espera o próximo login da conta.
      return;
    }

    if (!this.planRefill().orders.length) return;

    // Sem bilhete de volta a viagem é proibida: comprar deixaria a conta na
    // cidade para sempre, o que é pior do que não repor.
    //
    // Sem recuo aqui: `character_state` chega antes de `scene_enter`, então no
    // login o bilhete sempre falta por um instante. Aplicar o backoff nesse
    // instante travava o refill por cinco minutos a cada conexão. A próxima
    // chamada já encontra o bilhete, e a cena é empurrada uma vez só por
    // sessão — isto não vira laço.
    if (!this.huntTicket) return;

    this.refillBusy = true;
    this.refillAt = Date.now() + this.refillIntervalMs;
    this.runRefill().finally(() => { this.refillBusy = false; });
  }

  /**
   * Devolve a conta à caçada se um ciclo de compra anterior foi interrompido
   * pela queda da conexão. Sem isto a conta ficaria parada na cidade até o
   * usuário notar, rendendo nada — a pior falha possível deste recurso.
   *
   * Só age se a conta de fato não está em caçada: `scene_enter` numa cena de
   * caçada já traz o bilhete, e nesse caso não há o que resgatar.
   */
  rescueTrip() {
    if (!this.tripInterrupted || !this.huntTicket) return;
    this.tripInterrupted = false;
    // A cena de entrada só chega depois do `auth_ok`; esperar por ela evita
    // mandar `start_hunt` na conta que já voltou sozinha.
    this.trip = { pos: null, startedAt: Date.now(), rescue: true };
    this.waitFor('scene_enter', 15000)
      .then(scene => {
        this.trip = null;
        if (!scene || scene.kind === 'SCENE_KIND_HUNT') return;
        return this.request('start_hunt', this.huntTicket)
          .then(() => this.emit('refill', { index: this.index, ok: false, error: 'refill.rescued' }));
      })
      .catch(() => { this.trip = null; });
  }

  /** O plano corrente, com os preços já aprendidos do servidor. */
  planRefill() {
    return refill.plan({
      stock: this.state.stock,
      config: this.refillConfig,
      gold: this.state.gold,
      level: this.state.level,
      catalog: this.catalog,
      learned: this.learnedPrices
    });
  }

  /**
   * Ciclo completo de reposição, medido contra o servidor: ele não vende à
   * distância, então repor exige sair da caçada.
   *
   *   travel → move_to → interact → comprar em série → start_hunt de volta
   *
   * Orientado a evento: cada etapa espera o pacote que a confirma. O `finally`
   * é a parte que não pode falhar — a conta volta à caçada mesmo que a compra
   * dê erro no meio, senão ela fica parada na cidade rendendo nada.
   */
  async runRefill() {
    const ticket = this.huntTicket;
    const cidade = (this.catalog && this.catalog.citySceneId) || 'cidade-seul';
    const cenaOrigem = this.state.scene.id;
    this.trip = { pos: null, startedAt: Date.now() };
    this.state.refillTrip = true;
    this.emitUpdate();
    // Se a conexão cair entre o `travel` e o `start_hunt`, o `finally` abaixo
    // não consegue devolver a conta — fica para o próximo login resgatar.
    this.tripInterrupted = true;

    let bought = [];
    let erro = '';

    try {
      await this.withTimeout(this.shopTrip(cidade), TRIP_TIMEOUT_MS)
        .then(result => { bought = result.bought; erro = result.error; });
    } catch (err) {
      erro = err.message;
    } finally {
      // Resgate: a conta precisa voltar mesmo que tudo acima tenha falhado.
      // Só não tenta se o personagem nunca saiu, para não reiniciar a caçada
      // em curso sem motivo e zerar os contadores da sessão.
      if (this.isOpen() && this.state.scene.id !== cenaOrigem) {
        try {
          await this.request('start_hunt', ticket);
          await this.waitFor('scene_enter', 15000);
        } catch (err) {
          // Falhar aqui deixa a conta na cidade: é o pior caso e precisa
          // aparecer, não ser engolido.
          erro = erro || `volta falhou: ${err.message}`;
        }
      }
      // A conta voltou (ou nunca saiu): não há nada para o próximo login
      // resgatar. Só continua marcado se o processo morreu antes desta linha.
      if (this.state.scene.id === cenaOrigem) this.tripInterrupted = false;
      this.trip = null;
      this.state.refillTrip = false;
      this.clearWaiters();
    }

    if (erro) {
      // O estoque continua abaixo do mínimo, então sem recuo o mesmo pedido
      // recusado voltaria no próximo patch, para sempre.
      this.refillAt = Date.now() + this.refillBackoffMs;
      this.lastError = erro;
      this.emit('refill', { index: this.index, ok: false, error: erro, items: bought });
    }

    if (!bought.length) {
      // Nada comprado, mas a viagem acabou: o HUD precisa saber que a conta já
      // voltou, e o erro é o que explica por que ela saiu por nada.
      if (erro) this.state.refill = { at: Date.now(), items: [], cost: 0, error: erro };
      this.emitUpdate();
      return;
    }

    const total = bought.reduce((sum, item) => sum + item.cost, 0);
    this.state.refill = { at: Date.now(), items: bought, cost: total, error: erro || undefined };
    if (!erro) this.emit('refill', { index: this.index, ok: true, items: bought, cost: total });
    this.emitUpdate();
  }

  /**
   * A ida, a compra e a conferência. Separado de `runRefill` para que o retorno
   * à caçada fique num `finally` que nenhum `throw` daqui possa pular.
   */
  async shopTrip(cidade) {
    const bought = [];

    // ------------------------------------------------------------- 1. viagem
    this.emitPacket('travel', { scene_id: cidade });
    const chegou = await this.waitFor('scene_enter', 15000);
    if (!chegou || chegou.scene_id !== cidade) {
      return { bought, error: 'refill.travelFailed' };
    }

    // -------------------------------------------------------- 2. achar a loja
    const loja = this.sceneNpcs.find(n => n && n.service === 'NPC_SERVICE_SHOP' && n.pos);
    if (!loja) return { bought, error: 'refill.noShopNpc' };

    // --------------------------------------------------------- 3. ir ao balcão
    // Medido: sem andar, o servidor ignora o `interact` em silêncio e a compra
    // responde `shop.npcRequired`. A caminhada é simulada no servidor e leva
    // ~3 s; o fim dela é observado nas snapshots, não esperado por prazo.
    this.emitPacket('move_to', { x: loja.pos.x, y: loja.pos.y });
    const chegouAoBalcao = await this.walkTo(loja.pos);
    if (!chegouAoBalcao) return { bought, error: 'refill.walkFailed' };

    // --------------------------------------------------------- 4. abrir a loja
    this.emitPacket('interact', { entity: loja.entity });
    const abriu = await this.waitFor('npc_interaction', 5000);
    if (!abriu) return { bought, error: 'refill.shopNotOpen' };

    // ------------------------------------------------------------- 5. comprar
    // Em série, nunca em paralelo: em paralelo os pedidos dividiriam o mesmo
    // ouro sem o servidor conciliar, e o segundo falharia depois de o primeiro
    // já ter gasto o orçamento planejado.
    //
    // Duas passagens porque o preço só é conhecido depois da primeira compra:
    // a primeira sonda uma unidade de cada item e aprende o `gold_cost`, a
    // segunda compra o lote restante com o preço real. Já estando no balcão,
    // isso não custa viagem nenhuma.
    for (let passagem = 0; passagem < 2; passagem++) {
      const plano = this.planRefill();
      if (!plano.orders.length) break;

      for (const order of plano.orders) {
        if (!this.isOpen()) return { bought, error: 'refill.disconnected' };

        let response;
        try {
          response = await this.request(order.caseName, order.value);
        } catch (err) {
          return { bought, error: err.message };
        }
        if (response.caseName === 'error') {
          const code = (response.value && response.value.code) || 'refill.failed';
          return { bought, error: code };
        }

        const value = response.value || {};
        const qty = Number(value.qty) || order.qty;
        const cost = Number(value.gold_cost) || order.cost;
        // O preço real do item, que é o que o próximo plano vai orçar. Dividido
        // pela quantidade porque a compra é linear nela (medido: 5×11 = 55).
        if (qty > 0 && cost > 0) this.learnedPrices[order.key] = Math.ceil(cost / qty);

        bought.push({ key: order.key, label: order.label, qty, cost });
        this.applyBought(order, value);
      }
    }

    return { bought, error: '' };
  }

  /**
   * Espera o personagem alcançar o ponto, observando as snapshots de mundo.
   * Sem sleep: se as snapshots pararem de chegar, desiste.
   */
  async walkTo(target) {
    for (let i = 0; i < 60; i++) {
      const snapshot = await this.waitFor('world_snapshot', 2000);
      if (!snapshot) return false;
      const pos = this.trip && this.trip.pos;
      if (!pos) continue;
      if (Math.hypot(pos.x - target.x, pos.y - target.y) <= NPC_REACH) return true;
    }
    return false;
  }

  /** Teto para o ciclo: nenhuma etapa pode prender a conta fora da caçada. */
  withTimeout(promise, ms) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('refill.timeout')), ms);
      })
    ]).finally(() => clearTimeout(timer));
  }

  /**
   * Aplica o saldo devolvido pela compra. `buy_consumable_result.owned` é o
   * total da tier comprada, que é exatamente a granularidade do `stock` — isso
   * evita o cliente replanejar a mesma compra antes do próximo `character_patch`.
   */
  applyBought(order, value) {
    if (order.caseName === 'buy_essence') {
      this.state.stock.essence += Number(value.qty) || order.qty;
    } else {
      const item = refill.ITEMS.find(i => i.key === order.key);
      if (item && item.noTier) {
        // Sombras não têm tier: o estoque é o próprio contador, e é o mesmo
        // número que o HUD mostra — não há soma de tiers para refazer.
        const atual = Number(this.state.stock[item.stockKey]) || 0;
        const novo = value.owned != null ? Number(value.owned) || 0 : atual + order.qty;
        this.state.stock[item.stockKey] = novo;
        this.state.potions[item.stockKey] = novo;
      } else if (item) {
        const group = this.state.stock[item.stockKey];
        group[item.tierKey] = value.owned != null
          ? Number(value.owned) || 0
          : group[item.tierKey] + order.qty;
        // `potions` é a soma que o HUD mostra; mantê-la junto evita o painel
        // exibir estoque velho até o próximo `character_patch`.
        this.state.potions[item.stockKey] = group.pequena + group.media + group.grande;
      }
    }

    const cost = Number(value.gold_cost) || 0;
    if (cost) this.state.gold = Math.max(0, this.state.gold - cost);
  }

  // -------------------------------------------------------------- expedição

  /**
   * Operação de expedição. Tudo viaja dentro de `expedition`, e a resposta é
   * sempre `expedition_result`.
   *
   * Três das seis operações do `oneof` são escalares (`panel` é `bool`,
   * `collect` e `cancel` são `uint32`), então o valor vai direto em vez de num
   * objeto — mandar `{}` ali faria o `verify` do codec recusar o payload.
   *
   * `cancel`, `collect_all` e `finish_now` nunca saem daqui: cancelar perde o
   * tempo já corrido, `finish_now` gasta diamante, e `collect_all` recolheria
   * também a expedição que o usuário mandou à mão e ainda está correndo.
   */
  async expeditionRequest(op, value) {
    const res = await this.request('expedition', { [op]: value });
    if (res.caseName === 'error') {
      return { errorCode: (res.value && res.value.code) || 'exp.failed' };
    }
    return res.value || {};
  }

  /**
   * Lê o painel e guarda o recorte. É a única leitura: destinos, durações,
   * vagas, o que está correndo e quais sombras podem sair chegam todos juntos
   * num `ExpeditionPanel`.
   */
  async expeditionPanelRead() {
    const res = await this.expeditionRequest('panel', true);
    if (res.errorCode) return { errorCode: res.errorCode };
    const panel = expedition.readPanel(res.panel);
    this.expeditionPanel = panel;
    this.applyExpedition(panel);
    return { panel };
  }

  /** Reflete o painel no estado do painel do launcher. */
  applyExpedition(panel) {
    const resumo = expedition.summarize(panel);
    const antes = JSON.stringify(this.state.expedition);
    this.state.expedition = resumo;
    if (JSON.stringify(resumo) !== antes) this.emitUpdate();
    return resumo;
  }

  /** Troca a configuração em execução, sem derrubar a sessão. */
  setExpeditionConfig(config) {
    this.expeditionConfig = expedition.normalizeConfig(config);
    // Mudar a configuração é pedido explícito: não esperar o intervalo.
    this.expeditionAt = 0;
    this.syncExpeditionTimer();
    if (this.status === 'connected') this.maybeExpedition();
  }

  /**
   * Liga e desliga o relógio da expedição conforme a configuração.
   *
   * Temporizador por conta, ao contrário do sniper: o painel é da conta — as
   * sombras, as vagas e o VIP são dela —, então não há leitura compartilhada
   * para economizar. Um relógio no manager teria de percorrer as contas de
   * qualquer forma.
   */
  syncExpeditionTimer() {
    const quer = expedition.accountEnabled(this.expeditionConfig, this.index);
    if (!quer) {
      if (this.expeditionTimer) {
        clearInterval(this.expeditionTimer);
        this.expeditionTimer = null;
      }
      return;
    }
    if (this.expeditionTimer) return;
    const ms = this.expeditionConfig.intervalMs || this.expeditionIntervalMs;
    this.expeditionTimer = setInterval(() => this.maybeExpedition(), ms);
    // Como o ping e o tique: a expedição não é motivo para o processo viver.
    if (this.expeditionTimer.unref) this.expeditionTimer.unref();
  }

  /**
   * Guardas de execução. O que fazer é decisão de `leveling-expedition`; aqui
   * só mora "uma rodada por vez, respeitando o intervalo e o recuo".
   */
  maybeExpedition() {
    if (this.expeditionBusy || !this.isOpen() || this.status !== 'connected') return;
    if (!expedition.accountEnabled(this.expeditionConfig, this.index)) return;
    if (Date.now() < this.expeditionAt) return;
    // Durante a viagem de refill a conta está fora da caçada e no meio de uma
    // sequência encadeada por push; um pedido a mais no socket não quebra nada,
    // mas esperar o fim mantém o ciclo de compra com o log limpo.
    if (this.trip) return;
    // E durante um hop de câmbio, pelo mesmo motivo: a sequência da troca é
    // encadeada por push, e esperar o fim mantém o log do hop limpo.
    if (this.cambioBusy) return;

    this.expeditionBusy = true;
    this.expeditionAt = Date.now() + (this.expeditionConfig.intervalMs || this.expeditionIntervalMs);
    this.runExpedition().finally(() => { this.expeditionBusy = false; });
  }

  /**
   * Uma rodada: lê o painel, recolhe o que terminou, manda as sombras que
   * couberem nas vagas livres.
   *
   * Coletar vem antes de enviar, e em série, porque a vaga só abre depois do
   * recolhimento: enviar primeiro tomaria `exp.full` do servidor.
   *
   * Nunca lança. Roda para sempre em segundo plano, e uma falha de rede não
   * pode derrubar o temporizador — o erro fica em `expeditionStats` e no
   * evento, para a janela mostrar.
   */
  async runExpedition() {
    const stats = this.expeditionStats;
    stats.polls++;
    stats.lastAtMs = Date.now();

    let colhidas = 0;
    let enviadas = 0;
    const reports = [];
    let erro = '';

    try {
      const leitura = await this.expeditionPanelRead();
      if (leitura.errorCode) {
        stats.lastError = leitura.errorCode;
        this.emit('expedition', {
          index: this.index, ok: false, error: leitura.errorCode,
          summary: this.state.expedition, stats: this.getExpeditionStats()
        });
        return;
      }

      const plano = expedition.plan({
        panel: leitura.panel, config: this.expeditionConfig, index: this.index
      });

      for (const id of plano.collect) {
        const res = await this.expeditionRequest('collect', id);
        if (res.errorCode) { erro = res.errorCode; continue; }
        colhidas++;
        // O relatório diz o que a expedição trouxe; é a única via, o painel
        // seguinte já vem sem ela.
        for (const r of (res.reports || [])) {
          reports.push({
            gate: r.gate || '',
            difficulty: r.difficulty || '',
            minutes: Number(r.minutes) || 0,
            outcome: String(r.outcome || ''),
            stones: Number(r.stones) || 0,
            potions: Number(r.potions) || 0,
            revives: Number(r.revives) || 0
          });
        }
      }

      // Replanejar depois de coletar, e não reaproveitar o plano: o `collect`
      // devolve o painel novo, e as vagas e os candidatos de verdade são os
      // dele. O plano anterior contava as vagas antes do recolhimento.
      const atual = colhidas
        ? expedition.plan({
          panel: this.expeditionPanel, config: this.expeditionConfig, index: this.index
        })
        : plano;

      for (const send of atual.sends) {
        // `ExpeditionSend.uids` é `repeated uint64`, e o painel entrega o uid
        // como string: sem a conversão o `verify` do codec recusa o payload.
        const uids = send.uids.map(uint64).filter(u => u !== null);
        if (uids.length !== send.uids.length) {
          erro = 'exp.badUid';
          break;
        }

        const res = await this.expeditionRequest('send', {
          gate: send.gate,
          difficulty: send.difficulty,
          minutes: send.minutes,
          uids
        });
        if (res.errorCode) {
          erro = res.errorCode;
          // Recuo: a recusa se repetiria idêntica no tique seguinte, porque o
          // painel continua pedindo o mesmo envio.
          this.expeditionAt = Date.now() + this.expeditionBackoffMs;
          break;
        }
        enviadas++;
        // A resposta do envio traz o painel novo; guardá-lo mantém a tela e o
        // plano da próxima rodada em dia sem outra leitura.
        if (res.panel) {
          this.expeditionPanel = expedition.readPanel(res.panel);
          this.applyExpedition(this.expeditionPanel);
        }
      }

      stats.collected += colhidas;
      stats.sent += enviadas;
      stats.lastError = erro;

      if (colhidas || enviadas || erro) {
        this.emit('expedition', {
          index: this.index,
          ok: !erro,
          error: erro,
          collected: colhidas,
          sent: enviadas,
          reports,
          sends: atual.sends.slice(0, enviadas).map(s => ({
            gate: s.gate, difficulty: s.difficulty, minutes: s.minutes, shadow: s.shadow
          })),
          summary: this.state.expedition,
          stats: this.getExpeditionStats()
        });
      }
    } catch (err) {
      stats.lastError = (err && err.message) || String(err);
      this.emit('expedition', {
        index: this.index, ok: false, error: stats.lastError,
        summary: this.state.expedition, stats: this.getExpeditionStats()
      });
    }
  }

  getExpeditionStats() {
    return {
      ...this.expeditionStats,
      running: !!this.expeditionTimer,
      intervalMs: this.expeditionConfig.intervalMs || this.expeditionIntervalMs
    };
  }

  // ---------------------------------------------------------- boss diário

  /**
   * Operação de boss diário. Tudo viaja dentro de `daily_boss`, e a resposta é
   * sempre `daily_boss_state`.
   *
   * As duas operações do `oneof` são escalares (`info` é `bool`, `start` é
   * `string`), então o valor vai direto em vez de num objeto — mandar `{}` ali
   * faria o `verify` do codec recusar o payload, como na expedição.
   */
  async bossRequest(op, value) {
    const res = await this.request('daily_boss', { [op]: value });
    if (res.caseName === 'error') {
      return { errorCode: (res.value && res.value.code) || 'boss.failed' };
    }
    return res.value || {};
  }

  /**
   * Lê o estado e guarda o recorte. É a única leitura: a lista de bosses, o que
   * já foi feito hoje, as exigências de nível e o horário do reset chegam todos
   * juntos num `DailyBossState`.
   */
  async bossStateRead() {
    const res = await this.bossRequest('info', true);
    if (res.errorCode) return { errorCode: res.errorCode };
    const estado = boss.readState(res);
    this.bossState = estado;
    this.applyBoss(estado);
    return { state: estado };
  }

  /** Reflete o estado de boss no painel do launcher. */
  applyBoss(estado) {
    const resumo = boss.summarize(estado, { level: this.state.level });
    const antes = JSON.stringify(this.state.boss);
    this.state.boss = resumo;
    if (JSON.stringify(resumo) !== antes) this.emitUpdate();
    return resumo;
  }

  /** Troca a configuração em execução, sem derrubar a sessão. */
  setBossConfig(config) {
    this.bossConfig = boss.normalizeConfig(config);
    // Mudar a configuração é pedido explícito: não esperar o intervalo.
    this.bossAt = 0;
    this.syncBossTimer();
    if (this.status === 'connected') this.maybeBoss();
  }

  /**
   * Liga e desliga os dois relógios do boss.
   *
   * São dois porque respondem a perguntas diferentes. O intervalo é a varredura
   * de segurança — percebe um reset que ninguém viu. O despertador da virada é
   * o que faz a rodada começar logo depois da 00:01, sem esperar até dez
   * minutos: o servidor não anuncia o reset por push, então sem ele a primeira
   * leitura do dia dependeria do acaso do intervalo.
   */
  syncBossTimer() {
    const quer = boss.accountEnabled(this.bossConfig, this.index);
    if (!quer) {
      if (this.bossTimer) {
        clearInterval(this.bossTimer);
        this.bossTimer = null;
      }
      this.clearBossReset();
      return;
    }

    if (!this.bossTimer) {
      const ms = this.bossConfig.intervalMs || this.bossIntervalMs;
      this.bossTimer = setInterval(() => this.maybeBoss(), ms);
      // Como o ping e o tique: o boss não é motivo para o processo viver.
      if (this.bossTimer.unref) this.bossTimer.unref();
    }
    this.scheduleBossReset();
  }

  /**
   * Agenda o despertador da próxima virada local.
   *
   * `setTimeout` e não `setInterval`: o atraso é recalculado a cada disparo,
   * porque um `setInterval` de 24 h acumularia o desvio do relógio e, pior,
   * erraria o dia inteiro depois de uma suspensão do PC.
   */
  scheduleBossReset() {
    this.clearBossReset();
    const atraso = Math.max(1000, boss.nextLocalResetMs() - Date.now());
    this.bossResetTimer = setTimeout(() => {
      this.bossResetTimer = null;
      // O relógio local só **manda reler**. Quem diz que o dia virou é o
      // `reset_at_ms` que vem na leitura; o PC pode estar em outro fuso.
      this.bossAt = 0;
      this.maybeBoss();
      if (boss.accountEnabled(this.bossConfig, this.index)) this.scheduleBossReset();
    }, atraso);
    if (this.bossResetTimer.unref) this.bossResetTimer.unref();
  }

  clearBossReset() {
    if (this.bossResetTimer) {
      clearTimeout(this.bossResetTimer);
      this.bossResetTimer = null;
    }
  }

  /**
   * Guardas de execução. O que fazer é decisão de `leveling-boss`; aqui só mora
   * "uma rodada por vez, respeitando o intervalo, o recuo e o dia".
   */
  maybeBoss() {
    if (this.bossBusy || !this.isOpen() || this.status !== 'connected') return;
    if (!boss.accountEnabled(this.bossConfig, this.index)) return;
    if (Date.now() < this.bossAt) return;
    // A rodada tira a conta da caçada e tem de devolvê-la no fim. No meio de
    // uma viagem de refill os dois caminhos disputariam o mesmo bilhete, e o
    // `finally` de um desfaria o do outro.
    if (this.trip) return;
    // E no meio de um hop de câmbio, pela mesma disputa de bilhete: o hop
    // guardou o da conta e vai restaurá-lo quando a troca fechar.
    if (this.cambioBusy) return;

    this.bossBusy = true;
    this.bossAt = Date.now() + (this.bossConfig.intervalMs || this.bossIntervalMs);
    this.runBoss().finally(() => { this.bossBusy = false; });
  }

  /**
   * A rodada do dia: lê o estado, entra em cada boss pendente do mais fraco ao
   * mais forte, e devolve a conta à caçada no fim.
   *
   * Em série, e nunca em paralelo: a conta tem um personagem, e um
   * `daily_boss{start}` com a conta ainda na cena do boss anterior é recusado.
   *
   * O bilhete de volta é lido **antes** da primeira entrada. Depois dela a
   * conta já está na cena do boss, e ler ali traria a cena do boss em vez da
   * caçada — a conta terminaria o dia parada na cidade.
   *
   * Nunca lança. Roda para sempre em segundo plano, e uma falha de rede não
   * pode derrubar o temporizador nem deixar a conta fora da caçada: o retorno
   * mora num `finally`, igual ao do refill.
   */
  async runBoss() {
    const stats = this.bossStats;
    stats.polls++;
    stats.lastAtMs = Date.now();

    try {
      const leitura = await this.bossStateRead();
      if (leitura.errorCode) {
        stats.lastError = leitura.errorCode;
        this.emit('boss', {
          index: this.index, ok: false, error: leitura.errorCode,
          summary: this.state.boss, stats: this.getBossStats()
        });
        return;
      }

      const plano = boss.plan({
        state: leitura.state,
        config: this.bossConfig,
        index: this.index,
        level: this.state.level
      });

      // O dia é do servidor. Enquanto o `reset_at_ms` for o mesmo da última
      // rodada concluída, a rodada já aconteceu — mesmo que o launcher tenha
      // reiniciado, porque aí a fila viria vazia de `done_today` de qualquer
      // forma. A checagem economiza a tentativa inútil e mantém o log limpo.
      if (!boss.isNewDay(plano.resetAtMs, this.bossRunResetAtMs)) {
        stats.lastError = '';
        return;
      }

      if (!plano.targets.length) {
        // Nada a fazer hoje: ou tudo feito, ou nada ao alcance do nível. Nos
        // dois casos o dia está encerrado, e marcá-lo evita reler a cada tique.
        this.bossRunResetAtMs = plano.resetAtMs;
        stats.lastError = '';
        this.bossLastRun = {
          atMs: Date.now(),
          resetAtMs: plano.resetAtMs,
          results: [],
          done: plano.done.map(d => ({ id: d.id, bossId: d.bossId, already: true })),
          skipped: plano.skipped
        };
        this.emit('boss', {
          index: this.index, ok: true, nothingToDo: true,
          run: this.bossLastRun, summary: this.state.boss, stats: this.getBossStats()
        });
        return;
      }

      await this.runBossQueue(plano);
    } catch (err) {
      stats.lastError = (err && err.message) || String(err);
      this.emit('boss', {
        index: this.index, ok: false, error: stats.lastError,
        summary: this.state.boss, stats: this.getBossStats()
      });
    }
  }

  /**
   * Percorre a fila de bosses e devolve a conta à caçada no fim.
   *
   * Separado de `runBoss` porque o `finally` do retorno tem de cobrir a fila
   * inteira, e só a fila: um erro na leitura do estado não chega a tirar a
   * conta da caçada, então restaurar ali mandaria um `start_hunt` inútil.
   */
  async runBossQueue(plano) {
    const stats = this.bossStats;
    // O bilhete de volta, lido antes de a conta sair da caçada. `null` numa
    // conta que já estava na cidade — e aí não há nada a restaurar.
    const ticket = this.huntTicket ? { ...this.huntTicket } : null;
    const resultados = [];

    this.state.bossRun = true;
    this.emitUpdate();

    try {
      for (const alvo of plano.targets) {
        const resultado = await this.runOneBoss(alvo);
        resultados.push(resultado);
        if (resultado.ok) stats.done++; else stats.failed++;

        // Recusa do servidor é motivo para parar a fila: `boss.doneToday` e
        // `boss.level` se repetiriam em cada alvo seguinte, e um erro de rede
        // provavelmente também. O que já foi feito está no relatório.
        if (resultado.fatal) break;

        if (this.bossGapMs) await sleep(this.bossGapMs);
        // Perder a conexão no meio da fila encerra a rodada: o resto dos
        // pedidos falharia, e o dia não é marcado como feito.
        if (!this.isOpen()) break;
      }

      const vitorias = resultados.filter(r => r.ok).length;
      stats.runs++;
      stats.lastError = (resultados.find(r => r.error) || {}).error || '';

      // O dia só é marcado quando a fila foi percorrida de verdade. Uma rodada
      // interrompida por queda de conexão não conta: a reconexão deve tentar o
      // que faltou, e não considerar o dia resolvido.
      if (this.isOpen()) this.bossRunResetAtMs = plano.resetAtMs;

      this.bossLastRun = {
        atMs: Date.now(),
        resetAtMs: plano.resetAtMs,
        results: resultados,
        done: plano.done.map(d => ({ id: d.id, bossId: d.bossId, already: true })),
        skipped: plano.skipped
      };

      this.emit('boss', {
        index: this.index,
        ok: vitorias === resultados.length,
        attempted: resultados.length,
        victories: vitorias,
        run: this.bossLastRun,
        summary: this.state.boss,
        stats: this.getBossStats()
      });
    } finally {
      this.state.bossRun = false;
      // O retorno à caçada mora aqui, e não no fim do `try`: terminar o boss
      // devolve a conta à **cidade**, e qualquer saída deste bloco — erro,
      // recusa, exceção — deixaria a conta parada lá. É o mesmo motivo do
      // `finally` do ciclo de refill.
      await this.restoreHunt(ticket);
      this.emitUpdate();
    }
  }

  /**
   * Um boss: entra, espera o resultado, devolve o que aconteceu.
   *
   * O resultado chega em `daily_boss_result`, que é um push — o `start` responde
   * só com o estado. Por isso a espera é por push, com o teto que o próprio
   * servidor informou em `time_limit_secs`: um boss que a conta não vence roda
   * até o limite antes de responder derrota.
   *
   * Nunca lança: a fila continua, e o motivo da falha vira linha do relatório.
   */
  async runOneBoss(alvo) {
    const base = { id: alvo.id, bossId: alvo.bossId, bossLevel: alvo.bossLevel };

    // A espera abre **antes** do `start`. Medido no mesmo padrão do convite de
    // grupo: um boss que morre num golpe responde o resultado antes de o
    // `start` retornar, e abrir a espera depois perdia o push.
    const espera = this.waitFor('daily_boss_result', alvo.timeoutMs);

    const inicio = await this.bossRequest('start', alvo.id).catch(err => ({
      errorCode: (err && err.message) || 'boss.failed'
    }));

    if (inicio.errorCode) {
      // Soltar a espera aberta: sem isto ela ficaria pendurada até o timeout do
      // boss, atrasando a fila inteira por um pedido que nem saiu.
      this.wake('daily_boss_result', null);
      await espera.catch(() => {});
      this.bossAt = Date.now() + this.bossBackoffMs;
      return { ...base, ok: false, error: inicio.errorCode, fatal: true };
    }

    const resultado = await espera;
    // Sem `id` não é um veredito: é a espera solta pelo timeout ou por um
    // `wake` de desistência. Tratar isso como derrota inventaria um resultado.
    if (!resultado || !resultado.id) {
      // Nenhum resultado dentro do limite. Não é vitória nem derrota conhecida:
      // o servidor pode ter encerrado sem avisar. A próxima leitura do estado
      // dirá se a tentativa foi gasta.
      return { ...base, ok: false, error: 'boss.noResult' };
    }

    return {
      ...base,
      ok: !!resultado.victory,
      timeMs: Number(resultado.time_ms) || 0,
      newRecord: !!resultado.new_record,
      position: Number(resultado.position) || 0,
      mailed: !!resultado.mailed,
      item: (resultado.item && (resultado.item.name || resultado.item.item_id)) || '',
      gem: (resultado.gem && (resultado.gem.name || resultado.gem.item_id)) || '',
      error: resultado.victory ? '' : 'boss.defeat'
    };
  }

  /**
   * Devolve a conta à caçada do bilhete, depois da rodada de bosses.
   *
   * Um `start_hunt` para a fila inteira, e não um por boss: a conta volta à
   * cidade entre dois bosses de qualquer forma, e mandá-la à caçada no meio
   * pagaria duas trocas de cena para sair de lá no segundo seguinte.
   *
   * Sem bilhete não há o que fazer: a conta já estava na cidade antes da
   * rodada, e escolher uma caçada por conta própria é exatamente o que este
   * monitor não faz.
   */
  async restoreHunt(ticket) {
    if (!ticket || !ticket.gate_id) return false;
    if (!this.isOpen()) {
      // A conexão caiu no meio. `rescueTrip` não cobre este caminho, mas o
      // `scene_enter` do próximo login traz a cena real — e se for a cidade, a
      // rodada seguinte do boss restaura. Marcar o erro deixa isso visível.
      this.bossStats.lastError = 'boss.restoreOffline';
      return false;
    }
    const res = await this.startHunt(ticket).catch(err => ({
      errorCode: (err && err.message) || 'hunt.failed'
    }));
    if (res && res.errorCode) {
      this.bossStats.lastError = res.errorCode;
      return false;
    }
    return true;
  }

  getBossStats() {
    return {
      ...this.bossStats,
      running: !!this.bossTimer,
      intervalMs: this.bossConfig.intervalMs || this.bossIntervalMs,
      runResetAtMs: this.bossRunResetAtMs,
      nextLocalResetMs: boss.nextLocalResetMs(),
      lastRun: this.bossLastRun
    };
  }

  // ------------------------------------------------------------------- grupo

  /**
   * Operação de grupo. Medido: o servidor responde `party_response` com o
   * estado novo, ou `error` com um código (`party.exists`, `party.none`,
   * `party.notLeader`). Devolver o estado com `errorCode` anexado deixa o
   * chamador decidir, sem precisar distinguir `throw` de recusa do servidor.
   */
  async partyRequest(op, value = {}) {
    const res = await this.request('party_request', { [op]: value });
    if (res.caseName === 'error') {
      return { errorCode: (res.value && res.value.code) || 'party.failed' };
    }
    const state = (res.value && res.value.state) || null;
    // O push chega junto e já reduz; aplicar aqui também mantém o estado certo
    // quando a resposta vem antes do push.
    if (state && this.applyParty(state)) this.emitUpdate();
    return state || {};
  }

  partyGet() {
    return this.partyRequest('get', {});
  }

  /**
   * Cria o grupo. `settings.privacy` tem de ser o número do enum: medido, o
   * `verify` do codec recusa o nome com `enum value expected`.
   */
  partyCreate(settings) {
    return this.partyRequest('create', { settings });
  }

  partyInvite(name) {
    return this.partyRequest('invite', { name: String(name || '') });
  }

  /** Aceita (ou recusa) o convite de uma conta. `fromAccount` é o id do líder. */
  partyAnswer(fromAccount, accept) {
    return this.partyRequest('answer', {
      from_account: Number(fromAccount) || 0,
      accept: !!accept
    });
  }

  /**
   * Sai do grupo. Medido: isto **tira a conta da caçada** e a manda para a
   * cidade (`notice{party.left.to_city}`); quem chama precisa devolvê-la.
   */
  partyLeave() {
    return this.partyRequest('leave', {});
  }

  partyDisband() {
    return this.partyRequest('disband', {});
  }

  /** Cancela o convite pendente para uma conta. Liberta `party.invite.already`. */
  partyInviteCancel(accountId) {
    return this.partyRequest('invite_cancel', { account_id: Number(accountId) || 0 });
  }

  /** Recusa um convite pendente, do lado de quem o recebeu. */
  partyDecline(fromAccount) {
    return this.partyAnswer(fromAccount, false);
  }

  /**
   * Guarda os convites que chegam por push. `party_push` carrega um evento por
   * vez, e o convite vem solto (`invite`) ou dentro da caixa (`inbox.invites`)
   * quando o servidor remanda os pendentes.
   */
  rememberInvites(value) {
    const guardar = invite => {
      if (!invite || invite.from_account == null) return;
      this.partyInvites.set(String(invite.from_account), invite);
    };
    guardar(value.invite);
    const inbox = value.inbox;
    if (inbox && Array.isArray(inbox.invites)) inbox.invites.forEach(guardar);
  }

  /** Esquece os convites conhecidos; a montagem começa sem lixo da anterior. */
  forgetInvites() {
    this.partyInvites.clear();
  }

  /**
   * Espera o convite de `fromAccount` chegar.
   *
   * Olha primeiro o que já chegou: medido, o push do convite costuma chegar no
   * convidado **antes** de o `party_response` do `invite` voltar para o líder,
   * e como esta espera só abre depois dessa resposta, esperar sem conferir o
   * que já veio perdia o convite e deixava a conta de fora.
   */
  async waitForInvite(fromAccount, timeoutMs = 8000) {
    const alvo = String(fromAccount);
    const limite = Date.now() + timeoutMs;
    do {
      const pronto = this.partyInvites.get(alvo);
      if (pronto) return pronto;
      const push = await this.waitFor('party_push', Math.max(0, limite - Date.now()));
      if (!push) return null;
    } while (Date.now() < limite);
    return this.partyInvites.get(alvo) || null;
  }

  /**
   * Devolve a conta à caçada do bilhete. É o que puxa o grupo inteiro: medido,
   * os membros recebem `party.follow.pulled` e entram na cena em ~150 ms.
   */
  async startHunt(ticket) {
    const res = await this.request('start_hunt', {
      gate_id: ticket.gate_id,
      tier_min: Number(ticket.tier_min) || 0,
      difficulty: ticket.difficulty || ''
    });
    if (res.caseName === 'error') {
      return { errorCode: (res.value && res.value.code) || 'hunt.failed' };
    }
    return res.value || {};
  }

  // ----------------------------------------------------------------- mercado

  /**
   * Operação de mercado. Tudo viaja dentro de `market_request`, e a resposta
   * é sempre `market_response` com um `oneof result` — o nome do resultado
   * não é o mesmo da operação (`get` responde `detail`, `search` responde
   * `page`), então devolvemos a chave junto.
   *
   * Três escritas passam por aqui, todas com o usuário no comando: `buy`,
   * pelo sniper, item por item com teto de preço; `create`, pela aba Anunciar
   * e pelo auto-anunciar, com teto de itens por rodada; e `cancel`, que retira
   * um anúncio escolhido na tela. As ofertas continuam fora — elas prendem
   * saldo até alguém responder, e isso é um compromisso, não uma leitura.
   */
  async marketRequest(op, value = {}) {
    const res = await this.request('market_request', { [op]: value });
    if (res.caseName === 'error') {
      return { errorCode: (res.value && res.value.code) || 'market.failed' };
    }
    const body = res.value || {};
    const result = Object.keys(body)[0] || null;
    return { result, value: body[result] || {} };
  }

  /**
   * O feed global de vendas recentes. Medido: 100 linhas fixas, sem
   * paginação, cobrindo cerca de 30 minutos de mercado — e `seller_name` /
   * `buyer_name` vêm vazios, o servidor anonimiza o feed público.
   *
   * É a única fonte de preço efetivamente pago. O que sai dessa janela não
   * volta, por isso o launcher grava tudo localmente.
   */
  async marketHistory() {
    const res = await this.marketRequest('history');
    if (res.errorCode) return { errorCode: res.errorCode, sales: [] };
    return { sales: (res.value && res.value.sales) || [] };
  }

  /**
   * Os anúncios desta conta que ainda estão de pé.
   *
   * Leitura pura, e por conta: `mine` não leva argumento nenhum, quem decide
   * de quem são os anúncios é a sessão que faz o pedido. É por isso que a aba
   * percorre as contas uma a uma em vez de pedir tudo de uma vez.
   *
   * `limit` vem junto e importa: o jogo tem teto de anúncios simultâneos, e
   * saber que faltam duas vagas muda o que vale a pena anunciar.
   */
  async marketMine() {
    const res = await this.marketRequest('mine');
    if (res.errorCode) return { errorCode: res.errorCode, listings: [] };
    const v = res.value || {};
    return {
      listings: v.listings || [],
      active: Number(v.active) || 0,
      limit: Number(v.limit) || 0
    };
  }

  /**
   * Os totais desta conta no mercado: anúncios ativos, vendas, giro.
   *
   * É o que o servidor tem de venda **por conta** — e é só contador. Não
   * existe pedido que devolva a lista das vendas de uma conta: `history` é o
   * feed global anonimizado, idêntico em qualquer sessão, e `mine` só traz o
   * que ainda está de pé. Quem vendeu o quê, linha a linha, só o launcher
   * sabe, pelo push `market_push` que ele grava.
   *
   * Por isso o total vem daqui e a lista vem do banco: assim a aba consegue
   * dizer "o servidor contou 48 vendas, eu registrei 12" em vez de fingir que
   * as doze são tudo.
   */
  async marketOverview() {
    const res = await this.marketRequest('overview');
    if (res.errorCode) return { errorCode: res.errorCode };
    const v = res.value || {};
    return {
      activeListings: Number(v.active_listings) || 0,
      totalSales: Number(v.total_sales) || 0,
      goldMoved: Number(v.gold_moved) || 0,
      diamondsMoved: Number(v.diamonds_moved) || 0
    };
  }

  /** Vocabulário do mercado: categorias, ordenações, taxa de venda. */
  async marketConfig() {
    const res = await this.marketRequest('config');
    return res.errorCode ? { errorCode: res.errorCode } : (res.value || {});
  }

  /**
   * Estatística do servidor para um item. Complementa o banco local: cobre o
   * período anterior ao primeiro uso do launcher, que o banco nunca terá.
   *
   * Medido: `days` é encaixado em degraus fixos (1 vira 7, 365 vira 90), e
   * `rarity` é ignorado — não filtra nada. Um `def_id` inexistente devolve
   * `{days:30}` sem erro, então vendas 0 é a resposta de "não sei".
   */
  async marketPriceHint(defId, days) {
    if (!defId) return { errorCode: 'market.noDefId' };
    const value = { def_id: String(defId) };
    if (Number(days) > 0) value.days = Number(days);
    const res = await this.marketRequest('price_hint', value);
    return res.errorCode ? { errorCode: res.errorCode } : (res.value || {});
  }

  /** Anúncios à venda agora. Diferente de preço pago: é preço pedido. */
  async marketSearch(filtros = {}) {
    const value = {};
    if (filtros.category) value.category = String(filtros.category);
    if (filtros.name) value.name = String(filtros.name);
    if (filtros.defId) value.def_id = String(filtros.defId);
    if (filtros.rarity) value.rarity = String(filtros.rarity);
    if (filtros.sort) value.sort = String(filtros.sort);
    // `kind` pelo número, pelo mesmo motivo da moeda logo abaixo. O sniper
    // precisa dele para alcançar o câmbio: `cambio:diamante` não é um item,
    // e sem o `kind` a busca por `def_id` não devolve nada.
    if (filtros.kind) {
      const k = MARKET_KIND_NUM[filtros.kind];
      if (k) value.kind = k;
    }
    // Moeda pelo número, não pelo nome. `decode` entrega enums como string,
    // mas `ClientMessage.verify` recusa string na codificação — medido:
    // "enum value expected". O mesmo cuidado que `leveling-refill.js` já toma
    // com as tiers de poção.
    if (filtros.currency) {
      const n = MARKET_CURRENCY_NUM[filtros.currency];
      if (n) value.currency = n;
    }
    // Faixas de preço e de nível. São `optional` no proto, então mandar zero
    // não é o mesmo que omitir: `price_max: 0` pediria o que custa nada. Só
    // entram quando positivas, e é o sniper quem as usa — filtrar no servidor
    // é o que faz uma pechincha caber na primeira página, em vez de obrigar a
    // paginar o mercado inteiro atrás dela.
    for (const [chave, campo] of [
      ['priceMin', 'price_min'], ['priceMax', 'price_max'],
      ['levelMin', 'level_min'], ['levelMax', 'level_max']
    ]) {
      const n = Math.floor(Number(filtros[chave]));
      if (Number.isFinite(n) && n > 0) value[campo] = n;
    }
    value.page = Math.max(Number(filtros.page) || 1, 1);
    const res = await this.marketRequest('search', value);
    if (res.errorCode) return { errorCode: res.errorCode, listings: [] };
    return res.value || { listings: [] };
  }

  /**
   * Compra um anúncio. É a única escrita de mercado do launcher, e existe para
   * o sniper: a tela de preços não compra nada.
   *
   * Compra parcial é suportada pelo servidor — `MarketBought.remaining` diz o
   * que sobrou no anúncio —, e é o que permite respeitar um alvo de quantidade
   * menor que o lote anunciado.
   *
   * `id` e `quantity` são uint64 e o codec recusa string, mas `decode` entrega
   * os ids de anúncio como string: a conversão tem de acontecer aqui.
   *
   * Perder a corrida pelo anúncio é esperado, não é erro de programa: entre a
   * busca e a compra alguém pode ter levado o item. O servidor responde com
   * código, e quem chamou decide o que dizer no log.
   */
  async marketBuy(listingId, quantity = 1) {
    // `uint64()` e não `Number()`: id de anúncio acima de 2^53 arredondava para
    // o vizinho, e a compra saía no anúncio errado sem erro nenhum.
    const id = uint64(listingId);
    if (id === null) return { errorCode: 'market.badId' };
    const qty = Math.max(1, Math.floor(Number(quantity) || 1));
    const res = await this.marketRequest('buy', { id, quantity: qty });
    return res.errorCode ? { errorCode: res.errorCode } : (res.value || {});
  }

  /**
   * Retira um anúncio do mercado.
   *
   * O item **não** volta direto para a mochila: `MarketCanceled.to_mail` diz
   * quando ele foi para o correio, que é o que acontece com a bolsa cheia.
   * Quem chama precisa olhar esse campo, senão o item fica parado num lugar
   * onde o inventário não o mostra — e o usuário conclui que o cancelamento
   * perdeu a peça.
   *
   * `uint64()` no id pelo mesmo motivo da compra: acima de 2^53 um `Number`
   * cru cancelaria o anúncio vizinho, que pode ser de outro item seu.
   */
  async marketCancel(listingId) {
    const id = uint64(listingId);
    if (id === null) return { errorCode: 'market.badId' };
    const res = await this.marketRequest('cancel', { id });
    if (res.errorCode) return { errorCode: res.errorCode };
    const v = res.value || {};
    return { id: String(v.id || listingId), toMail: !!v.to_mail };
  }

  /**
   * Quanto esta conta tem dos itens pedidos, por escopo.
   *
   * Existe porque a tela de preços responde "quanto vale" mas não respondia
   * "e eu tenho?". Com oito contas, a resposta estava em oito inventários que
   * o launcher nunca abria — ele só guardava a ocupação da mochila.
   *
   * `filter.def_ids` é o que torna isso viável. Medido: 155 ids num pedido
   * só, 35 ms, e o servidor devolve apenas o que a conta de fato tem (34 de
   * 155). Sem o filtro seria varrer o inventário inteiro — 4 pedidos por
   * conta, 32 ao todo — para descartar quase tudo.
   *
   * O teto de `page_size` é 100, medido: 101 devolve zero itens, sem erro.
   * Por isso a paginação não é opcional nem quando o filtro é estreito: um
   * material empilhado é uma linha, mas equipamento é uma linha por peça, e
   * `luvas-arqueiro` sozinho pode passar de 100.
   *
   * @param {string[]} defIds Itens de interesse. Vazio devolve vazio: pedir
   *   sem filtro varreria o inventário inteiro por engano.
   * @param {object} [opts] `scopes` — por padrão mochila e depósito.
   */
  async inventoryCounts(defIds, opts = {}) {
    const ids = [...new Set((defIds || []).map(String).filter(Boolean))];
    // `all` é a varredura: a aba "Minha bolsa" pergunta "o que eu tenho",
    // sem lista prévia para filtrar. Medido: 301 itens em 4 pedidos, 107 ms.
    if (!ids.length && !opts.all) return { owned: {} };
    if (this.status !== 'connected') return { errorCode: 'inv.offline', owned: {} };

    // Mochila (1) e depósito (3). O enum viaja como número: medido, o nome
    // em string é recusado com `enum value expected`.
    const scopes = Array.isArray(opts.scopes) ? opts.scopes : [1, 3];
    const owned = {};

    for (const scope of scopes) {
      // Limite de segurança, não de completude: 100 por página com o filtro
      // estreito cobre inventários muito maiores que os reais, e sem o teto
      // uma resposta inesperada viraria laço infinito.
      for (let page = 1; page <= 12; page++) {
        const pedido = { scope, page, page_size: 100 };
        if (ids.length) pedido.filter = { def_ids: ids };
        const res = await this.request('inventory_page', pedido);
        if (res.caseName === 'error') {
          return { errorCode: (res.value && res.value.code) || 'inv.failed', owned };
        }
        const value = res.value || {};
        for (const item of value.items || []) {
          const defId = item && item.def_id;
          if (!defId) continue;
          const alvo = owned[defId] || (owned[defId] = {
            qty: 0, linhas: 0, bag: 0, warehouse: 0, equipped: 0, melhor: null
          });
          const qty = Number(item.qty) || 1;
          alvo.linhas++;
          // Equipado é contado à parte: entra no patrimônio mas não está
          // disponível para vender, e somá-lo no total mentiria sobre isso.
          const vestido = !!item.equipped_slot
            && item.equipped_slot !== 'EQUIP_SLOT_UNSPECIFIED';
          if (vestido) {
            alvo.equipped += qty;
          } else {
            alvo.qty += qty;
            if (scope === 3) alvo.warehouse += qty;
            else alvo.bag += qty;
          }
          // A melhor peça é a referência para comparar com o mercado: de
          // nada serve saber que tenho cinco se a que interessa é uma.
          const poder = Number(item.power) || 0;
          if (!alvo.melhor || poder > alvo.melhor.power) {
            alvo.melhor = {
              power: poder,
              level: Number(item.level) || 0,
              rarity: String(item.rarity || ''),
              enchant: Number(item.enchant) || 0,
              locked: !!item.locked,
              equipped: vestido
            };
          }
        }
        if (!value.has_next) break;
      }
    }

    return { owned };
  }

  /**
   * O inventário por **instância**, não agregado por item.
   *
   * `inventoryCounts` soma tudo num `def_id` e joga o `uid` fora, que é o
   * suficiente para responder "quanto eu tenho" mas inútil para anunciar:
   * `MarketCreate.item_uid` identifica uma peça específica, e duas espadas do
   * mesmo tipo com níveis diferentes valem preços diferentes.
   *
   * Equipado e trancado vêm junto, marcados. Escondê-los aqui faria a tela
   * dizer que o item não existe, quando a verdade é que ele existe e não pode
   * ser vendido agora — que é uma informação acionável: basta tirar do corpo.
   */
  async inventoryItems(opts = {}) {
    if (this.status !== 'connected') return { errorCode: 'inv.offline', items: [] };
    const scopes = Array.isArray(opts.scopes) ? opts.scopes : [1, 3];
    const items = [];

    for (const scope of scopes) {
      for (let page = 1; page <= 12; page++) {
        const res = await this.request('inventory_page', { scope, page, page_size: 100 });
        if (res.caseName === 'error') {
          return { errorCode: (res.value && res.value.code) || 'inv.failed', items };
        }
        const value = res.value || {};
        for (const item of value.items || []) {
          if (!item || !item.def_id) continue;
          items.push({
            // uint64 chega como string no decode; o pedido de anúncio precisa
            // de número, mas a conversão fica no momento do envio — aqui a
            // string atravessa o IPC sem perder precisão.
            uid: String(item.uid || ''),
            defId: String(item.def_id),
            rarity: String(item.rarity || ''),
            level: Number(item.level) || 0,
            enchant: Number(item.enchant) || 0,
            qty: Number(item.qty) || 1,
            power: Number(item.power) || 0,
            locked: !!item.locked,
            equippedSlot: String(item.equipped_slot || ''),
            // O que o NPC paga. É o piso absoluto: anunciar abaixo disso é
            // perder dinheiro para ter trabalho.
            sellPrice: Number(item.sell_price) || 0,
            scope
          });
        }
        if (!value.has_next) break;
      }
    }

    return { items };
  }

  /**
   * Cria um anúncio. A segunda escrita de mercado do launcher, depois do
   * `buy` do sniper.
   *
   * `item_uid` e `unit_price` são uint64 e o codec recusa string, mas o
   * inventário entrega o uid como string: a conversão acontece aqui, e passa
   * por `uint64()`.
   *
   * `Number(uid)` **não** serve: os uids do servidor passam de 2^53, e o
   * arredondamento do ponto flutuante caía num uid vizinho — o anúncio saía
   * com a peça errada, sem erro nenhum, porque o uid resultante existe. Era
   * esse o "anunciei um item e no jogo era outro".
   *
   * `kind` e `currency` vão como número pelo mesmo motivo das buscas —
   * `verify` responde `enum value expected` ao nome.
   */
  async marketCreate(draft = {}) {
    const uid = uint64(draft.uid);
    if (uid === null) return { errorCode: 'market.badUid' };
    const unit = Math.max(1, Math.floor(Number(draft.unitPrice) || 0));
    if (unit <= 0) return { errorCode: 'market.badPrice' };

    const value = {
      kind: MARKET_KIND_NUM.MARKET_KIND_ITEM,
      item_uid: uid,
      quantity: Math.max(1, Math.floor(Number(draft.quantity) || 1)),
      currency: draft.currency === 'diamond'
        ? MARKET_CURRENCY_NUM.MARKET_CURRENCY_DIAMOND
        : MARKET_CURRENCY_NUM.MARKET_CURRENCY_GOLD,
      unit_price: unit
    };
    const horas = Math.floor(Number(draft.hours) || 0);
    if (horas > 0) value.hours = horas;

    const res = await this.marketRequest('create', value);
    return res.errorCode ? { errorCode: res.errorCode } : (res.value || {});
  }

  /**
   * Destranca (ou tranca) uma peça.
   *
   * O cadeado é do jogo e o servidor recusa `MarketCreate` em item trancado.
   * Destrancar na hora de anunciar é o que o usuário pediu: ele já disse o que
   * quer vender na tela de confirmação, e obrigá-lo a voltar ao jogo para
   * tirar o cadeado de peça por peça era o passo manual que sobrava.
   *
   * `uid` é uint64 e o codec recusa string, igual ao resto do inventário —
   * e pelo mesmo motivo do anúncio, a conversão passa por `uint64()`: acima de
   * 2^53 um `Number` cru destranca a peça vizinha.
   */
  async lockItem(uid, locked) {
    const id = uint64(uid);
    if (id === null) return { errorCode: 'inv.badUid' };
    if (this.status !== 'connected') return { errorCode: 'inv.offline' };
    const res = await this.request('lock_item', { uid: id, locked: !!locked })
      .catch(e => ({ caseName: 'error', value: { code: e.message } }));
    if (res.caseName === 'error') {
      return { errorCode: (res.value && res.value.code) || 'inv.lockFailed' };
    }
    return { locked: !!(res.value && res.value.locked) };
  }

  /**
   * Move peças entre mochila e depósito.
   *
   * `inventory_page` lê os dois escopos, então a aba Anunciar mostra também o
   * que está guardado — mas `MarketCreate` só aceita o que está na mochila, e
   * o servidor recusa o resto com `inventory.item_not_in_bag`. Era essa a
   * recusa que aparecia num item que o usuário via na conta: ele existe, só
   * não estava na bolsa.
   *
   * Em lote porque `WarehouseMove` recebe a lista inteira, e porque a resposta
   * separa `moved` de `refused` — mochila cheia é recusa parcial, não erro.
   */
  async warehouseMove(uids, direction) {
    if (this.status !== 'connected') return { errorCode: 'inv.offline', moved: [], refused: [] };
    // `uint64()` e não `Number()`: acima de 2^53 o arredondamento move a peça
    // vizinha, que é o mesmo defeito que trocava o item do anúncio.
    const lista = (Array.isArray(uids) ? uids : [])
      .map(uint64)
      .filter(u => u !== null);
    if (!lista.length) return { moved: [], refused: [] };

    const res = await this.request('warehouse_move', {
      uids: lista,
      direction: direction === 'warehouse'
        ? WAREHOUSE_DIRECTION_NUM.TO_WAREHOUSE
        : WAREHOUSE_DIRECTION_NUM.TO_BAG
    }).catch(e => ({ caseName: 'error', value: { code: e.message } }));

    if (res.caseName === 'error') {
      return {
        errorCode: (res.value && res.value.code) || 'inv.moveFailed',
        moved: [], refused: lista.map(String)
      };
    }
    const v = res.value || {};
    return {
      moved: (v.moved || []).map(String),
      refused: (v.refused || []).map(String),
      bagUsed: Number(v.bag_used) || 0,
      bagCapacity: Number(v.bag_capacity) || 0
    };
  }

  /**
   * Detalhe de um anúncio, com `MarketPriceStats` junto — mais rico que o
   * `price_hint`: traz também quantos anúncios estão ativos e o menor preço
   * pedido agora. Custa ter um `listing_id` em mãos.
   *
   * `id` é uint64 e o codec exige número: o decode entrega string, então a
   * conversão tem de acontecer aqui, senão o encode recusa o pacote. Via
   * `uint64()`, pelo mesmo motivo da compra: acima de 2^53 um `Number` cru
   * perguntaria pelo anúncio vizinho.
   */
  async marketGet(listingId) {
    const id = uint64(listingId);
    if (id === null) return { errorCode: 'market.badId' };
    const res = await this.marketRequest('get', { id });
    return res.errorCode ? { errorCode: res.errorCode } : (res.value || {});
  }

  // ----------------------------------------------------------------- correio

  /**
   * Uma página do correio.
   *
   * Existe para o auto-anunciar: uma venda de mercado entrega o ouro por
   * correio, e um item que voltou de anúncio cancelado ou expirado também.
   * Enquanto nada recolhe a caixa, o ouro não entra e o item não aparece no
   * inventário — e a vaga de anúncio fica ocupada por nada.
   *
   * `kind` é texto livre do servidor, e é ele que separa a venda do resto.
   */
  async mailList(page = 1) {
    const res = await this.request('mail_request', {
      list: { page: Math.max(1, Math.floor(Number(page) || 1)), page_size: 50 }
    }).catch(e => ({ caseName: 'error', value: { code: e.message } }));
    if (res.caseName === 'error') {
      return { errorCode: (res.value && res.value.code) || 'mail.failed', entries: [] };
    }
    const v = (res.value && res.value.page) || {};
    return {
      entries: (v.entries || []).map(e => ({
        id: String(e.id || ''),
        kind: String(e.kind || ''),
        sender: String(e.sender || ''),
        subjectKey: String(e.subject_key || ''),
        gold: Number(e.gold) || 0,
        diamonds: Number(e.diamonds) || 0,
        items: (e.items || []).length,
        /** Já recolhido? O servidor mantém a entrada depois do resgate. */
        claimed: !!Number(e.claimed_at_ms),
        /**
         * Retida para análise. O servidor recusa o `claim` antes deste prazo,
         * então tentar só gastaria um pedido por rodada, por conta, para
         * sempre receber a mesma recusa.
         */
        heldUntil: Number(e.held_until_ms) || 0
      })),
      unclaimed: Number(v.unclaimed) || 0,
      total: Number(v.total) || 0
    };
  }

  /**
   * Recolhe entradas escolhidas do correio.
   *
   * **Nunca** `claim_all`. A caixa não tem só venda de mercado: tem recompensa
   * de evento, de boss, prêmio com prazo e item que o usuário pode estar
   * guardando de propósito. Um `claim_all` automático esvaziaria tudo isso de
   * uma vez, e com a bolsa cheia o resgate é **parcial** — `MailClaimResult`
   * tem `bag_full` e `partial` justamente porque o servidor recolhe o que cabe
   * e deixa o resto. O estrago seria invisível e não teria volta.
   *
   * Então o auto-anunciar manda ids, e só os de venda que ele mesmo
   * identificou. `bag_full` volta para quem chamou decidir: parar de anunciar
   * é melhor que insistir numa bolsa que não aceita mais nada.
   */
  async mailClaim(ids) {
    const lista = (Array.isArray(ids) ? ids : [ids])
      .map(uint64)
      .filter(u => u !== null);
    if (!lista.length) return { claimed: [], gold: 0, items: 0, bagFull: false };
    if (this.status !== 'connected') return { errorCode: 'mail.offline', claimed: [] };

    const recolhidos = [];
    let gold = 0;
    let items = 0;
    let bagFull = false;
    let unclaimed = 0;
    // Um `claim` por entrada: `MailClaim` recebe um id só. Em série, porque a
    // bolsa é compartilhada entre os resgates — o segundo pedido precisa ver o
    // espaço que o primeiro ocupou, senão `bag_full` chega tarde.
    for (const id of lista) {
      const res = await this.request('mail_request', { claim: { id } })
        .catch(e => ({ caseName: 'error', value: { code: e.message } }));
      if (res.caseName === 'error') continue;
      const v = (res.value && res.value.claimed) || {};
      for (const c of v.claimed || []) recolhidos.push(String(c));
      gold += Number(v.gold) || 0;
      items += Number(v.items) || 0;
      unclaimed = Number(v.unclaimed) || 0;
      if (v.bag_full) {
        // Bolsa cheia: o resgate foi parcial e o seguinte seria pior. Parar
        // aqui deixa o resto no correio, que é onde ele está seguro.
        bagFull = true;
        break;
      }
    }
    return { claimed: recolhidos, gold, items, bagFull, unclaimed };
  }

  /** A caçada lida na entrada, ou `null` se a conta não estava caçando. */
  getHuntTicket() {
    return this.huntTicket ? { ...this.huntTicket } : null;
  }

  /**
   * Troca a caçada da conta, a pedido do usuário. É a única escolha de caçada
   * que o monitor faz, e nunca por conta própria.
   *
   * Medido: `start_hunt` numa conta já caçando troca de mapa direto, sem
   * `leave_hunt` antes — o servidor tira a conta da cena anterior sozinho. Por
   * isso o `leave_hunt` continua fora da lista: ele mandaria a conta para a
   * cidade no meio da troca, sem ganhar nada.
   *
   * O bilhete novo substitui o antigo **só depois** de o servidor aceitar: se a
   * troca falhar, o refill seguinte tem de devolver a conta ao mapa em que ela
   * de fato está, e não ao que o usuário tentou escolher.
   */
  async setHunt(ticket) {
    const alvo = hunts.normalizeTicket(ticket);
    if (!alvo) return { ok: false, error: 'hunt.noGate' };
    if (this.status !== 'connected') return { ok: false, error: 'hunt.offline' };
    // Trocar de mapa no meio da ida à loja faria o `finally` do refill devolver
    // a conta ao mapa antigo logo depois, desfazendo a troca sem explicação.
    if (this.refillBusy) return { ok: false, error: 'hunt.refillBusy' };
    // Mesmo motivo durante a rodada de boss: ela guardou o bilhete antigo e o
    // vai restaurar no fim, desfazendo a troca sem explicação. O bilhete novo é
    // aceito logo depois, quando a rodada termina.
    if (this.bossBusy) return { ok: false, error: 'hunt.bossBusy' };
    // E durante um hop de câmbio: a conta está na cidade de propósito, com uma
    // troca aberta. Um `start_hunt` aqui a tiraria da cena no meio da troca,
    // que é exatamente o que o hop vigia para abortar.
    if (this.cambioBusy) return { ok: false, error: 'hunt.cambioBusy' };

    const resultado = await this.startHunt(alvo).catch(err => ({ errorCode: err.message }));
    if (resultado && resultado.errorCode) {
      return { ok: false, error: resultado.errorCode };
    }

    this.huntTicket = alvo;
    return {
      ok: true,
      gateId: alvo.gate_id,
      tierMin: alvo.tier_min,
      difficulty: alvo.difficulty,
      sceneId: (resultado && resultado.scene_id) || ''
    };
  }

  // ------------------------------------------------------------------ câmbio

  /**
   * Lista de amigos da conta.
   *
   * Existe para o câmbio: medido, `trade_request{invite}` entre contas que não
   * são amigas responde `error{code:"trade.friends_only"}`. A amizade é a única
   * pré-condição de troca que o servidor cobra explicitamente.
   */
  async friendList() {
    const res = await this.request('social_request', { friend_list: {} })
      .catch(e => ({ caseName: 'error', value: { code: e.message } }));
    if (res.caseName === 'error') {
      return { errorCode: (res.value && res.value.code) || 'social.failed', friends: [] };
    }
    const v = (res.value && res.value.friend_list) || {};
    return {
      friends: v.friends || [],
      incoming: v.incoming || [],
      outgoing: v.outgoing || [],
      blocked: v.blocked || []
    };
  }

  /**
   * Pede, aceita ou remove amizade.
   *
   * `kind` vai como **número**. Medido: o `verify` do codec responde
   * `social_request.friend_action.kind: enum value expected` ao nome
   * (`KIND_REQUEST`), porque o enum é aninhado em `FriendAction` e o nome só
   * resolve no escopo do pai — o mesmo motivo de `MARKET_KIND_NUM` existir.
   *
   * Nada além de `REQUEST` e `ACCEPT` sai daqui: `BLOCK` e `REMOVE` mexeriam na
   * lista social do usuário, que não é assunto do câmbio.
   */
  async friendAction(kind, accountId, name = '') {
    const num = Number(kind);
    if (num !== FRIEND_KIND.REQUEST && num !== FRIEND_KIND.ACCEPT) {
      return { errorCode: 'social.kindNotAllowed' };
    }
    const alvo = uint64(accountId);
    if (alvo === null) return { errorCode: 'social.noTarget' };

    const res = await this.request('social_request', {
      friend_action: { kind: num, target: { account: alvo, name: String(name || '') } }
    }).catch(e => ({ caseName: 'error', value: { code: e.message } }));
    if (res.caseName === 'error') {
      return { errorCode: (res.value && res.value.code) || 'social.failed' };
    }
    const v = (res.value && res.value.friend_action) || {};
    return {
      kind: v.kind || '',
      entry: v.entry || null,
      becameFriends: !!v.became_friends
    };
  }

  /**
   * Canais da cena corrente.
   *
   * Medido: `ChannelListResult` traz `players`/`capacity` por canal e
   * `ChannelInfo.friends`, a contagem de amigos em cada um — que é como o
   * câmbio acha a conta vizinha sem adivinhar. No estado normal não vem
   * `cooldown_until_ms` nem `blocked`, então trocar de canal é livre.
   */
  async channelList() {
    const res = await this.request('channel_list', {})
      .catch(e => ({ caseName: 'error', value: { code: e.message } }));
    if (res.caseName === 'error') {
      return { errorCode: (res.value && res.value.code) || 'channel.failed', channels: [] };
    }
    const v = res.value || {};
    return {
      sceneId: v.scene_id || '',
      current: Number(v.current) || 0,
      cooldownUntil: Number(v.cooldown_until_ms) || 0,
      blocked: v.blocked || '',
      channels: (v.channels || []).map(c => ({
        number: Number(c.number) || 0,
        players: Number(c.players) || 0,
        capacity: Number(c.capacity) || 0,
        load: c.load || '',
        current: !!c.current,
        recommended: !!c.recommended,
        friends: Number(c.friends) || 0,
        full: (Number(c.players) || 0) >= (Number(c.capacity) || 0) && !!c.capacity
      }))
    };
  }

  /**
   * Muda de canal na cena corrente, e espera o `scene_enter` que confirma.
   *
   * O alvo é sempre o canal da **outra** conta, nunca o `recommended`: medido,
   * o canal 1 estava com 146/150, e seguir a recomendação do servidor separaria
   * as duas contas em vez de juntá-las.
   */
  async switchChannel(channel) {
    const alvo = Number(channel) || 0;
    if (alvo <= 0) return { errorCode: 'channel.noTarget' };
    if (alvo === this.state.scene.channel) return { channel: alvo, already: true };

    const res = await this.request('switch_channel', { channel: alvo })
      .catch(e => ({ caseName: 'error', value: { code: e.message } }));
    if (res.caseName === 'error') {
      return { errorCode: (res.value && res.value.code) || 'channel.switchFailed' };
    }
    // A troca de canal recarrega a cena; sem esperar, a leitura de posição
    // seguinte usaria a entidade antiga e nunca acharia o personagem.
    await this.waitFor('scene_enter', 15000);
    return {
      channel: Number((res.value || {}).channel) || alvo,
      cooldownUntil: Number((res.value || {}).cooldown_until_ms) || 0
    };
  }

  /**
   * Uma operação de troca. Tudo viaja dentro de `trade_request`, e a resposta é
   * sempre `trade_response` ou `error`.
   *
   * `set_offer` nunca leva `items` nem `shadows` daqui: o câmbio transfere
   * **só ouro**, e ofertar uma peça por engano não tem desfazer. `candidates`
   * fica fora da lista pelo mesmo motivo — é a listagem de itens ofertáveis, e
   * nada aqui tem motivo para olhar para ela.
   */
  async tradeRequest(op, value) {
    if (!TRADE_OPS.has(op)) return { errorCode: 'trade.opNotAllowed' };
    const res = await this.request('trade_request', { [op]: value })
      .catch(e => ({ caseName: 'error', value: { code: e.message } }));
    if (res.caseName === 'error') {
      return { errorCode: (res.value && res.value.code) || 'trade.failed' };
    }
    return res.value || {};
  }

  /** Oferta de ouro puro. Fechado de propósito: não aceita item nem sombra. */
  tradeOfferGold(gold) {
    const valor = uint64(gold);
    if (valor === null) return Promise.resolve({ errorCode: 'trade.noGold' });
    return this.tradeRequest('set_offer', { gold: valor });
  }

  /**
   * Cancela a troca aberta, se houver. Erro aqui é esperado e ignorado: medido,
   * `cancel` depois de a troca ter fechado responde `error` porque a sessão já
   * é `idle` — tratar isso como falha marcaria um hop bem-sucedido como quebrado.
   */
  async tradeCancelQuiet() {
    if (!this.isOpen()) return;
    await this.tradeRequest('cancel', {}).catch(() => null);
  }

  // ------------------------------------------------------------------- saída

  setStatus(status) {
    this.status = status;
    this.emit('status', {
      index: this.index,
      status,
      error: status === 'error' ? this.lastError : undefined
    });
  }

  fail(message) {
    this.lastError = message;
    this.setStatus('error');
  }

  emitUpdate() {
    this.emit('update', { index: this.index, state: this.getState() });
  }

  /**
   * Cópia defensiva: o estado é mutado in loco e segue para outro processo.
   * `structuredClone` é nativo e evita serializar para texto só para desfazer.
   */
  getState() {
    return typeof structuredClone === 'function'
      ? structuredClone(this.state)
      : JSON.parse(JSON.stringify(this.state));
  }

  getStatus() {
    return {
      active: true,
      status: this.status,
      error: this.lastError || undefined,
      ended: this.endedReason || undefined,
      state: this.getState()
    };
  }

  // -------------------------------------------------------------- reconexão

  scheduleReconnect() {
    if (!this.autoReconnect || this.endedReason) return;
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    // O teto normal não se aplica à espera de ratelimit, que é deliberadamente longa.
    this.reconnectDelay = delay >= RATELIMIT_RETRY_MS
      ? delay
      : Math.min(RECONNECT_MAX_MS, Math.round(delay * 1.8));
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  teardown() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
    // Sem socket não há painel para ler; `authenticate` religa o relógio.
    clearInterval(this.expeditionTimer);
    this.expeditionTimer = null;
    // Mesma razão: sem socket não há estado de boss para ler, e `authenticate`
    // religa os dois relógios.
    clearInterval(this.bossTimer);
    this.bossTimer = null;
    this.clearBossReset();
    for (const entry of this.pending.values()) entry.reject(new Error('conexão perdida'));
    this.pending.clear();
    // Um ciclo de compra em curso ficaria preso esperando pacotes que não vêm
    // mais; soltar as esperas o faz terminar e liberar o `refillBusy`.
    this.clearWaiters();
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    this.teardown();
    if (ws) {
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        if (ws.readyState === 0 || ws.readyState === 1) ws.close(1000);
      } catch {}
    }
  }

  disconnect() {
    this.autoReconnect = false;
    this.clearReconnect();
    this.close();
    this.setStatus('disconnected');
  }
}

class LevelingHeadlessManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.clients = new Map();
    this.clientOptions = options;
    /** Auto-refill: uma configuração para todas as contas, não por conta. */
    this.refillConfig = refill.normalizeConfig(options.refillConfig);
    /**
     * Auto-expedição: uma configuração para o launcher inteiro, com a lista de
     * contas excluídas dentro dela. O laço vive nos clientes, ao contrário do
     * sniper, porque o painel é da conta — sombras, vagas e VIP não são
     * compartilhados, então não há leitura para economizar aqui.
     */
    this.expeditionConfig = expedition.normalizeConfig(options.expeditionConfig);
    /**
     * Auto-boss diário: uma configuração para o launcher inteiro, com a lista
     * de contas excluídas dentro dela, igual à expedição.
     *
     * O laço vive nos clientes pela mesma razão: o estado é da conta — o que já
     * foi feito hoje, o nível exigido, o recorde — e nenhuma leitura é
     * compartilhável. Um relógio no manager teria de percorrer as contas de
     * qualquer forma, e a rodada de cada uma é uma sequência longa que não pode
     * bloquear as outras.
     */
    this.bossConfig = boss.normalizeConfig(options.bossConfig);
    /** Montagem de grupo em curso; uma por vez em todo o launcher. */
    this.partyBusy = false;
    /**
     * Catálogo de caçadas, uma cópia para o launcher todo: é conteúdo do jogo,
     * igual para todas as contas. Guardar por conta multiplicaria a leitura de
     * 1 MB por nada.
     *
     * `fresh` distingue a lista lida do servidor nesta execução da cópia que o
     * launcher tinha salva de execuções anteriores: a salva serve para o
     * seletor abrir cheio antes de qualquer login, mas não dispensa a leitura,
     * porque o jogo pode ter ganhado portal novo desde então.
     */
    this.huntStore = { value: options.huntCatalog || null, fresh: false };

    /**
     * Ícones, cores de raridade e sprites, para a tela de preços. Mesma
     * origem e mesma regra do catálogo de caçadas: uma leitura do
     * `content_catalog` por execução, compartilhada entre as contas.
     */
    this.marketCatalogStore = { value: options.marketCatalog || null, fresh: false };

    /**
     * Coletor do mercado. Uma leitura para o launcher inteiro, não por conta:
     * `market_request{history}` devolve o feed global, idêntico em qualquer
     * sessão, então N contas lendo o mesmo feed seriam N vezes o mesmo dado.
     *
     * O intervalo é folgado de propósito. Medido: o feed tem 100 linhas e
     * cobre ~30 min, ou seja ~3,4 vendas por minuto. Ler de minuto em minuto
     * reamostra a mesma janela trinta vezes; a sobreposição é o que garante
     * que nada se perca se uma leitura falhar, e o banco descarta a repetição
     * pela chave primária.
     */
    this.marketTimer = null;
    this.marketSink = typeof options.marketSink === 'function' ? options.marketSink : null;
    this.marketIntervalMs = Number(options.marketIntervalMs) || MARKET_POLL_MS;
    this.marketBusy = false;
    this.marketStats = { polls: 0, inserted: 0, lastAtMs: 0, lastError: '', lastCount: 0 };
    /**
     * Banco, para o enriquecedor de nível. Ele precisa da fila de vendas sem
     * nível, que só o banco conhece — `marketSink` é de mão única.
     */
    this.marketDb = null;
    this.levelBusy = false;
    this.levelStats = { consultas: 0, achados: 0, falhas: 0, lastAtMs: 0, lastError: '' };

    /**
     * Sniper de mercado: compra o que entrar abaixo do teto configurado.
     *
     * O laço vive no manager, não nos clientes, porque a busca é global — o
     * mercado é o mesmo para qualquer sessão — e só a compra pertence à conta
     * da regra. Uma configuração por cliente faria N buscas do mesmo item.
     *
     * O intervalo é curto, ao contrário do coletor: aqui o atraso é a
     * diferença entre comprar e ver que alguém comprou.
     */
    this.sniperConfig = sniper.normalizeConfig(options.sniperConfig);
    this.sniperIntervalMs = this.sniperConfig.intervalMs;
    this.sniperTimer = null;
    this.sniperBusy = false;
    /**
     * Grava a configuração depois de uma compra. O contador de comprados fica
     * junto da regra em disco: só em memória, reabrir o launcher zeraria o
     * alvo e a compra aconteceria de novo.
     */
    this.sniperSink = typeof options.sniperSink === 'function' ? options.sniperSink : null;
    /**
     * Grava o log depois de cada linha. Mesma forma do `sniperSink`, e pelo
     * mesmo motivo de quem está do outro lado: o processo principal é que sabe
     * onde é `userData`, e o serviço não toca em disco.
     *
     * Sem isto o log era de sessão, e a pergunta que ele responde — "o item
     * entrou dentro do teto e quem levou?" — é justamente a que se faz depois
     * de deixar o launcher rodando a noite toda.
     */
    this.sniperLogSink = typeof options.sniperLogSink === 'function' ? options.sniperLogSink : null;
    /** Anúncios já logados e ainda abertos, por `listing_id`. */
    this.sniperSeen = new Map();
    this.sniperLog = [];
    this.sniperStats = {
      polls: 0, buys: 0, spentGold: 0, spentDiamond: 0, lastAtMs: 0, lastError: ''
    };

    /**
     * Auto-anunciar: preenche as vagas de anúncio de cada conta com o que ela
     * tem de tesouro na bolsa.
     *
     * O laço vive no manager e percorre as contas, como o sniper e ao contrário
     * do boss. A razão é a leitura de preço: a mediana e o anúncio rival de um
     * item são os mesmos para qualquer conta, e um laço por cliente faria oito
     * contas consultarem o mesmo `citrino@2+0` na mesma rodada. O que pertence
     * à conta é só a bolsa e o `create`, e esses acontecem no socket dela.
     *
     * Escrita, portanto com teto. `maxPerRound` limita o estrago de um erro de
     * preço a dois itens visíveis no relatório, em vez do inventário inteiro.
     */
    this.autosellConfig = autosell.normalizeConfig(options.autosellConfig);
    this.autosellIntervalMs = this.autosellConfig.intervalMs;
    this.autosellTimer = null;
    this.autosellBusy = false;
    /** Grava a configuração; mesma forma do `sniperSink`. */
    this.autosellSink = typeof options.autosellSink === 'function' ? options.autosellSink : null;
    /** Grava o relatório em disco: a pergunta "o que ele vendeu de noite?". */
    this.autosellLogSink = typeof options.autosellLogSink === 'function' ? options.autosellLogSink : null;
    this.autosellLog = [];
    /**
     * Preço por `defId@level+enchant` dentro de **uma** rodada.
     *
     * Não sobrevive à rodada de propósito: o anúncio rival é o dado que mais
     * envelhece aqui, e um preço de dez minutos atrás é exatamente o que faria
     * o launcher anunciar abaixo de um mercado que já subiu.
     */
    this.autosellPrices = new Map();
    this.autosellStats = {
      rounds: 0, listed: 0, claimed: 0, goldClaimed: 0,
      lastAtMs: 0, lastError: '', lastCount: 0
    };

    /**
     * Câmbio: desce o ouro pela cadeia até a conta que concentra tudo.
     *
     * O laço vive no manager, e aqui não é escolha de desempenho como no sniper
     * — é necessidade. Um hop envolve **duas** contas ao mesmo tempo, e nenhum
     * cliente sozinho pode conduzi-lo. Mesma razão de `assembleParty` morar
     * aqui.
     *
     * Um hop por vez no launcher inteiro, e o seguinte só depois de o anterior
     * ter fechado e o saldo ter sido conferido nos dois lados. É o que o pedido
     * descreve, e é também o que evita duas trocas abertas lendo os
     * `trade_push` uma da outra.
     */
    this.cambioConfig = cambio.normalizeConfig(options.cambioConfig);
    this.cambioTimer = null;
    this.cambioBusy = false;
    /** Grava a configuração e o ponteiro da cadeia; mesma forma do `sniperSink`. */
    this.cambioSink = typeof options.cambioSink === 'function' ? options.cambioSink : null;
    /** Grava o relatório: a pergunta "quanto desceu, e de onde?". */
    this.cambioLogSink = typeof options.cambioLogSink === 'function' ? options.cambioLogSink : null;
    this.cambioLog = [];
    /**
     * Quando o último hop **fechou**, não quando começou: o intervalo tem de
     * separar trocas confirmadas, e contar do início o encurtaria pelo tempo da
     * própria troca.
     */
    this.cambioLastAtMs = Number(options.cambioLastAtMs) || 0;
    /** Intervalo sorteado para a espera corrente, com jitter já aplicado. */
    this.cambioWaitMs = 0;
    this.cambioStats = {
      hops: 0, goldMoved: 0, lastAtMs: 0, lastError: '', lastHop: '', etapa: ''
    };
    this.random = typeof options.random === 'function' ? options.random : Math.random;
  }

  // ------------------------------------------------------------- mercado

  /**
   * Qualquer conta conectada serve para ler o mercado, mas a escolha não pode
   * ser aleatória a cada tique: trocar de conta sem motivo espalharia o
   * tráfego por todas as sessões. A primeira conectada, em ordem de índice,
   * é estável enquanto ela existir.
   */
  marketClient() {
    const dedicated = this.clients.get(-1);
    if (dedicated && dedicated.status === 'connected') return dedicated;
    for (const index of [...this.clients.keys()].sort((a, b) => a - b)) {
      if (index === -1) continue;
      const client = this.clients.get(index);
      if (client && client.status === 'connected') return client;
    }
    return null;
  }

  /**
   * Uma leitura do feed. Devolve quantas vendas eram inéditas.
   *
   * Nunca lança: o coletor roda em segundo plano para sempre, e uma falha de
   * rede não pode derrubar o temporizador nem poluir o log. O erro fica
   * registrado em `marketStats` para a interface mostrar.
   */
  async pollMarket() {
    if (this.marketBusy) return 0;
    const client = this.marketClient();
    if (!client) {
      this.marketStats.lastError = 'market.noneActive';
      return 0;
    }
    this.marketBusy = true;
    try {
      const res = await client.marketHistory();
      this.marketStats.polls++;
      this.marketStats.lastAtMs = Date.now();
      if (res.errorCode) {
        this.marketStats.lastError = res.errorCode;
        return 0;
      }
      this.marketStats.lastError = '';
      this.marketStats.lastCount = res.sales.length;
      const novas = this.marketSink ? (this.marketSink(res.sales) || 0) : 0;
      this.marketStats.inserted += novas;
      if (novas) this.emit('market', { inserted: novas, total: res.sales.length });
      return novas;
    } catch (err) {
      this.marketStats.lastError = err && err.message || String(err);
      return 0;
    } finally {
      this.marketBusy = false;
      // Depois de gravar, nunca antes: o nível é perguntado anúncio por
      // anúncio e a coleta das vendas não pode esperar por isso. Sem `await`
      // porque o tique do coletor não depende do resultado — e `enrichLevels`
      // nunca lança.
      this.enrichLevels();
    }
  }

  /**
   * Liga o coletor. `unref` no temporizador: o mercado nunca deve ser o
   * motivo de o processo continuar vivo.
   */
  startMarketPoll() {
    if (this.marketTimer || !this.marketSink) return false;
    this.marketTimer = setInterval(() => { this.pollMarket(); }, this.marketIntervalMs);
    if (this.marketTimer.unref) this.marketTimer.unref();
    // Uma leitura imediata: esperar o primeiro minuto perderia vendas à toa
    // quando o usuário acabou de ligar o monitor.
    this.pollMarket();
    return true;
  }

  stopMarketPoll() {
    if (!this.marketTimer) return false;
    clearInterval(this.marketTimer);
    this.marketTimer = null;
    return true;
  }

  getMarketStats() {
    return {
      ...this.marketStats,
      running: !!this.marketTimer,
      levels: { ...this.levelStats }
    };
  }

  /**
   * Descobre o nível dos itens vendidos.
   *
   * `MarketSale` não traz nível, e por isso o histórico mostrava "Topázio"
   * sem dizer qual — quando existem Topázios de nível 1 a 4 vendidos por
   * preços que variam de 1 a 10 milhões. A média de todos juntos não
   * descreve nenhum deles.
   *
   * Quem tem o nível é `MarketListing`. O achado que torna isto possível:
   * medido, `market_request{get}` num anúncio **já vendido** continua
   * respondendo, com `status: MARKET_STATUS_SOLD` e o `level` intacto. O
   * `listing_id` que o feed traz é a chave, e custa ~35 ms por pergunta.
   *
   * Um pedido por anúncio, em série e com teto por rodada. O teto é o que
   * decide quanto tempo o histórico antigo leva para ser identificado: o
   * feed traz ~3,4 vendas novas por minuto, então qualquer lote acima disso
   * já ganha da chegada — o resto do orçamento serve para recuperar o
   * atraso, que num banco com meses de uso são milhares de vendas.
   *
   * 40 por minuto, medido: ~45 ms por pergunta, logo ~1,8 s de tráfego em
   * cada 60 s. Em série de propósito. Disparar o lote em paralelo seria
   * rápido e também seria uma rajada de dezenas de pedidos simultâneos por
   * dados que ninguém está olhando — o tipo de tráfego que faz um servidor
   * começar a recusar.
   */
  async enrichLevels(limite = 40, listingIds = null) {
    if (!this.marketDb || this.levelBusy) return 0;
    const client = this.marketClient();
    if (!client) return 0;

    this.levelBusy = true;
    let gravadas = 0;
    try {
      const fila = this.marketDb.pendingLevels(limite, listingIds);
      if (!fila.length) return 0;

      const linhas = [];
      for (const pendente of fila) {
        const res = await client.marketGet(Number(pendente.listing_id));
        if (res.errorCode) {
          // O anúncio expirou do servidor, ou nunca existiu. Marcar com
          // nível 0 encerra a pergunta: insistir todo tique num id que já
          // não existe gastaria tráfego para sempre, sem resposta possível.
          linhas.push({ listing_id: pendente.listing_id, level: 0 });
          this.levelStats.falhas++;
          continue;
        }
        const l = (res && res.listing) || {};
        linhas.push({
          listing_id: pendente.listing_id,
          level: Number(l.level) || 0,
          slot: typeof l.slot === 'string' ? l.slot : ''
        });
        if (Number(l.level) > 0) this.levelStats.achados++;
      }

      gravadas = this.marketDb.setLevels(linhas);
      this.levelStats.consultas += fila.length;
      this.levelStats.lastAtMs = Date.now();
    } catch (e) {
      this.levelStats.lastError = (e && e.message) || String(e);
    } finally {
      this.levelBusy = false;
    }
    return gravadas;
  }

  // --------------------------------------------------------------- sniper

  /**
   * Regras do sniper nos monitores. Diferente do refill, a configuração não
   * vai para os clientes: o laço vive aqui, porque a busca é global (qualquer
   * conta vê o mesmo mercado) e só a compra é da conta da regra. Mandar a
   * configuração para oito clientes faria oito buscas do mesmo item.
   */
  setSniperConfig(config) {
    // O contador de comprados é **sempre** o de cá, nunca o que vem na
    // configuração recebida.
    //
    // Era o bug de um alvo de 1 comprar duas vezes. A tela do sniper carrega
    // a configuração ao abrir e guarda a cópia; quando uma compra acontece,
    // quem incrementa é o laço aqui, e a cópia da tela fica velha. Qualquer
    // gravação feita depois — mexer no intervalo, ligar e desligar, editar
    // outra regra — mandava de volta aquela cópia com `bought: 0`, o alvo
    // voltava a ter vaga e a regra comprava de novo.
    //
    // Deixar o maior dos dois resolve nas duas direções: a tela nunca
    // consegue abaixar o contador, e zerá-lo de propósito continua
    // funcionando porque esse caminho remove a regra e a recria.
    const anteriores = new Map(
      (this.sniperConfig && this.sniperConfig.rules || []).map(r => [r.id, r])
    );
    this.sniperConfig = sniper.normalizeConfig(config);
    const zerar = new Set();
    for (const bruta of Array.isArray(config && config.rules) ? config.rules : []) {
      if (!bruta || !bruta.resetBought) continue;
      const norm = sniper.normalizeRule(bruta);
      if (norm) zerar.add(norm.id);
    }
    for (const rule of this.sniperConfig.rules) {
      const antiga = anteriores.get(rule.id);
      if (!antiga) continue;
      // `resetBought` é o botão "zerar contagem", a única forma de a tela
      // baixar o contador. Sem ele o maior dos dois vence, e a contagem só
      // pode subir.
      if (zerar.has(rule.id)) { rule.bought = 0; continue; }
      rule.bought = Math.max(Number(rule.bought) || 0, Number(antiga.bought) || 0);
    }
    this.sniperIntervalMs = this.sniperConfig.intervalMs;
    // Intervalo novo só vale no tique seguinte se o temporizador não for
    // recriado; o usuário acabou de mexer no campo e espera o efeito agora.
    if (this.sniperTimer) {
      this.stopSniperPoll();
      this.startSniperPoll();
    }
    return this.sniperConfig;
  }

  getSniperConfig() {
    return this.sniperConfig;
  }

  /** Cliente que paga por esta regra. Conta fixa: o ouro é de quem o usuário escolheu. */
  sniperClient(rule) {
    const client = this.clients.get(Number(rule && rule.account) || 0);
    return client && client.status === 'connected' ? client : null;
  }

  /**
   * Uma linha do log, por anúncio.
   *
   * Entrada por `listing_id`, atualizada no lugar, não um evento por
   * acontecimento: a pergunta do log é "o que apareceu, por quanto, e quem
   * levou" — e com dois eventos separados o horário do anúncio ficaria numa
   * linha e o da compra em outra, que é justamente a comparação que interessa.
   */
  sniperLogEntry(patch) {
    const id = String(patch.id);
    const i = this.sniperLog.findIndex(e => e.id === id);
    const base = i >= 0 ? this.sniperLog[i] : { id, seenAtMs: Date.now() };
    const entry = { ...base, ...patch, id };
    if (i >= 0) this.sniperLog.splice(i, 1);
    this.sniperLog.unshift(entry);
    // Teto: o mercado nunca para de anunciar, e o log agora é de disco.
    if (this.sniperLog.length > SNIPER_LOG_MAX) this.sniperLog.length = SNIPER_LOG_MAX;
    this.saveSniperLog();
    this.emit('sniper', { entry, stats: this.getSniperStats() });
    return entry;
  }

  getSniperLog() {
    return this.sniperLog.slice();
  }

  /**
   * Repõe o log gravado, na abertura do launcher.
   *
   * Linha que ficou em `announced` vira `unknown`: `sniperSeen` é de sessão, e
   * ninguém mais vai resolver aquele anúncio. Deixá-la em "anunciado" faria a
   * tela prometer uma resposta que não vem; chamá-la de `gone` afirmaria que
   * saiu do mercado, o que o launcher não viu acontecer.
   */
  setSniperLog(entries) {
    if (!Array.isArray(entries)) return false;
    this.sniperLog = entries
      .filter(e => e && e.id !== undefined && e.id !== null)
      .slice(0, SNIPER_LOG_MAX)
      .map(e => ({
        ...e,
        id: String(e.id),
        status: e.status === 'announced' ? 'unknown' : e.status
      }));
    return true;
  }

  clearSniperLog() {
    this.sniperLog = [];
    this.saveSniperLog();
    return true;
  }

  /** Entrega o log a quem sabe escrever em disco, se houver alguém. */
  saveSniperLog() {
    if (!this.sniperLogSink) return;
    try { this.sniperLogSink(this.sniperLog); } catch {}
  }

  getSniperStats() {
    return {
      ...this.sniperStats,
      running: !!this.sniperTimer,
      intervalMs: this.sniperIntervalMs,
      rules: this.sniperConfig.rules.length,
      watching: this.sniperSeen.size
    };
  }

  /**
   * Uma rodada: busca o que cada regra pede, compra o que couber no teto.
   *
   * Nunca lança, pelo mesmo motivo do coletor: roda para sempre em segundo
   * plano e uma falha de rede não pode derrubar o temporizador.
   *
   * As regras são percorridas em série. Em paralelo seriam N buscas
   * simultâneas a cada poucos segundos — e o intervalo aqui é de segundos, não
   * do minuto folgado do coletor, então a rajada se repetiria o tempo todo.
   */
  async pollSniper() {
    if (this.sniperBusy) return 0;
    const cfg = this.sniperConfig;
    if (!cfg.enabled) return 0;

    this.sniperBusy = true;
    let compradas = 0;
    /** Anúncios vistos nesta rodada, para saber quais desapareceram. */
    const vistos = new Set();
    try {
      this.sniperStats.polls++;
      this.sniperStats.lastAtMs = Date.now();
      this.sniperStats.lastError = '';

      for (const rule of cfg.rules) {
        if (!rule.enabled || sniper.remainingOf(rule) <= 0) continue;

        const buyerAccount = cfg.buyerAccount;
        const client = this.sniperClient({ account: buyerAccount });
        if (!client) {
          this.sniperStats.lastError = 'sniper.accountOffline';
          continue;
        }

        const encontrados = [];
        for (const filtros of sniper.searchesFor(rule)) {
          const res = await client.marketSearch(filtros);
          if (res.errorCode) {
            this.sniperStats.lastError = res.errorCode;
            continue;
          }
          for (const listing of res.listings || []) encontrados.push(listing);
        }
        for (const listing of encontrados) vistos.add(String(listing.id));

        const { buys } = sniper.plan(encontrados, rule);

        // O anúncio entra no log antes da compra: se o item for levado por
        // outra pessoa no meio, a linha já existe para receber a notícia.
        for (const buy of buys) this.sniperAnnounce(buy, rule, client, buyerAccount);

        for (const buy of buys) {
          if (sniper.remainingOf(rule) <= 0) break;
          // A regra vai **por referência**: é nela que `sniperBuy` soma o
          // `bought`, e é ela que a gravação salva. Uma cópia por espalhamento
          // (para carimbar a conta compradora) somava num objeto descartado: o
          // alvo nunca enchia e a compra se repetia.
          compradas += await this.sniperBuy(buy, rule, client, buyerAccount);
        }
      }

      await this.sniperResolve(vistos);
      return compradas;
    } catch (e) {
      this.sniperStats.lastError = (e && e.message) || String(e);
      return compradas;
    } finally {
      this.sniperBusy = false;
    }
  }

  /** Registra o anúncio visto, com a hora em que o vendedor o criou. */
  sniperAnnounce(buy, rule, client, buyerAccount = 0) {
    const id = String(buy.id);
    const l = buy.listing || {};
    if (this.sniperSeen.has(id)) return;
    this.sniperSeen.set(id, { rule: rule.id, account: buyerAccount, atMs: Date.now() });
    this.sniperLogEntry({
      id,
      status: 'announced',
      rule: rule.id,
      defId: String(l.def_id || ''),
      name: String(l.name || ''),
      rarity: String(l.rarity || ''),
      kind: String(l.kind || ''),
      level: Number(l.level) || 0,
      currency: buy.currency,
      unitPrice: buy.unitPrice,
      quantity: buy.quantity,
      total: buy.total,
      seller: String(l.seller_name || ''),
      // Hora do anúncio é a do vendedor, não a da nossa busca: o atraso entre
      // as duas é o que diz se o intervalo de verificação está largo demais.
      announcedAtMs: Number(l.created_at_ms) || 0,
      account: buyerAccount,
      accountName: (client && client.state && client.state.name) || ''
    });
  }

  /**
   * Tenta a compra. Devolve quantas unidades entraram.
   *
   * Perder a corrida é o caso normal, não exceção: entre a busca e a compra o
   * anúncio pode ter sido levado. O log diz isso com o código do servidor, em
   * vez de tratar como erro do launcher.
   */
  async sniperBuy(buy, rule, client, buyerAccount = 0) {
    const res = await client.marketBuy(buy.id, buy.quantity).catch(err => ({
      errorCode: (err && err.message) || 'market.buyFailed'
    }));

    if (res.errorCode) {
      const perdido = SNIPER_LOST_CODES.has(res.errorCode);
      this.sniperLogEntry({
        id: String(buy.id),
        status: perdido ? 'lost' : 'failed',
        mine: false,
        error: res.errorCode,
        closedAtMs: Date.now()
      });
      // Resolvido: ou alguém levou, ou a compra é impossível. Em nenhum dos
      // dois casos vale perguntar de novo pelo mesmo anúncio.
      this.sniperSeen.delete(String(buy.id));
      if (!perdido) this.sniperStats.lastError = res.errorCode;
      return 0;
    }

    // O servidor é a fonte da quantidade: numa compra parcial ela pode ser
    // menor que a pedida, e contar o pedido inflaria o alvo.
    const qty = Math.max(1, Number(res.quantity) || buy.quantity);
    const total = Number(res.total) || buy.unitPrice * qty;
    rule.bought = Number(rule.bought || 0) + qty;
    this.sniperStats.buys++;
    if (buy.currency === 'diamond') this.sniperStats.spentDiamond += total;
    else this.sniperStats.spentGold += total;

    this.sniperLogEntry({
      id: String(buy.id),
      status: 'bought',
      mine: true,
      quantity: qty,
      total,
      // `to_mail` é o aviso de mochila cheia: o item foi para o correio do
      // jogo, e sem isto no log ele pareceria não ter chegado.
      toMail: !!res.to_mail,
      closedAtMs: Date.now()
    });
    this.sniperSeen.delete(String(buy.id));

    // O contador vivo em memória não basta: sem gravar, reabrir o launcher
    // zeraria o alvo e a compra aconteceria de novo.
    if (this.sniperSink) {
      try { this.sniperSink(this.sniperConfig); } catch {}
    }
    this.emit('sniper-bought', { index: buyerAccount, rule: rule.id, bought: rule.bought, total });
    return qty;
  }

  /**
   * O que foi do anúncio que sumiu da busca.
   *
   * Sumir não diz o quê: pode ter sido vendido para outra pessoa, expirado ou
   * cancelado pelo vendedor. `market_request{get}` num anúncio já fechado
   * continua respondendo — é o mesmo achado que dá o nível das vendas —, e é
   * ele que traz `buyer_name`. Sem esta pergunta o log diria "desapareceu",
   * que não é o aviso que o usuário pediu.
   *
   * Em série e com teto por rodada, pelo mesmo motivo do enriquecedor de
   * nível: é um pedido por anúncio.
   */
  async sniperResolve(vistos) {
    const sumidos = [...this.sniperSeen.keys()].filter(id => !vistos.has(id));
    if (!sumidos.length) return 0;

    let resolvidos = 0;
    for (const id of sumidos.slice(0, SNIPER_RESOLVE_MAX)) {
      const pendente = this.sniperSeen.get(id);
      this.sniperSeen.delete(id);
      const client = this.sniperClient({ account: pendente && pendente.account })
        || this.marketClient();
      if (!client) continue;

      // `id` já é string e `marketGet` converte: passar por `Number` aqui
      // desfaria a precisão antes mesmo de a conversão certa acontecer.
      const res = await client.marketGet(id).catch(() => ({ errorCode: 'market.gone' }));
      const l = (res && res.listing) || {};
      const status = String(l.status || '');
      const comprador = String(l.buyer_name || '');

      this.sniperLogEntry({
        id,
        // Comprador nomeado também conta como vendido, não só o status: é a
        // informação mais específica das duas, e é ela que o log mostra.
        status: status.endsWith('_SOLD') || comprador ? 'lost' : 'gone',
        mine: false,
        buyer: comprador,
        closedAtMs: Number(l.closed_at_ms) || Date.now()
      });
      resolvidos++;
    }
    return resolvidos;
  }

  /**
   * Liga o sniper. `unref` como no coletor: ele não é motivo para o processo
   * continuar vivo.
   */
  startSniperPoll() {
    if (this.sniperTimer) return false;
    if (!sniper.isConfigured(this.sniperConfig)) return false;
    this.sniperTimer = setInterval(() => { this.pollSniper(); }, this.sniperIntervalMs);
    if (this.sniperTimer.unref) this.sniperTimer.unref();
    this.pollSniper();
    return true;
  }

  stopSniperPoll() {
    if (!this.sniperTimer) return false;
    clearInterval(this.sniperTimer);
    this.sniperTimer = null;
    return true;
  }

  // ------------------------------------------------------------ auto-anunciar

  setAutosellConfig(config) {
    this.autosellConfig = autosell.normalizeConfig(config);
    const antes = this.autosellIntervalMs;
    this.autosellIntervalMs = this.autosellConfig.intervalMs;
    // Intervalo novo com o laço em curso: o `setInterval` antigo continuaria
    // no ritmo velho até ser recriado.
    if (this.autosellTimer && antes !== this.autosellIntervalMs) {
      this.stopAutosellPoll();
      this.startAutosellPoll();
    }
    if (this.autosellSink) {
      try { this.autosellSink(this.autosellConfig); } catch {}
    }
    return this.autosellConfig;
  }

  getAutosellConfig() {
    return { ...this.autosellConfig, excluded: [...this.autosellConfig.excluded] };
  }

  getAutosellStats() {
    return {
      ...this.autosellStats,
      running: !!this.autosellTimer,
      intervalMs: this.autosellIntervalMs,
      enabled: !!this.autosellConfig.enabled
    };
  }

  getAutosellLog() {
    return this.autosellLog.map(e => ({ ...e }));
  }

  setAutosellLog(entries) {
    this.autosellLog = (Array.isArray(entries) ? entries : [])
      .slice(0, AUTOSELL_LOG_MAX)
      .map(e => ({ ...e }));
    return this.autosellLog.length;
  }

  clearAutosellLog() {
    this.autosellLog = [];
    this.saveAutosellLog();
    return true;
  }

  saveAutosellLog() {
    if (!this.autosellLogSink) return;
    try { this.autosellLogSink(this.autosellLog); } catch {}
  }

  /** Uma linha no relatório, no topo, com teto. */
  autosellLogEntry(entry) {
    const linha = { atMs: Date.now(), ...entry };
    this.autosellLog.unshift(linha);
    if (this.autosellLog.length > AUTOSELL_LOG_MAX) {
      this.autosellLog.length = AUTOSELL_LOG_MAX;
    }
    this.saveAutosellLog();
    this.emit('autosell', { entry: linha, stats: this.getAutosellStats() });
    return linha;
  }

  /**
   * O preço de referência de um item, com o nível e o encanto exatos.
   *
   * Duas fontes, e a divisão entre elas é deliberada:
   *
   *   mediana   do **banco local**, que é a única memória de preço efetivamente
   *             pago com o nível anotado. `marketPriceHint` do servidor
   *             responderia mais rápido e sem banco, mas ignora o nível — e
   *             num item onde o nv. 2 vale 3x o nv. 1, uma média de todos os
   *             níveis não é uma aproximação, é outro número.
   *   rival     uma busca no mercado **filtrada pelo nível**, ordenada por
   *             preço. A primeira página basta: o que interessa é o menor.
   *
   * O resultado fica em cache **dentro da rodada**. Oito contas com citrino
   * nv. 2 fariam oito buscas idênticas; uma rodada depois o cache é jogado
   * fora, porque o anúncio rival é o dado que envelhece mais rápido aqui.
   */
  async autosellPriceFor(item, client) {
    const chave = autosell.priceKeyOf(item);
    if (this.autosellPrices.has(chave)) return this.autosellPrices.get(chave);

    const defId = String(item.defId || '');
    const level = Number(item.level) || 0;
    let median = 0;
    let samples = 0;

    if (this.marketDb) {
      try {
        // `level` exato: `salesForPricing` descarta as vendas sem nível
        // anotado, que é o que impede uma venda de nível desconhecido de
        // entrar na mediana de um nível específico.
        const vendas = this.marketDb.salesForPricing(defId, {
          level, days: 30, limit: listingRules.SAMPLE_SIZE
        });
        const conta = listingRules.suggestPrice(vendas);
        median = conta.median;
        samples = conta.samples;
      } catch (err) {
        this.autosellStats.lastError = 'autosell.dbFailed';
      }
    }

    let rival = 0;
    // Sem mediana a busca é desperdício: o item vai ser pulado de qualquer
    // forma, e uma busca por item sem referência multiplicaria o tráfego pela
    // parte do inventário que o auto-anunciar nunca vai vender.
    if (median > 0) {
      const busca = await client.marketSearch({
        defId,
        currency: 'gold',
        sort: 'preco-asc',
        // O servidor filtra por faixa; min e max iguais é o nível exato. Sem
        // isto a primeira página viria cheia de nv. 1 baratos e o nv. 2 sairia
        // pelo preço deles.
        levelMin: level,
        levelMax: level
      }).catch(() => ({ errorCode: 'autosell.searchFailed', listings: [] }));
      if (busca.errorCode) this.autosellStats.lastError = busca.errorCode;
      else rival = autosell.lowestRival(busca.listings || [], item);
    }

    const ref = { median, samples, rival };
    this.autosellPrices.set(chave, ref);
    return ref;
  }

  /**
   * Uma rodada de auto-anunciar, para uma conta.
   *
   * A ordem é a mesma que a aba Anunciar provou: recolher o correio, ler as
   * vagas, ler a bolsa, precificar, mover do depósito, destrancar, e só então
   * `create` — em série, item por item, para cada falha ser atribuível a um
   * item e não à rodada.
   *
   * Nunca lança: roda sozinha em segundo plano, e uma falha de rede não pode
   * derrubar o temporizador.
   */
  async runAutosell(index) {
    const cfg = this.autosellConfig;
    const client = this.clients.get(index);
    if (!client || client.status !== 'connected') return 0;

    const catalog = this.marketCatalogStore.value;
    // Sem catálogo nada é classificado, e classificar por `def_id` adivinhado
    // venderia equipamento como se fosse gema. A rodada espera a próxima.
    if (!catalog || !catalog.items) {
      this.autosellStats.lastError = 'autosell.noCatalog';
      return 0;
    }

    // 1. Correio. Uma venda entrega o ouro por aqui, e um anúncio expirado
    // devolve o item por aqui — sem recolher, a vaga some e o item não volta
    // para a bolsa onde o passo 3 poderia reanunciá-lo.
    if (cfg.claimMail) {
      const caixa = await client.mailList().catch(() => ({ entries: [] }));
      const ids = autosell.claimableMail(caixa.entries);
      if (ids.length) {
        const r = await client.mailClaim(ids).catch(() => ({ claimed: [] }));
        if ((r.claimed || []).length) {
          this.autosellStats.claimed += r.claimed.length;
          this.autosellStats.goldClaimed += Number(r.gold) || 0;
          this.autosellLogEntry({
            account: index, action: 'claim',
            count: r.claimed.length, gold: Number(r.gold) || 0
          });
        }
        if (r.bagFull) {
          // Bolsa cheia: anunciar exige trazer item do depósito e destrancar,
          // e os dois pioram com a bolsa sem espaço. Melhor parar e dizer.
          this.autosellStats.lastError = 'autosell.bagFull';
          this.autosellLogEntry({ account: index, action: 'skip', reason: 'bagFull' });
          return 0;
        }
      }
    }

    // 2. As vagas, do servidor. O teto de anúncios é do jogo e muda com a
    // conta: um número nosso daria recusa em vez de um item a menos.
    const mine = await client.marketMine().catch(() => ({ errorCode: 'autosell.mineFailed' }));
    if (mine.errorCode) {
      this.autosellStats.lastError = mine.errorCode;
      return 0;
    }

    const limit = Number(mine.limit) || 0;
    // Os de pé, contados por status. `mine.active` existe, mas `mine` devolve
    // também vendido e expirado na mesma lista — contar o tamanho dela daria
    // "sem vagas" com dez anúncios já fechados ocupando o número.
    const active = listingRules.splitListings(mine.listings || []).active.length;
    if (limit > 0 && active >= limit) {
      // Nada a fazer, e não é erro: as vagas estão ocupadas por anúncios de
      // pé. Reprecificar não está no escopo — o usuário cancela à mão.
      return 0;
    }

    // 3. A bolsa. Só o escopo 1: o depósito aparece na aba Anunciar porque lá
    // o usuário escolhe, mas uma automação que esvazia o depósito sozinha
    // venderia o que foi guardado de propósito.
    const inv = await client.inventoryItems({ scopes: [1] })
      .catch(() => ({ errorCode: 'autosell.invFailed', items: [] }));
    if (inv.errorCode) {
      this.autosellStats.lastError = inv.errorCode;
      return 0;
    }

    // 4. Preço. Só dos que passam o filtro de categoria, senão uma busca por
    // item varreria o inventário inteiro atrás de preço para equipamento que
    // nunca vai ser anunciado.
    // A lista de bloqueio entra aqui também, e não só no plano: sem ela, o
    // item barrado ainda custaria uma busca de mercado por rodada, por conta,
    // para ser recusado no passo seguinte.
    const barrados = new Set(cfg.blocked || []);
    const candidatos = (inv.items || []).filter(it => !autosell.skipReason(it, catalog, barrados));
    const prices = new Map();
    for (const it of candidatos) {
      const chave = autosell.priceKeyOf(it);
      if (prices.has(chave)) continue;
      prices.set(chave, await this.autosellPriceFor(it, client));
    }

    const plano = autosell.planRound({
      items: inv.items || [], catalog, prices, limit, active, config: cfg
    });
    if (!plano.ready.length) {
      // O relatório registra a rodada vazia com o motivo mais comum: é a
      // diferença entre "não achou nada" e "não rodou".
      if (plano.skipped.length) {
        const motivos = {};
        for (const s of plano.skipped) motivos[s.reason] = (motivos[s.reason] || 0) + 1;
        this.autosellLogEntry({ account: index, action: 'none', skipped: motivos });
      }
      return 0;
    }

    // 5. Destrancar. O depósito não entra, então só o cadeado sobra do preparo
    // que a aba Anunciar faz.
    const preparo = listingRules.prepareListings(plano.ready, inv.items || []);
    const travados = new Set();
    for (const uid of preparo.unlock) {
      const r = await client.lockItem(uid, false).catch(e => ({ errorCode: e.message }));
      if (r.errorCode) travados.add(String(uid));
    }

    // 6. `create`, em série. Cada falha pertence a um item.
    let anunciados = 0;
    for (const draft of plano.ready) {
      if (travados.has(draft.uid)) {
        this.autosellLogEntry({
          account: index, action: 'fail', uid: draft.uid,
          defId: draft.defId, name: draft.name, error: 'inv.lockFailed'
        });
        continue;
      }
      const res = await client.marketCreate({
        uid: draft.uid,
        unitPrice: draft.unitPrice,
        quantity: draft.quantity,
        currency: 'gold',
        hours: listingRules.LISTING_HOURS
      }).catch(e => ({ errorCode: e.message }));

      if (res.errorCode) {
        this.autosellLogEntry({
          account: index, action: 'fail', uid: draft.uid,
          defId: draft.defId, name: draft.name, error: res.errorCode
        });
        this.autosellStats.lastError = res.errorCode;
        continue;
      }

      anunciados++;
      this.autosellStats.listed++;
      this.autosellLogEntry({
        account: index, action: 'list', uid: draft.uid,
        defId: draft.defId, name: draft.name, level: draft.level,
        quantity: draft.quantity, unitPrice: draft.unitPrice, total: draft.total,
        listingId: (res.listing && String(res.listing.id)) || '',
        // A conta do preço vai para o relatório: um anúncio automático que não
        // dá para auditar depois é um anúncio em que não se pode confiar.
        from: draft.from
      });
    }
    return anunciados;
  }

  /**
   * O que o auto-anunciar venderia, agregado por item — o picker da lista de
   * bloqueio.
   *
   * Parte do inventário real das contas, não do catálogo inteiro. O catálogo
   * tem milhares de definições e a pergunta do usuário é outra: "do que ele
   * pode vender **do meu**, o que eu não quero que saia". Uma lista de tudo o
   * que existe no jogo esconde justamente o punhado de itens que importa.
   *
   * Equipamento sai daqui, como sai da rodada: bloquear o que já nunca seria
   * anunciado só encheria a lista de linhas sem efeito.
   *
   * Só a bolsa (escopo 1), pela mesma razão da rodada — é o escopo de onde o
   * auto-anunciar tira itens, e mostrar o depósito sugeriria que o bloqueio
   * importa para o que está guardado lá.
   */
  async autosellCandidates() {
    const catalog = this.marketCatalogStore.value;
    if (!catalog || !catalog.items) return { items: [], offline: [], errorCode: 'autosell.noCatalog' };

    const ativos = [];
    const offline = [];
    for (const index of [...this.clients.keys()].sort((a, b) => a - b)) {
      if (index === -1) continue;
      const client = this.clients.get(index);
      if (client && client.status === 'connected') ativos.push(client);
      else if (client) offline.push({ index, name: (client.state && client.state.name) || '' });
    }

    // Em paralelo: são leituras, em sockets separados. Ao contrário da rodada,
    // que é escrita e vai em série de propósito.
    const leituras = await Promise.all(ativos.map(async client => ({
      index: client.index,
      name: (client.state && client.state.name) || '',
      res: await client.inventoryItems({ scopes: [1] }).catch(() => ({ items: [] }))
    })));

    const porDef = new Map();
    for (const leitura of leituras) {
      for (const it of (leitura.res.items || [])) {
        // Sem a lista de bloqueio: um item já barrado tem de continuar
        // aparecendo, senão desmarcá-lo seria impossível.
        if (autosell.skipReason(it, catalog)) continue;
        const defId = String(it.defId || '');
        const alvo = porDef.get(defId) || {
          defId,
          name: (catalog.items[defId] && catalog.items[defId].name) || defId,
          category: autosell.categoryOf(it, catalog),
          qty: 0,
          accounts: new Set(),
          levels: new Set()
        };
        alvo.qty += Math.max(1, Number(it.qty) || 1);
        alvo.accounts.add(leitura.index);
        if (Number(it.level)) alvo.levels.add(Number(it.level));
        porDef.set(defId, alvo);
      }
    }

    const items = [...porDef.values()]
      .map(e => ({
        defId: e.defId,
        name: e.name,
        category: e.category,
        qty: e.qty,
        accounts: e.accounts.size,
        levels: [...e.levels].sort((a, b) => a - b)
      }))
      // Quantidade primeiro: o que o jogo produz aos montes é o que o usuário
      // quer ver no topo para decidir.
      .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name, 'pt-BR'));

    return { items, offline, readAtMs: Date.now() };
  }

  /**
   * Uma rodada em todas as contas que participam.
   *
   * Em série, ao contrário de `inventoryOwners`: são escritas de mercado, e um
   * erro de preço simultâneo em oito contas é oito vezes o prejuízo de um. O
   * intervalo é de minutos, então a latência somada não custa nada.
   */
  async pollAutosell() {
    if (this.autosellBusy) return 0;
    if (!this.autosellConfig.enabled) return 0;

    this.autosellBusy = true;
    // O cache de preço vale uma rodada: o anúncio rival é o dado que mais
    // envelhece, e um preço velho faria o launcher anunciar abaixo de um
    // mercado que já subiu.
    this.autosellPrices.clear();
    let total = 0;
    try {
      this.autosellStats.rounds++;
      this.autosellStats.lastAtMs = Date.now();
      this.autosellStats.lastError = '';

      for (const index of [...this.clients.keys()].sort((a, b) => a - b)) {
        // A conta dedicada do sniper não tem inventário para vender.
        if (index === -1) continue;
        if (!autosell.includesAccount(this.autosellConfig, index)) continue;
        total += await this.runAutosell(index).catch(() => 0);
      }
      this.autosellStats.lastCount = total;
    } catch (err) {
      this.autosellStats.lastError = err.message || 'autosell.failed';
    } finally {
      this.autosellBusy = false;
      this.autosellPrices.clear();
    }
    return total;
  }

  /** Liga o laço. `unref` como nos outros: não prende o processo vivo. */
  startAutosellPoll() {
    if (this.autosellTimer) return false;
    if (!autosell.isConfigured(this.autosellConfig)) return false;
    this.autosellTimer = setInterval(() => { this.pollAutosell(); }, this.autosellIntervalMs);
    if (this.autosellTimer.unref) this.autosellTimer.unref();
    this.pollAutosell();
    return true;
  }

  stopAutosellPoll() {
    if (!this.autosellTimer) return false;
    clearInterval(this.autosellTimer);
    this.autosellTimer = null;
    return true;
  }

  /**
   * Quem tem cada item, entre todas as contas em modo monitor.
   *
   * A pergunta que isto responde não existia na tela de preços: ela dizia
   * quanto um item vale, mas com oito contas o que falta saber é se vale a
   * pena ir buscar — e em qual delas.
   *
   * As contas são consultadas em paralelo de propósito. São sockets
   * independentes, uma por conta, e o custo medido é de ~35 ms por pedido:
   * em série, oito contas somariam a latência oito vezes para nada. O que
   * não pode ir em paralelo são as páginas de uma mesma conta, e essas ficam
   * em série dentro de `inventoryCounts`.
   *
   * Conta desconectada não é erro: ela aparece em `offline` para a tela
   * poder dizer "não sei" em vez de "não tem", que são coisas diferentes e
   * levariam a decisões opostas.
   *
   * (A documentação de `inventoryOwners` continua logo acima da função.)
   */

  /**
   * O inventário inteiro de cada conta em modo monitor.
   *
   * Diferente de `inventoryOwners`, que parte de uma lista de itens e
   * pergunta quem tem. Aqui a pergunta é a inversa — "o que eu tenho, e
   * quanto isso vale" — e não existe lista prévia para filtrar: é varredura.
   *
   * Medido: 301 itens em 4 pedidos, 107 ms por conta. Com oito contas em
   * paralelo o custo continua sendo o de uma, porque são sockets separados.
   */
  async inventoryBags() {
    const ativos = [];
    const offline = [];
    for (const index of [...this.clients.keys()].sort((a, b) => a - b)) {
      const client = this.clients.get(index);
      if (client && client.status === 'connected') ativos.push(client);
      else if (client) offline.push({ index, name: client.state.name || '' });
    }

    const contas = await Promise.all(ativos.map(async client => {
      const res = await client.inventoryCounts([], { all: true }).catch(err => ({
        errorCode: (err && err.message) || 'inv.failed', owned: {}
      }));
      return {
        index: client.index,
        name: client.state.name || '',
        errorCode: res.errorCode || '',
        owned: res.owned || {}
      };
    }));

    return { contas, offline, readAtMs: Date.now() };
  }

  async inventoryOwners(defIds, opts = {}) {
    const ids = [...new Set((defIds || []).map(String).filter(Boolean))];
    if (!ids.length) return { byDef: {}, accounts: [], offline: [] };

    const ativos = [];
    const offline = [];
    for (const index of [...this.clients.keys()].sort((a, b) => a - b)) {
      const client = this.clients.get(index);
      if (client && client.status === 'connected') ativos.push(client);
      else if (client) offline.push({ index, name: client.state.name || '' });
    }

    const leituras = await Promise.all(ativos.map(async client => {
      const res = await client.inventoryCounts(ids, opts).catch(err => ({
        errorCode: err && err.message || 'inv.failed', owned: {}
      }));
      return {
        index: client.index,
        name: client.state.name || '',
        errorCode: res.errorCode || '',
        owned: res.owned || {}
      };
    }));

    // Invertido por item, que é como a tela pergunta: ela tem uma linha por
    // item e precisa saber, para aquela linha, quais contas aparecem.
    const byDef = {};
    for (const leitura of leituras) {
      for (const [defId, dados] of Object.entries(leitura.owned)) {
        const alvo = byDef[defId] || (byDef[defId] = { total: 0, equipped: 0, accounts: [] });
        alvo.total += dados.qty;
        alvo.equipped += dados.equipped;
        alvo.accounts.push({ index: leitura.index, name: leitura.name, ...dados });
      }
    }
    // Quem tem mais primeiro: é a conta de onde vale a pena vender.
    for (const entrada of Object.values(byDef)) {
      entrada.accounts.sort((a, b) => b.qty - a.qty || a.index - b.index);
    }

    return {
      byDef,
      accounts: leituras.map(l => ({ index: l.index, name: l.name, errorCode: l.errorCode })),
      offline,
      readAtMs: Date.now()
    };
  }

  /** Portais, faixas e dificuldades, ou `null` antes do primeiro login. */
  getHuntCatalog() {
    return this.huntStore.value;
  }

  /**
   * Semeia a lista com a cópia salva em disco, para o seletor de caçada abrir
   * cheio antes de qualquer monitor conectar. Não marca `fresh`: a primeira
   * conta a logar ainda vai ler o catálogo e substituir esta cópia.
   */
  setHuntCatalog(catalog) {
    if (this.huntStore.fresh) return this.huntStore.value;
    if (hunts.hasHunts(catalog)) this.huntStore.value = catalog;
    return this.huntStore.value;
  }

  /** Ícones e cores de raridade, ou `null` antes do primeiro login. */
  getMarketCatalog() {
    return this.marketCatalogStore.value;
  }

  /**
   * Semeia com a cópia salva em disco, para a tabela de preços abrir já com
   * os ícones em vez de piscar. Não marca `fresh`: a primeira conta a logar
   * ainda lê o catálogo do servidor e substitui esta cópia, que pode estar
   * velha em relação ao jogo.
   */
  setMarketCatalog(catalog) {
    if (this.marketCatalogStore.fresh) return this.marketCatalogStore.value;
    if (marketCatalog.hasCatalog(catalog)) this.marketCatalogStore.value = catalog;
    return this.marketCatalogStore.value;
  }

  /** Aplica a configuração de refill nos monitores já em execução. */
  setRefillConfig(config) {
    this.refillConfig = refill.normalizeConfig(config);
    for (const client of this.clients.values()) client.setRefillConfig(this.refillConfig);
    return this.refillConfig;
  }

  /** Aplica a configuração de expedição nos monitores já em execução. */
  setExpeditionConfig(config) {
    this.expeditionConfig = expedition.normalizeConfig(config);
    for (const client of this.clients.values()) {
      client.setExpeditionConfig(this.expeditionConfig);
    }
    return this.expeditionConfig;
  }

  getExpeditionConfig() {
    return this.expeditionConfig;
  }

  /**
   * O estado de expedição de cada conta, para a janela.
   *
   * As contas são consultadas em paralelo, como em `inventoryBags`: são
   * sockets independentes, e em série oito contas somariam a latência oito
   * vezes para mostrar a mesma tela.
   *
   * Conta desconectada aparece com `connected: false` em vez de sumir:
   * esconder faria parecer que ela não existe, quando o que falta é ligar o
   * monitor nela.
   *
   * `force` relê o painel no servidor. Sem ele a tela usa o último painel que
   * o laço já leu, que é o caminho normal de abrir a janela — o painel vale
   * por um minuto, e uma releitura por conta a cada abertura seria tráfego
   * para mostrar o mesmo número.
   */
  async expeditionReport(options = {}) {
    const force = !!options.force;
    const indices = [...this.clients.keys()].sort((a, b) => a - b);

    const contas = await Promise.all(indices.map(async index => {
      const client = this.clients.get(index);
      const base = {
        index,
        name: (client && client.state && client.state.name) || '',
        connected: !!client && client.status === 'connected',
        enabled: expedition.accountEnabled(this.expeditionConfig, index),
        errorCode: '',
        summary: null,
        stats: client ? client.getExpeditionStats() : null
      };
      if (!base.connected) return base;

      if (force || !client.expeditionPanel) {
        const res = await client.expeditionPanelRead().catch(err => ({
          errorCode: (err && err.message) || 'exp.failed'
        }));
        if (res.errorCode) return { ...base, errorCode: res.errorCode };
      }
      return {
        ...base,
        summary: client.state.expedition,
        stats: client.getExpeditionStats()
      };
    }));

    return { accounts: contas, config: this.expeditionConfig };
  }

  /** Uma rodada agora em todas as contas que participam, sem esperar o relógio. */
  async pollExpedition() {
    const alvos = [...this.clients.values()].filter(c =>
      c && c.status === 'connected'
      && expedition.accountEnabled(this.expeditionConfig, c.index));

    // Em paralelo: uma conta não depende da outra, e o painel de cada uma sai
    // pelo seu próprio socket.
    //
    // `runExpedition` direto, e não `maybeExpedition`: este caminho é o botão
    // "rodar agora" da janela, e passar pelas guardas de intervalo faria o
    // clique não fazer nada quando o laço acabou de rodar. A trava de
    // concorrência continua valendo — ela é o que impede duas rodadas na mesma
    // conta.
    await Promise.all(alvos.map(async client => {
      if (client.expeditionBusy) return;
      client.expeditionBusy = true;
      client.expeditionAt = Date.now() + (this.expeditionConfig.intervalMs || EXPEDITION_POLL_MS);
      try {
        await client.runExpedition();
      } finally {
        client.expeditionBusy = false;
      }
    }));

    return this.expeditionReport();
  }

  /** Aplica a configuração de boss nos monitores já em execução. */
  setBossConfig(config) {
    this.bossConfig = boss.normalizeConfig(config);
    for (const client of this.clients.values()) {
      client.setBossConfig(this.bossConfig);
    }
    return this.bossConfig;
  }

  getBossConfig() {
    return this.bossConfig;
  }

  /**
   * O estado de boss diário de cada conta, para a janela.
   *
   * Mesma forma de `expeditionReport`, e pelas mesmas razões: contas em
   * paralelo porque são sockets independentes, e conta desconectada aparece com
   * `connected: false` em vez de sumir — esconder faria parecer que ela não
   * existe, quando o que falta é ligar o monitor nela.
   *
   * `force` relê o estado no servidor. Sem ele a tela usa a última leitura, que
   * é o caminho normal: o estado muda uma vez por dia, e reler em cada abertura
   * da janela seria tráfego para mostrar o mesmo número.
   */
  async bossReport(options = {}) {
    const force = !!options.force;
    const indices = [...this.clients.keys()].sort((a, b) => a - b);

    const contas = await Promise.all(indices.map(async index => {
      const client = this.clients.get(index);
      const base = {
        index,
        name: (client && client.state && client.state.name) || '',
        level: (client && client.state && client.state.level) || 0,
        connected: !!client && client.status === 'connected',
        enabled: boss.accountEnabled(this.bossConfig, index),
        errorCode: '',
        summary: null,
        stats: client ? client.getBossStats() : null
      };
      if (!base.connected) return base;

      if (force || !client.bossState) {
        const res = await client.bossStateRead().catch(err => ({
          errorCode: (err && err.message) || 'boss.failed'
        }));
        if (res.errorCode) return { ...base, errorCode: res.errorCode };
      }
      return {
        ...base,
        summary: client.state.boss,
        stats: client.getBossStats()
      };
    }));

    return { accounts: contas, config: this.bossConfig };
  }

  /**
   * Uma rodada agora em todas as contas que participam, sem esperar o relógio.
   *
   * `force` ignora o dia já feito. É o botão "fazer agora" da janela: o usuário
   * que equipou a conta depois de uma rodada fraca quer tentar o que sobrou, e
   * o servidor é quem recusa o que já foi — `done_today` tira o boss da fila na
   * própria leitura, então forçar nunca gasta tentativa duas vezes.
   */
  async pollBoss(options = {}) {
    const alvos = [...this.clients.values()].filter(c =>
      c && c.status === 'connected'
      && boss.accountEnabled(this.bossConfig, c.index));

    // Em paralelo entre contas: cada rodada é uma sequência longa no socket da
    // própria conta, e em série oito contas somariam os limites de tempo de
    // todos os bosses de todas elas.
    //
    // `runBoss` direto, e não `maybeBoss`: este é o botão da janela, e passar
    // pelas guardas de intervalo faria o clique não fazer nada. A trava de
    // concorrência continua valendo — ela é o que impede duas rodadas na mesma
    // conta.
    await Promise.all(alvos.map(async client => {
      if (client.bossBusy) return;
      if (options.force) client.bossRunResetAtMs = 0;
      client.bossBusy = true;
      client.bossAt = Date.now() + (this.bossConfig.intervalMs || BOSS_POLL_MS);
      try {
        await client.runBoss();
      } finally {
        client.bossBusy = false;
      }
    }));

    return this.bossReport();
  }

  start(accountIndex, options = {}) {
    this.stop(accountIndex);
    const client = new LevelingHeadlessClient(accountIndex, {
      ...this.clientOptions,
      // A configuração de refill é uma só para todas as contas; o manager a
      // guarda para que um monitor iniciado depois já nasça com ela.
      refillConfig: this.refillConfig,
      // Mesma razão para a expedição: um monitor iniciado depois — por
      // `bootMonitor` ou por um clique no painel — já nasce participando, sem
      // depender de a janela de expedição ter sido aberta.
      expeditionConfig: this.expeditionConfig,
      // Mesma razão para o boss: uma conta cujo monitor sobe depois já nasce
      // participando, e se a virada do dia já passou a rodada acontece no
      // próprio login.
      bossConfig: this.bossConfig,
      // O catálogo de caçadas é do jogo, não da conta: a primeira conta a logar
      // o preenche e as outras já nascem com a lista pronta.
      huntStore: this.huntStore,
      // Mesma lógica para a aparência do mercado: ícones e cores de raridade
      // são conteúdo do jogo, lidos uma vez por execução do launcher.
      marketCatalogStore: this.marketCatalogStore,
      ...options
    });
    this.clients.set(accountIndex, client);

    for (const event of ['update', 'status', 'error', 'ended', 'death', 'notice', 'token', 'arise', 'refill', 'expedition', 'boss', 'hunts', 'market-catalog', 'market-sold']) {
      // `cambio` não entra aqui: ele é emitido pelo manager, não pelo cliente —
      // um hop pertence ao par de contas, não a uma delas.
      client.on(event, data => this.emit(event, data));
    }
    // Só a sessão substituída encerra o monitor: a conta está sendo usada
    // alhures. Uma queda de sessão não é motivo para desmontar o cliente — ele
    // tem token e backoff para voltar sozinho, e desmontar aqui era o que fazia
    // a conta sair do modo monitor depois de horas rodando.
    client.on('ended', ({ handoff }) => {
      if (handoff) this.stop(accountIndex);
    });

    client.connect();
    return client;
  }

  stop(accountIndex) {
    const client = this.clients.get(accountIndex);
    if (!client) return false;
    this.clients.delete(accountIndex);
    client.disconnect();
    return true;
  }

  stopAll() {
    for (const index of [...this.clients.keys()]) this.stop(index);
  }

  getClient(accountIndex) {
    return this.clients.get(accountIndex) || null;
  }

  getStatus(accountIndex) {
    const client = this.getClient(accountIndex);
    if (!client) return { active: false, status: 'disconnected', state: null };
    return client.getStatus();
  }

  isActive(accountIndex) {
    const client = this.getClient(accountIndex);
    return !!client && client.status === 'connected';
  }

  /**
   * Monta um grupo com as contas indicadas, na ordem recebida: a primeira vira
   * líder. Só entram contas com monitor conectado — a conta que está na WebView
   * do jogo não tem socket aqui, e o servidor aceita uma sessão por conta.
   *
   * Uma montagem por vez: as etapas são encadeadas por push, e duas em paralelo
   * leriam os pushes uma da outra.
   */
  // -------------------------------------------------------------- câmbio

  /**
   * Contas que podem participar da cadeia agora: em modo monitor, conectadas e
   * fora de qualquer outra operação.
   *
   * A conta dedicada do sniper (índice -1) fica de fora: ela não é uma conta do
   * usuário na cadeia, é um socket de leitura de mercado.
   */
  cambioAtivos() {
    const out = [];
    for (const index of [...this.clients.keys()].sort((a, b) => a - b)) {
      if (index === -1) continue;
      const client = this.clients.get(index);
      if (!client || client.status !== 'connected') continue;
      out.push(index);
    }
    return out;
  }

  /**
   * Uma conta está livre para entrar num hop?
   *
   * Refill, boss e expedição tiram a conta da caçada e restauram o bilhete no
   * fim; uma troca no meio disso brigaria pela mesma cena. O recíproco também
   * vale: enquanto `cambioBusy` está marcado no cliente, `maybeRefill`,
   * `maybeBoss` e `setHunt` recusam.
   */
  cambioLivre(client) {
    if (!client || client.status !== 'connected') return false;
    return !client.refillBusy && !client.bossBusy
      && !client.expeditionBusy && !client.partyBusy && !client.cambioBusy;
  }

  /**
   * Uma rodada: acha o próximo hop que vale a pena e o executa.
   *
   * Nunca lança. O laço roda em segundo plano para sempre, e uma falha de rede
   * não pode derrubar o temporizador. O erro fica em `cambioStats`.
   *
   * Um hop por rodada, de propósito: o pedido é explícito que só pode haver
   * outra troca quando a primeira terminar e o saldo for confirmado.
   */
  async pollCambio() {
    if (this.cambioBusy) return null;
    if (!this.cambioConfig.enabled) return null;
    // O intervalo entre hops. `cambioWaitMs` guarda o sorteio da espera
    // corrente para que o jitter não seja re-sorteado a cada tique — isso faria
    // a espera efetiva ser sempre a menor que saísse no dado.
    const espera = this.cambioWaitMs || this.cambioConfig.intervaloMs;
    if (this.cambioLastAtMs && Date.now() - this.cambioLastAtMs < espera) return null;

    const hops = cambio.planCadeia(this.cambioConfig, this.cambioAtivos());
    if (!hops.length) {
      this.cambioStats.lastError = 'cambio.semCadeia';
      return null;
    }

    // O primeiro hop da cadeia que tem ouro sobrando. Varrer em vez de parar no
    // primeiro: a conta mais alta pode estar abaixo da reserva enquanto a do
    // meio já acumulou o bastante, e esperar por ela travaria a cadeia inteira.
    for (const hop of hops) {
      const de = this.getClient(hop.de);
      const para = this.getClient(hop.para);
      if (!this.cambioLivre(de) || !this.cambioLivre(para)) continue;

      const plano = cambio.planHop(this.cambioConfig, de.state.gold);
      if (plano.skip) continue;

      return this.runCambioHop(hop, plano);
    }

    this.cambioStats.lastError = 'cambio.nadaASobrar';
    return null;
  }

  /**
   * Um hop completo: duas contas, uma troca, ouro conferido.
   *
   * As etapas, e por que são estas (todas medidas em `tools/trade-probe.js`):
   *
   *   amizade      `invite` sem amizade responde `trade.friends_only`. É a
   *                única pré-condição que o servidor cobra por código, e é
   *                persistente — vale uma vez por par.
   *   reunião      as duas na cidade, no mesmo canal, perto uma da outra.
   *   oferta       `set_offer{gold}` e **conferir** antes de travar: depois do
   *                `lock` o servidor recusa mudar a oferta (`trade.locked`) e a
   *                trava não cai, então o que for conferido aqui vale até o fim.
   *   confirmação  os dois `confirm`, e o `completed` que fecha.
   *   conferência  `given_gold`/`received_gold` contra o plano, e o saldo.
   *   retorno      `start_hunt` nas duas, no `finally`, só em quem tinha
   *                bilhete — medido, uma das contas pode legitimamente não ter.
   *
   * Não há etapa de correio: medido, `TradeCompleted.mailed` vem falso nas
   * trocas de ouro e o valor cai direto no saldo. `mailed` continua sendo
   * conferido, mas como aviso, não como caminho.
   */
  async runCambioHop(hop, plano) {
    const de = this.getClient(hop.de);
    const para = this.getClient(hop.para);
    if (!de || !para) return null;

    const rotulo = `${hop.de + 1}→${hop.para + 1}`;
    const cidade = (de.catalog && de.catalog.citySceneId) || 'cidade-seul';

    this.cambioBusy = true;
    de.cambioBusy = true;
    para.cambioBusy = true;
    de.cambioDragged = false;
    para.cambioDragged = false;
    const bilheteDe = de.getHuntTicket();
    const bilhetePara = para.getHuntTicket();
    const cenaOrigemDe = de.state.scene.id;
    const cenaOrigemPara = para.state.scene.id;
    const ouroAntesDe = de.state.gold;
    const ouroAntesPara = para.state.gold;

    this.cambioStats.lastHop = rotulo;
    this.cambioStats.lastError = '';

    let resultado = { ok: false, error: 'cambio.failed', gold: 0 };
    try {
      resultado = await de.withTimeout(
        this.cambioHopSteps(de, para, plano, cidade, { ouroAntesDe, ouroAntesPara }),
        CAMBIO_HOP_TIMEOUT_MS
      );
    } catch (err) {
      resultado = { ok: false, error: err.message || 'cambio.timeout', gold: 0 };
    } finally {
      // Limpeza em ordem: cancelar a troca antes de devolver as contas, senão o
      // `start_hunt` sairia com uma janela de troca ainda aberta.
      await de.tradeCancelQuiet();
      await para.tradeCancelQuiet();

      // Devolver as duas à caçada. Só quem tinha bilhete e de fato saiu: sem
      // bilhete, viajar deixaria a conta parada na cidade, que é pior que não
      // ter tentado.
      for (const [client, bilhete, origem] of [
        [de, bilheteDe, cenaOrigemDe],
        [para, bilhetePara, cenaOrigemPara]
      ]) {
        client.cambioScene = '';
        client.cambioDragged = false;
        client.clearWaiters();
        try {
          if (bilhete && client.isOpen() && client.state.scene.id !== origem) {
            // A espera abre antes do pedido, como no convite: o `scene_enter`
            // pode chegar junto com a resposta do `start_hunt`, e abrir a
            // espera depois cairia num push que já passou.
            //
            // `cambioBusy` continua marcado aqui de propósito: é ele que faz o
            // `wake` acontecer, e sem o `wake` esta espera morreria no timeout
            // de 15 s mesmo com o `scene_enter` tendo chegado.
            const entrou = client.waitFor('scene_enter', 15000);
            await client.request('start_hunt', bilhete);
            await entrou;
          }
        } catch (err) {
          // Falhar aqui deixa a conta na cidade: é o pior caso e tem de
          // aparecer, não ser engolido.
          this.cambioStats.lastError = `volta falhou (conta ${client.index + 1}): ${err.message}`;
        } finally {
          // Só agora: a marca é o que mantém o `wake` vivo durante a volta.
          client.cambioBusy = false;
        }
      }

      this.cambioBusy = false;
      // O intervalo conta do fecho, e o jitter é sorteado agora — uma vez por
      // hop, não a cada tique do laço.
      this.cambioLastAtMs = Date.now();
      this.cambioWaitMs = cambio.proximoIntervalo(this.cambioConfig, this.random);
    }

    this.cambioStats.lastAtMs = Date.now();
    if (resultado.ok) {
      this.cambioStats.hops++;
      this.cambioStats.goldMoved += resultado.gold;
    } else {
      this.cambioStats.lastError = resultado.error;
    }

    this.pushCambioLog({
      atMs: Date.now(),
      de: hop.de,
      para: hop.para,
      rotulo,
      gold: resultado.gold || 0,
      ok: !!resultado.ok,
      error: resultado.ok ? '' : resultado.error,
      mailed: !!resultado.mailed,
      saldoDe: de.state.gold,
      saldoPara: para.state.gold,
      proximoEmMs: this.cambioWaitMs
    });
    if (this.cambioSink) {
      try { this.cambioSink(this.cambioConfig, this.cambioLastAtMs); } catch {}
    }

    this.emit('cambio', {
      ok: !!resultado.ok,
      de: hop.de,
      para: hop.para,
      gold: resultado.gold || 0,
      error: resultado.ok ? '' : resultado.error
    });
    return resultado;
  }

  /**
   * As etapas do hop, separadas do `runCambioHop` para que a limpeza e o
   * retorno à caçada fiquem num `finally` que nenhum `throw` daqui possa pular.
   */
  async cambioHopSteps(de, para, plano, cidade, saldos) {
    const etapa = nome => { this.cambioStats.etapa = nome; };
    const fail = (error, gold = 0) => ({ ok: false, error, gold });

    // ----------------------------------------------------------- 1. amizade
    etapa('amizade');
    const lista = await de.friendList();
    if (lista.errorCode) return fail(lista.errorCode);
    if (cambio.precisaAmizade(lista, para.state.accountId)) {
      // Medido: `kind` vai como número, e o par só fica formado depois do
      // `ACCEPT` do outro lado (`became_friends`).
      const pedido = await de.friendAction(FRIEND_KIND.REQUEST, para.state.accountId, para.state.name);
      if (pedido.errorCode) return fail(pedido.errorCode);
      const aceite = await para.friendAction(FRIEND_KIND.ACCEPT, de.state.accountId, de.state.name);
      if (aceite.errorCode) return fail(aceite.errorCode);
      if (!aceite.becameFriends) return fail('cambio.amizadeNaoFormou');
    }

    // ----------------------------------------------------------- 2. reunião
    etapa('reuniao');
    for (const client of [de, para]) {
      if (client.state.scene.id === cidade) continue;
      client.emitPacket('travel', { scene_id: cidade });
      const chegou = await client.waitFor('scene_enter', 15000);
      if (!chegou || chegou.scene_id !== cidade) return fail('cambio.travelFailed');
    }
    // A cena de referência só é fixada depois de as duas chegarem: antes disso
    // o próprio `travel` dispararia o detector de arrasto.
    de.cambioScene = cidade;
    para.cambioScene = cidade;

    // Mesmo canal. O alvo é o canal de quem **recebe**, por ser o fim da linha
    // da cadeia: mover o doador é o que mantém o destino parado enquanto várias
    // contas descem ouro até ele.
    if (de.state.scene.channel !== para.state.scene.channel) {
      const alvo = para.state.scene.channel;
      const canais = await de.channelList();
      const info = (canais.channels || []).find(c => c.number === alvo);
      // Medido: o canal 1 estava com 146/150. Tentar entrar num canal cheio
      // falharia, e o `recommended` do servidor separaria as duas contas.
      if (info && info.full) return fail('cambio.canalCheio');
      const troca = await de.switchChannel(alvo);
      if (troca.errorCode) return fail(troca.errorCode);
      if (de.state.scene.channel !== alvo) return fail('cambio.canalNaoAlinhou');
    }

    // Proximidade. A troca exige as duas perto, e a caminhada é a mesma do
    // refill: `move_to` e depois observar as snapshots até a distância cair.
    // Na prática as contas nascem no mesmo ponto de spawn da cidade e a
    // distância medida foi zero, mas isso é efeito colateral do spawn, não
    // garantia — uma conta que já estava andando pela cidade estaria longe.
    etapa('aproximar');
    const perto = await this.cambioAproximar(de, para);
    if (!perto.ok) return fail(perto.error);

    // ------------------------------------------------------------ 3. oferta
    etapa('oferta');
    if (de.cambioDragged || para.cambioDragged) return fail('cambio.arrastado');

    // A espera abre **antes** do `invite`, e não depois. Medido no grupo, e
    // vale igual aqui: o `trade_push{invited}` chega no convidado antes de a
    // resposta do `invite` voltar para quem convidou. Abrir a espera depois
    // cairia num push que já passou, e o hop gastaria o timeout inteiro à
    // espera de algo que nunca chega duas vezes.
    const convidado = para.waitFor('trade_push', 10000);

    const convite = await de.tradeRequest('invite', {
      account: uint64(para.state.accountId), name: para.state.name || ''
    });
    if (convite.errorCode) return fail(convite.errorCode);

    // Sem este push o `respond` poderia sair antes de o servidor ter
    // registrado o convite naquela sessão.
    await convidado;
    const aceitou = await para.tradeRequest('respond', {
      from: uint64(de.state.accountId), accept: true
    });
    if (aceitou.errorCode) return fail(aceitou.errorCode);

    const oferta = await de.tradeOfferGold(plano.gold);
    if (oferta.errorCode) return fail(oferta.errorCode);

    // A conferência antes do ponto sem volta. Lê o estado do servidor em vez de
    // confiar na resposta da própria oferta, porque é o estado que o `lock` vai
    // congelar.
    const estado = await de.tradeRequest('get_state', {});
    if (estado.errorCode) return fail(estado.errorCode);
    const confere = cambio.conferirOferta(estado.state, {
      gold: plano.gold,
      meAccount: de.state.accountId,
      partnerAccount: para.state.accountId
    });
    if (!confere.ok) return fail(confere.reason);

    // ------------------------------------------------------------ 4. travar
    etapa('travar');
    const travaDe = await de.tradeRequest('lock', { locked: true });
    if (travaDe.errorCode) return fail(travaDe.errorCode);
    const travaPara = await para.tradeRequest('lock', { locked: true });
    if (travaPara.errorCode) return fail(travaPara.errorCode);

    // Última chance de desistir sem custo: depois do `confirm` dos dois lados o
    // servidor liquida e não há volta.
    if (de.cambioDragged || para.cambioDragged) return fail('cambio.arrastado');

    // -------------------------------------------------------- 5. confirmar
    etapa('confirmar');
    // As duas esperas são abertas **antes** dos `confirm`: medido, o
    // `completed` chega ~30 ms depois do segundo `confirm`, junto com o
    // `character_patch`. Abrir a espera depois perderia o push.
    const fechoDe = this.cambioWaitCompleted(de);
    const fechoPara = this.cambioWaitCompleted(para);

    const confDe = await de.tradeRequest('confirm', { confirmed: true });
    if (confDe.errorCode) return fail(confDe.errorCode);
    const confPara = await para.tradeRequest('confirm', { confirmed: true });
    if (confPara.errorCode) return fail(confPara.errorCode);

    const [completedDe, completedPara] = await Promise.all([fechoDe, fechoPara]);

    // --------------------------------------------------------- 6. conferir
    etapa('conferir');
    const fecho = cambio.conferirFecho(completedDe, completedPara, { gold: plano.gold });
    if (!fecho.ok) return fail(fecho.reason, 0);

    // O saldo, que é a confirmação independente do que o servidor disse. O
    // `character_patch` do ouro chega junto com o `completed`, então em geral já
    // está aplicado; a espera curta cobre a ordem inversa.
    if (!fecho.mailed) {
      if (de.state.gold === saldos.ouroAntesDe) await de.waitFor('character_patch', 5000);
      if (para.state.gold === saldos.ouroAntesPara) await para.waitFor('character_patch', 5000);
      const saldo = cambio.conferirSaldo(
        saldos.ouroAntesDe, de.state.gold,
        saldos.ouroAntesPara, para.state.gold,
        plano.gold
      );
      // O ouro já saiu: isto não desfaz nada, só impede a cadeia de seguir
      // empilhando trocas sobre uma premissa que não se confirmou.
      if (!saldo.ok) return { ok: false, error: saldo.reason, gold: plano.gold };
    }

    etapa('');
    return { ok: true, gold: fecho.gold, mailed: fecho.mailed, heldUntil: fecho.heldUntil };
  }

  /**
   * Espera o `trade_push{completed}` de um lado.
   *
   * `waitFor('trade_push')` resolve no **primeiro** `trade_push` que chegar, e
   * antes do `completed` ainda vem um `state` com `settling: true` — medido na
   * sonda. Então a espera é repetida até o push certo, em vez de aceitar o
   * primeiro.
   */
  async cambioWaitCompleted(client) {
    for (let i = 0; i < 10; i++) {
      const push = await client.waitFor('trade_push', 10000);
      if (!push) return null;
      if (push.completed) return push.completed;
      // `closed` e `declined` encerram a troca sem transferir: insistir só
      // gastaria o timeout.
      if (push.closed || push.declined) return null;
    }
    return null;
  }

  /**
   * Põe as duas contas ao alcance uma da outra.
   *
   * Mesmo mecanismo do refill: `move_to` e depois observar `world_snapshot` até
   * a distância cair. Quem anda é quem **dá** o ouro, pela mesma razão de ser
   * ele quem troca de canal — o destino fica parado.
   *
   * A posição só é lida durante `trip`, então o hop abre um `trip` só para
   * isso. Sem ele, `applyTripPosition` descarta as snapshots e a distância
   * nunca sairia de nula.
   */
  async cambioAproximar(de, para) {
    de.trip = { pos: null, startedAt: Date.now() };
    para.trip = { pos: null, startedAt: Date.now() };
    try {
      // Uma snapshot de cada lado para ter as duas posições antes de decidir.
      await Promise.all([
        de.waitFor('world_snapshot', 5000),
        para.waitFor('world_snapshot', 5000)
      ]);
      const alvo = para.trip && para.trip.pos;
      const meu = de.trip && de.trip.pos;
      if (!alvo || !meu) return { ok: false, error: 'cambio.semPosicao' };

      if (Math.hypot(meu.x - alvo.x, meu.y - alvo.y) <= NPC_REACH) return { ok: true };

      de.emitPacket('move_to', { x: alvo.x, y: alvo.y });
      const chegou = await de.walkTo(alvo);
      return chegou ? { ok: true } : { ok: false, error: 'cambio.walkFailed' };
    } finally {
      de.trip = null;
      para.trip = null;
    }
  }

  getCambioConfig() {
    return { ...this.cambioConfig, disabled: [...this.cambioConfig.disabled] };
  }

  getCambioLog() {
    return this.cambioLog.map(e => ({ ...e }));
  }

  /**
   * Restaura o relatório do disco no boot. Junto com ele vem o relógio do
   * último hop: sem ele, religar o launcher logo depois de uma troca liberaria
   * a seguinte na hora, furando o intervalo que o usuário escolheu.
   */
  setCambioLog(entries, lastAtMs) {
    this.cambioLog = (Array.isArray(entries) ? entries : [])
      .slice(0, CAMBIO_LOG_MAX)
      .map(e => ({ ...e }));
    if (lastAtMs != null) this.cambioLastAtMs = Math.max(0, Number(lastAtMs) || 0);
    return this.cambioLog.length;
  }

  clearCambioLog() {
    this.cambioLog = [];
    if (this.cambioLogSink) {
      try { this.cambioLogSink(this.cambioLog); } catch {}
    }
    return true;
  }

  /** Uma linha no relatório, com teto. Mesma forma do log do sniper. */
  pushCambioLog(entry) {
    this.cambioLog.unshift(entry);
    if (this.cambioLog.length > CAMBIO_LOG_MAX) this.cambioLog.length = CAMBIO_LOG_MAX;
    if (this.cambioLogSink) {
      try { this.cambioLogSink(this.cambioLog); } catch {}
    }
  }

  /** Liga o laço. `unref` como nos outros: não prende o processo vivo. */
  startCambioPoll() {
    if (this.cambioTimer) return false;
    if (!cambio.isConfigured(this.cambioConfig)) return false;
    // O tique é fixo e curto; quem decide se já pode trocar é `pollCambio`,
    // contra `cambioLastAtMs`. Um `setInterval` do tamanho do intervalo faria o
    // primeiro hop esperar dez minutos depois de ligar.
    this.cambioTimer = setInterval(() => { this.pollCambio(); }, CAMBIO_TICK_MS);
    if (this.cambioTimer.unref) this.cambioTimer.unref();
    this.pollCambio();
    return true;
  }

  stopCambioPoll() {
    if (!this.cambioTimer) return false;
    clearInterval(this.cambioTimer);
    this.cambioTimer = null;
    return true;
  }

  /**
   * Troca a configuração do câmbio em quente.
   *
   * O laço é religado só se a configuração mudou de estado: desligar e ligar
   * sem necessidade re-sortearia o jitter e poderia antecipar um hop.
   */
  setCambioConfig(raw) {
    const antes = this.cambioConfig;
    this.cambioConfig = cambio.normalizeConfig(raw);
    if (this.cambioConfig.enabled !== antes.enabled) {
      if (this.cambioConfig.enabled) this.startCambioPoll();
      else this.stopCambioPoll();
    }
    if (this.cambioSink) {
      try { this.cambioSink(this.cambioConfig, this.cambioLastAtMs); } catch {}
    }
    return this.cambioConfig;
  }

  /** O que a tela do câmbio mostra. */
  cambioStatus() {
    const ativos = this.cambioAtivos();
    const hops = cambio.planCadeia(this.cambioConfig, ativos);
    const espera = this.cambioWaitMs || this.cambioConfig.intervaloMs;
    return {
      config: this.cambioConfig,
      ativos,
      hops: hops.map(h => ({
        de: h.de,
        para: h.para,
        // O saldo de cada origem, para a tela dizer qual hop está esperando
        // acumular e qual já poderia sair.
        saldo: (this.getClient(h.de) || { state: { gold: 0 } }).state.gold,
        plano: cambio.planHop(this.cambioConfig, (this.getClient(h.de) || { state: { gold: 0 } }).state.gold)
      })),
      busy: this.cambioBusy,
      etapa: this.cambioStats.etapa,
      lastAtMs: this.cambioLastAtMs,
      proximoEmMs: this.cambioLastAtMs
        ? Math.max(0, this.cambioLastAtMs + espera - Date.now())
        : 0,
      stats: this.cambioStats,
      log: this.cambioLog
    };
  }

  async assembleParty(indexes) {
    if (this.partyBusy) return { ok: false, error: 'party.busy', members: [] };

    const clients = [];
    const skipped = [];
    for (const index of indexes || []) {
      const client = this.getClient(index);
      if (client && client.status === 'connected') clients.push(client);
      else skipped.push(index);
    }

    if (clients.length < 2) {
      return { ok: false, error: 'party.needTwo', members: [], skipped };
    }

    this.partyBusy = true;
    for (const client of clients) client.partyBusy = true;
    try {
      const result = await party.assembleParty(clients, step => this.emit('party:step', step));
      return { ...result, skipped };
    } catch (err) {
      return { ok: false, error: err.message, members: [], skipped };
    } finally {
      for (const client of clients) {
        client.partyBusy = false;
        client.clearWaiters();
      }
      this.partyBusy = false;
    }
  }

  /**
   * Troca a caçada das contas indicadas, a pedido do usuário. Uma conta só ou a
   * aba inteira: o caminho é o mesmo, porque o que muda é só o tamanho da lista.
   *
   * Contas em grupo não recebem a troca individualmente. Medido na montagem de
   * grupo, `start_hunt` do líder arrasta o grupo todo (`party.follow.pulled`);
   * mandar também para cada membro seria uma troca redundante que, chegando
   * antes do arrasto, poderia espalhar o grupo por cenas diferentes. Então para
   * cada grupo representado na lista só o líder recebe o pedido, e os membros
   * aparecem no resultado como `pulled`.
   */
  async setHunt(indexes, ticket) {
    const alvo = hunts.normalizeTicket(ticket);
    if (!alvo) return { ok: false, error: 'hunt.noGate', changed: [], failed: [] };

    const lista = [];
    const skipped = [];
    for (const index of indexes || []) {
      const client = this.getClient(index);
      if (client && client.status === 'connected') lista.push(client);
      else skipped.push(index);
    }
    if (!lista.length) return { ok: false, error: 'hunt.noneActive', changed: [], failed: [], skipped };

    // Quem é arrastado pelo líder do próprio grupo. Só conta o líder que está
    // nesta mesma troca: um grupo cujo líder ficou de fora precisa que cada
    // membro peça a troca por si, senão ninguém sairia do mapa antigo.
    const lideres = new Map();
    for (const client of lista) {
      const estado = client.state.party;
      if (!party.hasParty(estado)) continue;
      if (!party.isLeader(estado, client.state.accountId)) continue;
      lideres.set(String(estado.id), client);
    }

    const pedidos = [];
    const pulled = [];
    for (const client of lista) {
      const estado = client.state.party;
      const lider = party.hasParty(estado) ? lideres.get(String(estado.id)) : null;
      if (lider && lider !== client) {
        pulled.push({ index: client.index, name: client.state.name, leader: lider.index });
        continue;
      }
      pedidos.push(client);
    }

    const changed = [];
    const failed = [];
    // Em série: cada `start_hunt` é um round-trip, e um líder arrastando o
    // grupo gera uma rajada de `scene_enter` nas outras contas. Em paralelo as
    // falhas ficariam sem ordem para relatar.
    for (const client of pedidos) {
      const result = await client.setHunt(alvo).catch(err => ({ ok: false, error: err.message }));
      const entry = { index: client.index, name: client.state.name };
      if (result && result.ok) changed.push(entry);
      else failed.push({ ...entry, error: (result && result.error) || 'hunt.failed' });
    }

    // O bilhete dos arrastados passa a ser o novo mapa: o líder os levou para
    // lá, e sem isto o refill de um membro o devolveria ao mapa antigo. Só vale
    // se o líder de fato trocou — numa troca recusada o membro não saiu do lugar.
    for (const membro of pulled) {
      if (!changed.some(c => c.index === membro.leader)) continue;
      const client = this.getClient(membro.index);
      if (client) client.huntTicket = { ...alvo };
    }

    return {
      ok: !!changed.length && !failed.length,
      gateId: alvo.gate_id,
      tierMin: alvo.tier_min,
      difficulty: alvo.difficulty,
      changed,
      pulled,
      failed,
      skipped
    };
  }
}

const levelingHeadlessManager = new LevelingHeadlessManager();

module.exports = {
  LevelingHeadlessClient,
  LevelingHeadlessManager,
  levelingHeadlessManager,
  WS_URL,
  ORIGIN,
  proxyDispatcher,
  isHandoff,
  REPLACED_CODES,
  IGNORED_CASES,
  IGNORED_PUSHES,
  RATELIMIT_CODES,
  FATAL_AUTH_CODES,
  RATELIMIT_RETRY_MS,
  REFILL_INTERVAL_MS,
  REFILL_BACKOFF_MS,
  MARKET_POLL_MS,
  MARKET_KIND_NUM,
  MARKET_CURRENCY_NUM,
  SNIPER_LOG_MAX,
  SNIPER_RESOLVE_MAX,
  SNIPER_LOST_CODES,
  AUTOSELL_LOG_MAX,
  TRIP_TIMEOUT_MS,
  TRIP_CASES,
  CAMBIO_CASES,
  CAMBIO_TICK_MS,
  CAMBIO_HOP_TIMEOUT_MS,
  CAMBIO_LOG_MAX,
  FRIEND_KIND,
  TRADE_OPS,
  NPC_REACH,
  BOSS_POLL_MS,
  BOSS_BACKOFF_MS,
  BOSS_GAP_MS,
  hunts
};

