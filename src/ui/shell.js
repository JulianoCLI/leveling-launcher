/**
 * @file shell.js
 * Monta a grade de painéis e liga a interface aos canais `leveling:*`.
 *
 * Cada painel é uma conta: uma WebView com partição própria mais um HUD que
 * cobre a WebView quando o monitor headless assume.
 *
 * As contas crescem em abas de quatro. A grade tem sempre quatro painéis; o
 * que muda é a qual conta cada painel aponta. Manter quatro painéis fixos é o
 * que impede o custo de renderers de crescer junto com o número de contas.
 *
 * A WebView é criada e **removida** do DOM conforme o uso, em vez de ficar
 * parada em `about:blank`: uma WebView viva, mesmo em branco, custa um processo
 * renderer completo. Removê-la é o que faz o modo monitor sair de centenas de
 * megabytes para só a conexão WebSocket. Também é necessário funcionalmente — o
 * servidor aceita uma sessão por conta, então as duas formas se derrubariam.
 *
 * O monitor headless vive no processo principal e não conhece abas: trocar de
 * aba descarta WebViews, nunca monitores. Uma conta de aba escondida continua
 * farmando; só o HUD dela deixa de ser pintado.
 */

(() => {
  'use strict';

  const PER_TAB = 4;
  const MAX_TABS = 16;
  const LAYOUTS = ['split', 'focus', 'solo', 'cols', 'rows'];
  const api = window.pokeAPI;
  const ACTIVE = new Set(['connecting', 'connected', 'reconnecting']);

  const grid = document.getElementById('grid');
  const tabsEl = document.getElementById('tabs');
  /** Os quatro painéis da grade; `account` diz a qual conta cada um aponta. */
  const panels = [];
  let gameUrl = 'about:blank';
  /** Preload da conta: leva o token salvo para dentro da página do jogo. */
  let accountPreload = '';
  let prefs = { panels: 4, tabs: 1, activeTab: 0, tabPrefs: [], keepAwake: false };
  let tabs = 1;
  let activeTab = 0;

  /**
   * Painéis e boot em monitor valem por aba: um grupo pode estar jogando em
   * quatro painéis enquanto outro é só monitor. Ler da aba atual é o que faz a
   * escolha voltar ao trocar de aba.
   */
  const tabPrefs = t => {
    const list = prefs.tabPrefs || (prefs.tabPrefs = []);
    if (!list[t]) list[t] = { panels: PER_TAB, bootMonitor: false, layout: 'split', focus: 0 };
    const tab = list[t];
    if (!LAYOUTS.includes(tab.layout)) tab.layout = 'split';
    if (!(tab.focus >= 0)) tab.focus = 0;
    return tab;
  };

  /** Grava a preferência da aba atual sem mexer nas outras. */
  async function saveTabPrefs(patch) {
    Object.assign(tabPrefs(activeTab), patch);
    prefs = await api.setPrefs({ tabPrefs: prefs.tabPrefs }).catch(() => prefs);
  }
  /** Janela na tela. Escondida, nenhum HUD é repintado. */
  let visible = true;

  /**
   * Estado por conta, não por painel: uma conta de aba escondida continua
   * recebendo updates do monitor, e o painel só existe para as quatro visíveis.
   */
  const accountState = new Map();

  const stateOf = index => {
    let entry = accountState.get(index);
    if (!entry) {
      // `level`, `hunt` e `party` existem para o seletor de caçada: ele precisa
      // confrontar o nível da conta com o exigido pelo mapa e saber quem é
      // líder de grupo. São guardados aqui porque o painel pode estar numa aba
      // escondida, sem HUD pintado.
      entry = {
        status: 'disconnected', error: '', pending: null, name: '',
        level: 0, hunt: null, party: null
      };
      accountState.set(index, entry);
    }
    return entry;
  };

  const accountOf = slot => activeTab * PER_TAB + slot;
  /** Painel que mostra a conta, ou `null` se ela está numa aba escondida. */
  const panelOf = index => {
    const slot = index - activeTab * PER_TAB;
    return slot >= 0 && slot < PER_TAB ? panels[slot] : null;
  };

  const report = (origem, err) => {
    try {
      api.logError(origem, err && err.stack || String(err));
    } catch {}
  };

  // ------------------------------------------------------------------- painéis

  function buildPanels() {
    grid.innerHTML = Array.from({ length: PER_TAB }, (_, i) => `
      <div class="panel" data-index="${i}">
        <div class="panel-head">
          <span class="panel-title" data-role="title">Conta ${i + 1}</span>
          <span class="panel-who" data-role="who"></span>
          <button type="button" data-role="focus" title="Destacar este painel (tela cheia ou painel grande)">⤢</button>
          <button type="button" data-role="reload" title="Recarregar o jogo neste painel">⟳</button>
          <button type="button" data-role="hunt" title="Trocar a caçada desta conta sem desligar o monitor">🗺️</button>
          <button type="button" data-role="headless" title="Monitor somente leitura da caçada">Monitor</button>
        </div>
        <div class="panel-body" data-role="body">
          <div class="panel-hud" data-role="hud"></div>
        </div>
      </div>
    `).join('');

    for (let i = 0; i < PER_TAB; i++) {
      const root = grid.querySelector(`.panel[data-index="${i}"]`);
      const panel = {
        slot: i,
        /** Conta mostrada agora. Muda a cada troca de aba. */
        account: i,
        root,
        body: root.querySelector('[data-role="body"]'),
        view: null,
        title: root.querySelector('[data-role="title"]'),
        who: root.querySelector('[data-role="who"]'),
        toggle: root.querySelector('[data-role="headless"]'),
        hud: window.PioLevelingHud.create(root.querySelector('[data-role="hud"]'))
      };
      panel.toggle.onclick = () => toggleHeadless(panel.account);
      root.querySelector('[data-role="reload"]').onclick = () => reloadGame(panel.account);
      // Troca de caçada desta conta só. O mesmo modal da aba, com uma conta na
      // lista: o escopo é a seleção, não dois fluxos diferentes.
      panel.huntBtn = root.querySelector('[data-role="hunt"]');
      panel.huntBtn.onclick = () => openHunt([panel.account]);
      panel.focusBtn = root.querySelector('[data-role="focus"]');
      panel.focusBtn.onclick = () => focusPanel(panel.slot);
      panels.push(panel);
    }
  }

  // ----------------------------------------------------------------------- abas

  function buildTabs() {
    if (!tabsEl) return;
    tabsEl.innerHTML = Array.from({ length: tabs }, (_, t) => {
      const first = t * PER_TAB + 1;
      return `<button type="button" role="tab" class="tab" data-tab="${t}"
        aria-selected="${t === activeTab}"
        title="Contas ${first} a ${first + PER_TAB - 1}">${first}–${first + PER_TAB - 1}</button>`;
    }).join('');

    for (const button of tabsEl.querySelectorAll('.tab')) {
      button.onclick = () => selectTab(+button.dataset.tab);
    }

    const remove = document.getElementById('tabRemove');
    if (remove) remove.disabled = tabs <= 1;
    const add = document.getElementById('tabAdd');
    if (add) add.disabled = tabs >= MAX_TABS;
  }

  /**
   * Aponta os quatro painéis para outro grupo de contas. As WebViews da aba
   * anterior saem: elas são o custo real, e o servidor derrubaria a sessão de
   * qualquer forma se a conta fosse aberta em outro lugar.
   */
  function selectTab(next) {
    const target = Math.min(tabs - 1, Math.max(0, +next || 0));
    if (target !== activeTab) {
      for (const panel of panels) unloadGame(panel.account);
      activeTab = target;
    }

    for (const panel of panels) {
      panel.account = accountOf(panel.slot);
      panel.title.textContent = 'Conta ' + (panel.account + 1);
      const entry = stateOf(panel.account);
      panel.who.textContent = entry.name;
      panel.hud.clear();
      paintPanel(panel.account);
      // Um monitor que já estava rodando tem o quadro inteiro guardado.
      if (entry.pending) renderState(panel.account, entry.pending);
    }

    buildTabs();

    // A contagem de painéis e o botão de monitor passam a refletir a aba nova.
    const tab = tabPrefs(activeTab);
    const count = document.getElementById('panelCount');
    if (count) count.value = String(tab.panels);
    const bootMonitor = document.getElementById('bootMonitorBtn');
    if (bootMonitor) bootMonitor.classList.toggle('is-on', !!tab.bootMonitor);
    const layout = document.getElementById('layoutMode');
    if (layout) layout.value = tab.layout;

    applyPanelCount(tab.panels);
    if (window.PioLeveling && window.PioLeveling.setTab) window.PioLeveling.setTab(activeTab);
  }

  async function setTabCount(next) {
    const target = Math.min(MAX_TABS, Math.max(1, next));

    // Remover uma aba esconderia um monitor que continua rodando, sem botão
    // para desligá-lo. Desligar antes é o que mantém a barra fiel ao que existe.
    if (target < tabs) {
      for (let i = target * PER_TAB; i < tabs * PER_TAB; i++) {
        if (!ACTIVE.has(stateOf(i).status)) continue;
        await api.levelingStop(i).catch(e => report('leveling:stop', e));
        accountState.delete(i);
      }
    }

    tabs = target;
    if (activeTab >= tabs) activeTab = tabs - 1;
    // O principal cria as sessões e os slots de credencial antes de a aba
    // nova poder fazer qualquer coisa.
    prefs = await api.setPrefs({ tabs, activeTab }).catch(() => prefs);
    buildTabs();
    selectTab(activeTab);
    if (window.PioLeveling && window.PioLeveling.setTabs) {
      window.PioLeveling.setTabs(tabs, activeTab);
    }
  }

  // --------------------------------------------------------------- webview

  /**
   * Cria a WebView só quando o jogo vai de fato rodar. O HUD fica antes dela no
   * DOM, então ela é inserida no começo do corpo para continuar por baixo.
   */
  function loadGame(index) {
    const panel = panelOf(index);
    if (!panel || ACTIVE.has(stateOf(index).status) || panel.root.hidden) return;
    if (panel.view) return;
    try {
      const view = document.createElement('webview');
      view.dataset.role = 'view';
      view.setAttribute('partition', 'persist:conta' + (index + 1));
      view.setAttribute('allowpopups', '');
      // Sem o preload a conta voltaria do monitor pedindo login de novo: é ele
      // que grava o token salvo antes dos scripts do jogo rodarem.
      if (accountPreload) view.setAttribute('preload', accountPreload);
      view.src = gameUrl;
      panel.body.insertBefore(view, panel.body.firstChild);
      panel.view = view;
    } catch (e) {
      report('webview', e);
    }
  }

  /**
   * Descarta o renderer do jogo. É o que libera a memória: parar em
   * `about:blank` manteria o processo vivo.
   */
  function unloadGame(index) {
    const panel = panelOf(index);
    if (!panel || !panel.view) return;
    try {
      panel.view.remove();
    } catch (e) {
      report('webview', e);
    }
    panel.view = null;
  }

  function reloadGame(index) {
    if (ACTIVE.has(stateOf(index).status)) return;
    unloadGame(index);
    loadGame(index);
  }

  function applyPanelCount(count) {
    const total = Math.min(PER_TAB, Math.max(1, +count || 1));
    grid.dataset.panels = String(total);
    panels.forEach((panel, i) => {
      const shown = i < total;
      panel.root.hidden = !shown;
      // Painel escondido não deve custar um renderer nem manter sessão aberta.
      if (ACTIVE.has(stateOf(panel.account).status)) return;
      if (shown) loadGame(panel.account);
      else unloadGame(panel.account);
    });
    applyLayout();
  }

  // --------------------------------------------------------------- arranjos

  /**
   * Arruma os painéis já visíveis. Nunca mexe em quantos existem nem descarta
   * WebView: `solo` tira os outros painéis da vista, mas eles continuam
   * montados — o jogo segue rodando de fundo, que é o ponto do modo.
   *
   * `focus` com menos de dois painéis não tem faixa lateral para preencher, e
   * `solo` com um painel só já é a tela inteira: nos dois casos vira `split`.
   */
  function applyLayout() {
    const tab = tabPrefs(activeTab);
    const total = Math.min(PER_TAB, Math.max(1, +tab.panels || PER_TAB));
    const focus = Math.min(total - 1, Math.max(0, +tab.focus || 0));
    const mode = total < 2 && (tab.layout === 'focus' || tab.layout === 'solo') ? 'split' : tab.layout;

    grid.dataset.layout = mode;
    panels.forEach((panel, i) => {
      const shown = i < total;
      panel.root.classList.toggle('is-focus', shown && mode === 'focus' && i === focus);
      panel.root.classList.toggle('is-bg', shown && mode === 'solo' && i !== focus);
      panel.focusBtn.classList.toggle('is-on', shown && i === focus && mode !== 'split');
      panel.focusBtn.hidden = mode === 'split' || mode === 'cols' || mode === 'rows';
    });
  }

  /**
   * Clique no ⤢. Em `split`, `cols` e `rows` o botão não aparece, então isto só
   * chega vindo de `focus`/`solo`: escolhe quem é o painel grande.
   */
  async function focusPanel(slot) {
    const tab = tabPrefs(activeTab);
    if (tab.focus === slot) return;
    await saveTabPrefs({ focus: slot });
    applyLayout();
  }

  async function setLayout(mode) {
    if (!LAYOUTS.includes(mode)) return;
    await saveTabPrefs({ layout: mode });
    applyLayout();
  }

  // ------------------------------------------------------------------ headless

  function paintPanel(index) {
    const panel = panelOf(index);
    if (!panel) return;
    const entry = stateOf(index);
    const active = ACTIVE.has(entry.status);
    panel.root.classList.toggle('is-headless', active);
    panel.toggle.textContent = active ? 'Desligar' : 'Monitor';
    panel.toggle.classList.toggle('is-on', active);
    // Sem monitor o launcher não tem socket da conta: a troca de caçada se faz
    // no próprio jogo, na WebView.
    if (panel.huntBtn) {
      panel.huntBtn.disabled = !active;
      panel.huntBtn.title = active
        ? 'Trocar a caçada desta conta sem desligar o monitor'
        : 'Ligue o monitor para trocar a caçada daqui.';
    }
    panel.hud.setStatus(entry.status, entry.error);
  }

  /**
   * Papel da conta no grupo, do jeito que o seletor de caçada precisa: só o
   * líder recebe a troca, porque é ele que arrasta o grupo inteiro.
   */
  function partyRole(state) {
    const party = state && state.party;
    if (!party || !party.id) return { inParty: false, leader: false };
    const self = (party.members || []).find(m => m.self);
    return { inParty: true, leader: !!(self && self.leader) };
  }

  /**
   * Repinta o HUD. Sem painel (aba escondida) ou com a janela fora da tela só
   * guarda o estado: `getState()` traz o quadro completo, então o último
   * recebido basta quando a conta volta a aparecer.
   */
  function renderState(index, state) {
    if (!state) return;
    const entry = stateOf(index);
    if (state.name) entry.name = state.name;
    // Guardado mesmo sem painel visível: é o que o seletor de caçada lê para
    // mostrar o nível da conta e o mapa em que ela está.
    entry.level = +state.level || 0;
    entry.hunt = state.hunt || null;
    entry.party = partyRole(state);

    const panel = panelOf(index);
    if (!visible || !panel) {
      entry.pending = state;
      return;
    }
    entry.pending = null;
    panel.hud.update(state);
    if (state.name) panel.who.textContent = state.name;
  }

  function onVisibilityChange(next) {
    visible = !!next;
    if (!visible) return;
    for (const panel of panels) {
      const entry = stateOf(panel.account);
      if (entry.pending) renderState(panel.account, entry.pending);
    }
  }

  async function toggleHeadless(index) {
    const entry = stateOf(index);

    if (ACTIVE.has(entry.status)) {
      await api.levelingStop(index).catch(e => report('leveling:stop', e));
      entry.status = 'disconnected';
      entry.error = '';
      entry.pending = null;
      panelOf(index)?.hud.clear();
      paintPanel(index);
      loadGame(index);
      return;
    }

    try {
      const result = await api.levelingStart(index);
      if (result && result.ok === false) {
        panelOf(index)?.hud.setEnded(result.error);
        openAccounts();
        return;
      }
      // A WebView sai antes de qualquer coisa: duas sessões na mesma conta se
      // derrubam, e o renderer dela é justamente o custo que o monitor evita.
      unloadGame(index);
      entry.status = 'connecting';
      entry.error = '';
      paintPanel(index);
    } catch (e) {
      report('leveling:start', e);
    }
  }

  function subscribe() {
    api.onLevelingStatus(({ index, status, error }) => {
      const entry = stateOf(index);
      entry.status = status || 'disconnected';
      entry.error = error || '';
      paintPanel(index);
    });

    api.onLevelingUpdate(({ index, state }) => renderState(index, state));

    api.onLevelingEnded(({ index, code }) => {
      const entry = stateOf(index);
      entry.status = 'disconnected';
      entry.pending = null;
      panelOf(index)?.hud.setEnded(code);
      paintPanel(index);
      // `session.replaced` é o handoff normal: a conta volta para a WebView.
      loadGame(index);
    });

    // Compras do auto-refill. O modal pode estar fechado; `PioRefill` só guarda
    // o texto na barra de status, que é lida na próxima abertura.
    if (api.onLevelingRefill) {
      api.onLevelingRefill(data => window.PioRefill?.report(data));
    }

    // Etapas da montagem de grupo: ela passa por várias contas e leva alguns
    // segundos, então o botão narra em vez de só ficar desabilitado.
    if (api.onLevelingPartyStep) {
      api.onLevelingPartyStep(step => setPartyStatus(partyText(step), true));
    }

    if (api.onWindowVisible) api.onWindowVisible(onVisibilityChange);
  }

  // --------------------------------------------------------------- modal/barra

  const overlay = document.getElementById('levelingOverlay');
  let accountsReady = false;

  function openAccounts() {
    if (!overlay || !window.PioLeveling) return;
    if (!accountsReady) {
      window.PioLeveling.init({ tabs, activeTab });
      accountsReady = true;
    } else {
      window.PioLeveling.setTabs?.(tabs, activeTab);
      window.PioLeveling.refreshCreds();
      window.PioLeveling.refreshStatuses();
    }
    overlay.classList.add('show');
  }

  function closeAccounts() {
    overlay.classList.remove('show');
  }

  const refillOverlay = document.getElementById('refillOverlay');
  let refillReady = false;

  function openRefill() {
    if (!refillOverlay || !window.PioRefill) return;
    // Lido na primeira abertura: é uma configuração só, não muda sozinha.
    if (!refillReady) {
      refillReady = true;
      window.PioRefill.init().catch(e => report('refill', e));
    }
    refillOverlay.classList.add('show');
  }

  function closeRefill() {
    refillOverlay.classList.remove('show');
  }

  const huntOverlay = document.getElementById('huntOverlay');
  let huntReady = false;

  /**
   * Abre o seletor de caçada. `only` restringe a lista a uma conta — é o botão
   * 🗺️ do painel; sem ele a lista é a aba inteira, que é o botão da titlebar.
   *
   * A lista inclui contas sem monitor, desabilitadas: esconder faria parecer
   * que a conta não existe, quando o que falta é ligar o monitor nela.
   */
  function openHunt(only) {
    if (!huntOverlay || !window.PioHunt) return;
    if (!huntReady) {
      huntReady = true;
      window.PioHunt.init(api);
    }

    const alvos = panels
      .filter(panel => !panel.root.hidden)
      .filter(panel => !only || only.includes(panel.account))
      .map(panel => {
        const entry = stateOf(panel.account);
        return {
          index: panel.account,
          name: entry.name,
          level: entry.level,
          status: entry.status,
          hunt: entry.hunt,
          party: entry.party
        };
      });

    huntOverlay.classList.add('show');
    window.PioHunt.open(alvos).catch(e => report('hunt', e));
  }

  function closeHunt() {
    if (huntOverlay) huntOverlay.classList.remove('show');
  }

  // ------------------------------------------------------------------- grupo

  /**
   * Textos das etapas e das recusas da montagem de grupo. Os códigos de erro
   * vêm do servidor, medidos nas sondas de `tools/party-*-probe.js`.
   */
  const PARTY_TEXT = {
    'party.reading': () => 'Lendo o grupo atual…',
    'party.leaving': s => `${s.name || 'conta'} saindo do grupo antigo…`,
    'party.disbanding': s => `${s.name || 'conta'} desfazendo o grupo antigo…`,
    'party.creating': s => `${s.name || 'conta'} criando o grupo…`,
    'party.created': s => `Grupo criado${s.partyCode ? ' (código ' + s.partyCode + ')' : ''}.`,
    'party.inviting': s => `Convidando ${s.name || 'conta'}…`,
    'party.joined': s => `${s.name || 'conta'} entrou.`,
    'party.pulling': s => `Puxando o grupo para a caçada${s.gateId ? ' em ' + s.gateId : ''}…`
  };

  const PARTY_ERROR = {
    'party.busy': 'Já existe uma montagem de grupo em andamento.',
    'party.needTwo': 'Precisa de pelo menos duas contas desta aba em modo monitor.',
    'party.noHuntTicket': 'Grupo montado, mas a conta líder não estava em caçada: o grupo ficou na cidade. Inicie a caçada na líder.',
    'party.inviteNotReceived': 'o convite não chegou',
    'party.exists': 'a conta já está em outro grupo',
    'party.full': 'o grupo já está cheio',
    'party.none': 'a conta não está em grupo'
  };

  const partyText = step => {
    const fn = PARTY_TEXT[step.code];
    return fn ? fn(step) : step.code;
  };

  /** Mostra o andamento no próprio botão: é onde o usuário está olhando. */
  function setPartyStatus(text, busy) {
    const button = document.getElementById('partyBtn');
    if (!button) return;
    button.classList.toggle('is-on', !!busy);
    button.disabled = !!busy;
    button.title = text || button.dataset.title || '';
  }

  /**
   * Monta o grupo com as contas da aba atual que já têm monitor ativo. A conta
   * na WebView do jogo não entra: o launcher não tem socket dela, porque o
   * servidor aceita uma sessão por conta.
   */
  async function assembleParty() {
    const elegiveis = panels
      .filter(panel => !panel.root.hidden && ACTIVE.has(stateOf(panel.account).status))
      .map(panel => panel.account);

    if (elegiveis.length < 2) {
      setPartyStatus(PARTY_ERROR['party.needTwo'], false);
      window.alert(PARTY_ERROR['party.needTwo']);
      return;
    }

    setPartyStatus('Montando o grupo…', true);
    try {
      const result = await api.levelingAssembleParty(elegiveis);
      if (!result) throw new Error('sem resposta do processo principal');

      if (!result.partyId) {
        const motivo = PARTY_ERROR[result.error] || result.error || 'falhou';
        setPartyStatus('Grupo não foi criado: ' + motivo, false);
        window.alert('Não foi possível criar o grupo: ' + motivo);
        return;
      }

      const partes = [`Grupo de ${result.size} contas criado.`];
      if (result.code) partes.push(`Código: ${result.code}.`);
      if (result.failed && result.failed.length) {
        partes.push('Ficaram de fora: ' + result.failed
          .map(f => `${f.name} (${PARTY_ERROR[f.error] || f.error})`)
          .join(', ') + '.');
      }
      if (result.huntError) {
        partes.push(PARTY_ERROR[result.huntError] ||
          `A volta à caçada falhou (${result.huntError}): confira se as contas saíram da cidade.`);
      }

      const texto = partes.join(' ');
      setPartyStatus(texto, false);
      if (result.failed?.length || result.huntError) window.alert(texto);
    } catch (e) {
      report('party', e);
      setPartyStatus('Erro ao montar o grupo.', false);
    }
  }

  function wireTitlebar() {
    document.getElementById('appVer').textContent = api.appVersion ? 'v' + api.appVersion : '';

    document.getElementById('accountsBtn').onclick = openAccounts;
    document.getElementById('levelingCloseBtn').onclick = closeAccounts;
    document.getElementById('levelingClose').onclick = closeAccounts;
    overlay.onclick = e => { if (e.target === overlay) closeAccounts(); };
    const refillBtn = document.getElementById('refillBtn');
    if (refillBtn) refillBtn.onclick = openRefill;

    const partyBtn = document.getElementById('partyBtn');
    if (partyBtn) {
      // O título original volta junto com o botão: as mensagens de etapa o
      // sobrescrevem enquanto a montagem corre.
      partyBtn.dataset.title = partyBtn.title;
      partyBtn.onclick = () => assembleParty().catch(e => report('party', e));
    }
    if (refillOverlay) {
      document.getElementById('refillCloseBtn').onclick = closeRefill;
      document.getElementById('refillClose').onclick = closeRefill;
      refillOverlay.onclick = e => { if (e.target === refillOverlay) closeRefill(); };
    }

    // Troca de caçada da aba inteira. O botão do painel abre o mesmo modal com
    // uma conta só na lista.
    const huntBtn = document.getElementById('huntBtn');
    if (huntBtn) huntBtn.onclick = () => openHunt(null);
    if (huntOverlay) {
      document.getElementById('huntCloseBtn').onclick = closeHunt;
      document.getElementById('huntClose').onclick = closeHunt;
      huntOverlay.onclick = e => { if (e.target === huntOverlay) closeHunt(); };
    }

    window.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      // Do mais recente para o mais antigo: o seletor de caçada abre por cima.
      if (huntOverlay && huntOverlay.classList.contains('show')) {
        e.preventDefault();
        closeHunt();
      } else if (refillOverlay && refillOverlay.classList.contains('show')) {
        e.preventDefault();
        closeRefill();
      } else if (overlay.classList.contains('show')) {
        e.preventDefault();
        closeAccounts();
      }
    });

    document.getElementById('reloadAll').onclick = () => {
      for (const panel of panels) if (!panel.root.hidden) reloadGame(panel.account);
    };

    document.getElementById('errlogBtn').onclick = () => api.openErrorLog().catch(() => {});

    const awake = document.getElementById('awakeBtn');
    awake.onclick = async () => {
      prefs = await api.setPrefs({ keepAwake: !prefs.keepAwake }).catch(() => prefs);
      awake.classList.toggle('is-on', !!prefs.keepAwake);
    };

    const count = document.getElementById('panelCount');
    count.onchange = async () => {
      applyPanelCount(count.value);
      await saveTabPrefs({ panels: +count.value });
    };

    const layout = document.getElementById('layoutMode');
    if (layout) layout.onchange = () => setLayout(layout.value).catch(e => report('layout', e));

    const add = document.getElementById('tabAdd');
    if (add) add.onclick = () => setTabCount(tabs + 1).catch(e => report('tabs', e));

    // Remover a aba não apaga credencial nem derruba monitor: ela some da
    // barra e volta igual se for recriada.
    const remove = document.getElementById('tabRemove');
    if (remove) remove.onclick = () => setTabCount(tabs - 1).catch(e => report('tabs', e));

    // Abrir já em monitor: nenhum renderer do jogo é criado no boot. Vale por
    // aba, porque é a aba que define o uso daquele grupo de contas.
    const bootMonitor = document.getElementById('bootMonitorBtn');
    if (bootMonitor) {
      bootMonitor.onclick = async () => {
        await saveTabPrefs({ bootMonitor: !tabPrefs(activeTab).bootMonitor });
        bootMonitor.classList.toggle('is-on', !!tabPrefs(activeTab).bootMonitor);
      };
    }

    for (const [id, action] of [['winMin', 'minimize'], ['winMax', 'maximize'], ['winClose', 'close']]) {
      document.getElementById(id).onclick = () => api.windowControl(action).catch(() => {});
    }
  }

  async function boot() {
    buildPanels();
    wireTitlebar();
    subscribe();

    gameUrl = await api.gameUrl().catch(() => 'about:blank');
    accountPreload = await api.accountPreload?.().catch(() => '') || '';
    prefs = await api.getPrefs().catch(() => prefs);

    tabs = Math.min(MAX_TABS, Math.max(1, +prefs.tabs || 1));
    activeTab = Math.min(tabs - 1, Math.max(0, +prefs.activeTab || 0));
    buildTabs();

    document.getElementById('awakeBtn').classList.toggle('is-on', !!prefs.keepAwake);

    // Monitores que já estavam rodando antes do recarregamento da janela. São
    // lidos de todas as abas, não só da visível: eles não param ao trocar de
    // aba, e o estado é o que o HUD mostra quando a conta reaparece.
    const running = [];
    for (let i = 0; i < tabs * PER_TAB; i++) {
      const status = await api.levelingStatus(i).catch(() => null);
      if (!status || !ACTIVE.has(status.status)) continue;
      const entry = stateOf(i);
      entry.status = status.status;
      running.push({ index: i, state: status.state });
    }

    // Aponta os painéis para a aba salva, já com a contagem dela, antes de
    // qualquer WebView nascer.
    selectTab(activeTab);

    for (const { index, state } of running) {
      paintPanel(index);
      renderState(index, state);
    }

    // Boot em monitor: liga as contas com credencial sem passar pela WebView.
    if (tabPrefs(activeTab).bootMonitor) await startMonitors();
  }

  /** Liga o monitor em todas as contas visíveis que ainda não o têm. */
  async function startMonitors() {
    for (const panel of panels) {
      const index = panel.account;
      const entry = stateOf(index);
      if (panel.root.hidden || ACTIVE.has(entry.status)) continue;
      const result = await api.levelingStart(index).catch(e => {
        report('leveling:start', e);
        return null;
      });
      // Sem credencial a conta fica no jogo normal; não é erro de execução.
      if (!result || result.ok === false) continue;
      unloadGame(index);
      entry.status = 'connecting';
      entry.error = '';
      paintPanel(index);
    }
  }

  window.PioShell = {
    panels,
    accountState,
    get tabs() { return tabs; },
    get activeTab() { return activeTab; },
    get prefs() { return prefs; },
    tabPrefs,
    selectTab,
    setTabCount,
    applyPanelCount,
    applyLayout,
    setLayout,
    focusPanel,
    openAccounts,
    closeAccounts,
    openHunt,
    closeHunt,
    toggleHeadless,
    startMonitors,
    assembleParty,
    loadGame,
    unloadGame
  };

  if (api) boot().catch(e => report('boot', e));
})();
