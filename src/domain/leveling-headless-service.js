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
      if (!catalogo && !viagem) return;
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
    if (this.trip || this.partyBusy) this.wake(packet.caseName, packet.value);
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
   * Nenhuma operação de escrita passa por aqui. `create`, `buy`, `cancel` e
   * as ofertas ficam fora: o monitor é de leitura, e mexer no inventário da
   * conta sem o usuário pedir seria outra coisa.
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
    value.page = Math.max(Number(filtros.page) || 1, 1);
    const res = await this.marketRequest('search', value);
    if (res.errorCode) return { errorCode: res.errorCode, listings: [] };
    return res.value || { listings: [] };
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
   * Detalhe de um anúncio, com `MarketPriceStats` junto — mais rico que o
   * `price_hint`: traz também quantos anúncios estão ativos e o menor preço
   * pedido agora. Custa ter um `listing_id` em mãos.
   *
   * `id` é uint64 e o codec exige número: o decode entrega string, então a
   * conversão tem de acontecer aqui, senão o encode recusa o pacote.
   */
  async marketGet(listingId) {
    const id = Number(listingId);
    if (!Number.isFinite(id) || id <= 0) return { errorCode: 'market.badId' };
    const res = await this.marketRequest('get', { id });
    return res.errorCode ? { errorCode: res.errorCode } : (res.value || {});
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
  }

  // ------------------------------------------------------------- mercado

  /**
   * Qualquer conta conectada serve para ler o mercado, mas a escolha não pode
   * ser aleatória a cada tique: trocar de conta sem motivo espalharia o
   * tráfego por todas as sessões. A primeira conectada, em ordem de índice,
   * é estável enquanto ela existir.
   */
  marketClient() {
    for (const index of [...this.clients.keys()].sort((a, b) => a - b)) {
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
    return { ...this.marketStats, running: !!this.marketTimer };
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

  start(accountIndex, options = {}) {
    this.stop(accountIndex);
    const client = new LevelingHeadlessClient(accountIndex, {
      ...this.clientOptions,
      // A configuração de refill é uma só para todas as contas; o manager a
      // guarda para que um monitor iniciado depois já nasça com ela.
      refillConfig: this.refillConfig,
      // O catálogo de caçadas é do jogo, não da conta: a primeira conta a logar
      // o preenche e as outras já nascem com a lista pronta.
      huntStore: this.huntStore,
      // Mesma lógica para a aparência do mercado: ícones e cores de raridade
      // são conteúdo do jogo, lidos uma vez por execução do launcher.
      marketCatalogStore: this.marketCatalogStore,
      ...options
    });
    this.clients.set(accountIndex, client);

    for (const event of ['update', 'status', 'error', 'ended', 'death', 'notice', 'token', 'arise', 'refill', 'hunts', 'market-catalog', 'market-sold']) {
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
  TRIP_TIMEOUT_MS,
  TRIP_CASES,
  NPC_REACH,
  hunts
};

