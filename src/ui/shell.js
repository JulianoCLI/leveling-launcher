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
  const LAYOUTS = ['focus', 'solo', 'cols'];
  const api = window.pokeAPI;
  const ACTIVE = new Set(['connecting', 'connected', 'reconnecting']);

  /**
   * Fim de sessão em que a conta assumiu em outro lugar — a WebView volta. Os
   * outros códigos são queda: o monitor reconecta sozinho, e recriar a WebView
   * nesses casos tirava a conta do modo monitor depois de horas rodando.
   */
  const HANDOFF_CODES = new Set(['session.replaced', 'session.duplicate']);

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
  let closeAutomationMenu = () => {};

  /**
   * Quantos painéis e como eles se arranjam valem **por aba**: um grupo pode
   * estar jogando em quatro painéis enquanto outro usa um só. Ler da aba atual
   * é o que faz a escolha voltar ao trocar de aba.
   *
   * O boot em monitor não está aqui: ele é do launcher inteiro.
   */
  const tabPrefs = t => {
    const list = prefs.tabPrefs || (prefs.tabPrefs = []);
    if (!list[t]) list[t] = { panels: PER_TAB, layout: 'cols', focus: 0 };
    const tab = list[t];
    if (tab.layout === 'split' || tab.layout === 'rows' || !LAYOUTS.includes(tab.layout)) tab.layout = 'cols';
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
        level: 0, hunt: null, party: null,
        // A rota de saída da conta, vinda do pool de proxies. Fica aqui porque
        // decide se a WebView pode abrir, e a decisão não pode esperar o painel
        // estar visível.
        route: null, canOpen: null
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
          <span class="panel-route" data-role="route"></span>
          <button type="button" data-role="focus" title="Deixar este painel grande, com os demais ao lado">▣</button>
          <button type="button" data-role="solo" title="Deixar este painel em tela cheia">⛶</button>
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
        route: root.querySelector('[data-role="route"]'),
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
      panel.focusBtn.onclick = () => toggleFocus(panel.slot);
      panel.soloBtn = root.querySelector('[data-role="solo"]');
      panel.soloBtn.onclick = () => toggleSolo(panel.slot);
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
      paintRoute(panel.account);
      paintPanel(panel.account);
      // Um monitor que já estava rodando tem o quadro inteiro guardado.
      if (entry.pending) renderState(panel.account, entry.pending);
    }

    buildTabs();

    // A contagem de painéis e o arranjo passam a refletir a aba nova. O botão
    // de monitor não entra aqui: ele é do launcher, e não muda com a aba.
    const tab = tabPrefs(activeTab);
    const count = document.getElementById('panelCount');
    if (count) count.value = String(tab.panels);
    applyPanelCount(tab.panels);
    if (window.PioLeveling && window.PioLeveling.setTab) window.PioLeveling.setTab(activeTab);
  }

  /**
   * Muda o número de abas.
   *
   * `confirmar` só vale para remoção, e só vem do botão: remover apaga a
   * credencial e a sessão das contas que saem, e isso é destrutivo o bastante
   * para exigir um "sim". As chamadas internas (abrir espaço para um plano de
   * cadastro) só crescem, e nunca passam por aqui.
   */
  async function setTabCount(next, confirmar) {
    const target = Math.min(MAX_TABS, Math.max(1, next));
    if (target === tabs) return;

    if (target < tabs) {
      const primeira = target * PER_TAB;
      if (confirmar) {
        const comDados = [];
        for (let i = primeira; i < tabs * PER_TAB; i++) {
          const entry = accountState.get(i);
          if (entry && entry.name) comDados.push(`Conta ${i + 1}: ${entry.name}`);
        }
        const aviso = [
          `Remover ${tabs - target} aba(s) apaga as contas ${primeira + 1} a ${tabs * PER_TAB}.`,
          'Os dados serão apagados: usuário, senha, token de sessão e o login guardado no navegador.',
          comDados.length ? 'Contas com login agora:\n' + comDados.join('\n') : '',
          'A conta 1 nunca é apagada. Confirmar?'
        ].filter(Boolean).join('\n\n');
        if (!window.confirm(aviso)) return;
      }

      // Desligar antes de apagar: um monitor rodando com credencial que já não
      // existe ficaria tentando reconectar sem nada para usar.
      for (let i = primeira; i < tabs * PER_TAB; i++) {
        if (ACTIVE.has(stateOf(i).status)) {
          await api.levelingStop(i).catch(e => report('leveling:stop', e));
        }
        accountState.delete(i);
      }

      if (confirmar && api.levelingClearCredsFrom) {
        // `Math.max(1, ...)` é redundante com a guarda do principal, e está
        // aqui porque a regra "a conta 1 fica" não deve depender de um lado só.
        await api.levelingClearCredsFrom(Math.max(1, primeira))
          .catch(e => report('creds:clear-from', e));
        if (window.PioLeveling) window.PioLeveling.refreshCreds?.();
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

  /**
   * A rota de saída, ao lado do nome da conta.
   *
   * Existe para a pergunta "por qual IP esta conta está saindo?" ter resposta
   * na tela, e não só no pool: é com ela que se nota duas contas no mesmo
   * endereço antes de o servidor recusar com `session.multi_account_ip`.
   */
  function paintRoute(index) {
    const panel = panelOf(index);
    if (!panel || !panel.route) return;
    const rota = stateOf(index).route;

    if (!rota) {
      panel.route.textContent = '';
      panel.route.className = 'panel-route';
      panel.route.title = '';
      return;
    }

    // O IP é o que importa quando existe: é ele que o servidor vê. O rótulo do
    // proxy é o host, útil para achar a linha no pool.
    const texto = rota.kind === 'proxy'
      ? (rota.ip ? `${rota.ip} · ${rota.label}` : rota.label)
      : rota.label;

    panel.route.textContent = texto;
    panel.route.className = 'panel-route'
      + (rota.kind === 'local' ? ' is-local' : '')
      + (rota.ok ? '' : ' is-warn');
    panel.route.title = rota.kind === 'proxy'
      ? (rota.ok
        ? `Esta conta sai pelo proxy ${rota.label}${rota.ip ? ` (IP ${rota.ip})` : ''}.`
        : `O proxy ${rota.label} está com status "${rota.status}": teste-o no pool.`)
      : rota.kind === 'local'
        ? 'Esta conta sai pelo IP da máquina. Só as duas primeiras contas podem.'
        : 'Sem proxy atribuído: esta conta não abre até o pool ter um proxy funcional.';
  }

  /**
   * O painel de uma conta que não pode abrir. Diz o que falta, no lugar onde a
   * WebView estaria — um painel vazio deixaria o usuário recarregando à toa.
   */
  function paintBlocked(index, motivo) {
    const panel = panelOf(index);
    if (!panel) return;
    unloadGame(index);

    let aviso = panel.body.querySelector('[data-role="blocked"]');
    if (!aviso) {
      aviso = document.createElement('div');
      aviso.dataset.role = 'blocked';
      aviso.className = 'panel-blocked';
      panel.body.appendChild(aviso);
    }
    aviso.textContent = '';

    const titulo = document.createElement('strong');
    titulo.textContent = `Conta ${index + 1} bloqueada`;
    const texto = document.createElement('p');
    texto.textContent = motivo || 'sem rota de saída.';
    const dica = document.createElement('p');
    dica.className = 'panel-blocked-hint';
    dica.textContent = 'Importe e teste um proxy no pool: cada proxy aprovado abre duas contas.';

    const botao = document.createElement('button');
    botao.type = 'button';
    botao.textContent = 'Gerenciar proxies';
    botao.onclick = () => {
      try {
        const r = api.proxiesWindow && api.proxiesWindow();
        if (r && typeof r.catch === 'function') r.catch(e => report('proxies:window', e));
      } catch (e) {
        report('proxies:window', e);
      }
    };

    aviso.append(titulo, texto, dica, botao);
  }

  /** Tira o aviso de bloqueio, quando a conta ganha rota. */
  function clearBlocked(index) {
    const panel = panelOf(index);
    const aviso = panel && panel.body.querySelector('[data-role="blocked"]');
    if (aviso) aviso.remove();
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

    /*
     * Sem rota, sem jogo. Só as duas primeiras contas saem pelo IP da máquina;
     * as outras só abrem com um proxy que passou no teste.
     *
     * A WebView é o caminho silencioso: ela carregava o jogo pelo IP local sem
     * pedir nada a ninguém, e o servidor respondia `session.multi_account_ip` —
     * ou pior, aceitava e deixava duas contas no mesmo endereço. O painel passa
     * a explicar o que falta em vez de carregar.
     */
    const porta = stateOf(index).canOpen;
    if (porta && porta.ok === false) {
      paintBlocked(index, porta.motivo);
      return;
    }

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

  /**
   * Aguarda a composição liberar o WebView anterior antes de montar outro.
   * Destruir e recriar um renderer WebGL no mesmo frame deixa o compositor
   * disputando o surface antigo, especialmente ao sair do modo monitor.
   */
  function waitForRendererRelease() {
    return new Promise(resolve => {
      let frames = 0;
      const next = () => {
        frames++;
        if (frames >= 2) resolve();
        else if (typeof requestAnimationFrame === 'function') requestAnimationFrame(next);
        else setTimeout(next, 16);
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(next);
      else setTimeout(next, 16);
    });
  }

  function applyPanelCount(count) {
    const total = Math.min(PER_TAB, Math.max(1, +count || 1));
    grid.dataset.panels = String(total);
    grid.style.setProperty('--panel-count', String(total));
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
    const mode = total < 2 && (tab.layout === 'focus' || tab.layout === 'solo') ? 'cols' : tab.layout;

    grid.dataset.layout = mode;
    panels.forEach((panel, i) => {
      const shown = i < total;
      panel.root.classList.toggle('is-focus', shown && mode === 'focus' && i === focus);
      panel.root.classList.toggle('is-bg', shown && mode === 'solo' && i !== focus);
      panel.focusBtn.classList.toggle('is-on', shown && i === focus && mode === 'focus');
      panel.soloBtn.classList.toggle('is-on', shown && i === focus && mode === 'solo');
    });
  }

  async function toggleFocus(slot) {
    const tab = tabPrefs(activeTab);
    await saveTabPrefs({ layout: tab.layout === 'focus' && tab.focus === slot ? 'cols' : 'focus', focus: slot });
    applyLayout();
  }

  async function toggleSolo(slot) {
    const tab = tabPrefs(activeTab);
    await saveTabPrefs({ layout: tab.layout === 'solo' && tab.focus === slot ? 'cols' : 'solo', focus: slot });
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
      await waitForRendererRelease();
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

    api.onLevelingEnded(({ index, code, handoff }) => {
      const entry = stateOf(index);
      entry.pending = null;
      // O processo principal informa `handoff`; o código é o fallback.
      const assumida = handoff === undefined ? HANDOFF_CODES.has(code) : !!handoff;
      panelOf(index)?.hud.setEnded(code, assumida);

      // Só o handoff devolve a conta ao navegador: ela assumiu em outro lugar e
      // o monitor cedeu de vez. Numa queda de sessão o monitor reconecta
      // sozinho, e criar a WebView aqui faria o renderer brigar pela sessão —
      // era isto que tirava a conta do modo monitor depois de horas.
      if (assumida) {
        entry.status = 'disconnected';
        paintPanel(index);
        loadGame(index);
        return;
      }

      // Reconectando: o status real chega pelo `onLevelingStatus` seguinte.
      entry.status = 'reconnecting';
      paintPanel(index);
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

    if (api.onSignupReady) {
      api.onSignupReady(saved => openSignupTabs(saved).catch(e => report('signup:ready', e)));
    }

    if (api.onSignupMonitor) api.onSignupMonitor(data => onSignupMonitor(data || {}));

    if (api.onWindowVisible) api.onWindowVisible(onVisibilityChange);
  }

  /**
   * Abre uma janela de cadastro por conta reservada.
   *
   * A janela roda na partição da própria conta, então ela já sai pelo proxy
   * dela e o login que o cadastro gravar fica exatamente onde a WebView do
   * painel vai procurar. Terminado o cadastro, o principal fecha a janela e
   * avisa por `onSignupDone`, e o painel recarrega já logado.
   *
   * Por isso aqui não se troca de aba nem se mexe em painel: a conta não
   * precisa estar visível para ser cadastrada. O painel só é tocado no fim,
   * quando há sessão para mostrar.
   */
  async function openSignupTabs(saved) {
    const lista = Array.isArray(saved) ? saved.filter(s => s && s.index >= 0) : [];
    if (!lista.length) return;

    // A barra acompanha a capacidade que o principal abriu, senão a conta
    // existe em credencial e não tem painel onde aparecer depois.
    const precisa = Math.floor(Math.max(...lista.map(s => s.index)) / PER_TAB) + 1;
    if (precisa > tabs) await setTabCount(precisa);

    for (const s of lista) {
      const r = await api.levelingSignupTab?.(s.index).catch(e => {
        report('signup:tab', e);
        return null;
      });
      if (r && r.ok === false) {
        window.alert(`Não foi possível abrir o cadastro da conta ${s.index + 1}: ${r.error || 'erro'}`);
      }
    }

    const semProxy = lista.filter(s => !s.proxy).map(s => s.username);
    if (semProxy.length) {
      window.alert(
        `Sem proxy livre no pool para: ${semProxy.join(', ')}.\n\n`
        + 'Essas contas vão sair pelo IP da máquina, e o servidor recusa duas contas no mesmo IP. '
        + 'Importe proxies antes de concluir o cadastro.'
      );
    }
  }

  /**
   * O cadastro terminou e o processo principal já ligou o monitor da conta.
   *
   * A WebView **não** é recriada: ela brigaria com o monitor pela única sessão
   * que o servidor permite por conta. Só o HUD é pintado, e o painel passa a
   * mostrar a caçada em vez do jogo.
   */
  function onSignupMonitor({ index }) {
    const entry = stateOf(index);
    entry.status = 'connecting';
    entry.error = '';
    unloadGame(index);
    paintPanel(index);
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

  const marketOverlay = document.getElementById('marketOverlay');
  let marketReady = false;

  /**
   * Preços do mercado. Não recebe contas: o feed de vendas é global e o banco
   * é um só para o launcher inteiro — não há o que selecionar.
   *
   * Abre em janela própria. A tela serve para comparar preço *enquanto* se
   * decide o que vender no jogo, e como modal ela cobria os painéis: era
   * preciso fechá-la para olhar o inventário, e então o preço sumia. Janela de
   * verdade dá para pôr ao lado, ou no outro monitor, e clicar no jogo sem que
   * ela desapareça.
   *
   * O modal continua no documento e é o caminho de reserva: se a janela não
   * puder ser criada, a tela ainda abre — ruim de usar é melhor que ausente.
   */
  function openMarket() {
    if (api.marketWindow) {
      api.marketWindow().then(ok => { if (!ok) openMarketModal(); })
        .catch(() => openMarketModal());
      return;
    }
    openMarketModal();
  }

  function openMarketModal() {
    if (!marketOverlay || !window.PioMarket) return;
    if (!marketReady) {
      marketReady = true;
      window.PioMarket.init(api);
    }
    marketOverlay.classList.add('show');
    window.PioMarket.open().catch(e => report('market', e));
  }

  function closeMarket() {
    if (marketOverlay) marketOverlay.classList.remove('show');
  }

  /**
   * Sniper de mercado. Só janela própria, sem modal de reserva: o log existe
   * para ser lido *enquanto* o jogo está na frente — é lá que o item chega —, e
   * um modal sobre o launcher cobriria justamente isso. Sem a janela, a tela
   * não teria para que servir.
   */
  function openSniper() {
    if (!api.sniperWindow) return;
    api.sniperWindow().catch(e => report('sniper', e));
  }

  /**
   * Auto-expedição. Janela própria, pelo mesmo motivo do sniper: a tela diz
   * quando cada conta volta a ter sombra livre, e esse prazo se consulta
   * enquanto o jogo está na frente. Sem modal de reserva — um prazo de horas
   * coberto pelos painéis não serviria para nada.
   */
  function openExpedition() {
    if (!api.expeditionWindow) return;
    api.expeditionWindow().catch(e => report('expedition', e));
  }

  /**
   * Auto-boss diário. Janela própria pela mesma razão: a tela diz quais bosses
   * saíram hoje em cada conta, e isso se consulta com o jogo na frente.
   */
  function openBoss() {
    if (!api.bossWindow) return;
    api.bossWindow().catch(e => report('boss', e));
  }

  /**
   * Auto-anunciar. Janela própria, e aqui o motivo é mais forte que nos outros:
   * é a única automação que **vende** item, e a conferência do preço anunciado
   * contra o mercado do jogo é exatamente o que um modal sobre os painéis
   * impediria.
   */
  function openAutosell() {
    if (!api.autosellWindow) return;
    api.autosellWindow().catch(e => report('autosell', e));
  }

  /**
   * Câmbio. Janela própria, com o motivo mais forte da série: é a única
   * automação que **move ouro entre contas**, e conferir os saldos nos painéis
   * contra o relatório é exatamente o que um modal cobriria.
   */
  function openCambio() {
    if (!api.cambioWindow) return;
    api.cambioWindow().catch(e => report('cambio', e));
  }

  /**
   * Status. Janela própria: a tela tem uma linha por conta, com a build e a
   * prévia da divisão de cada uma, e como modal cobriria o painel que mostra o
   * nível e os pontos parados — o que o usuário confere antes de ligar.
   */
  function openStats() {
    if (!api.statsWindow) return;
    api.statsWindow().catch(e => report('stats', e));
  }

  /**
   * Forja. Janela propria, e aqui o motivo e o mais forte da serie: a tela tem
   * uma grade de onze slots por conta, e ela e a conferencia que o usuario faz
   * antes de autorizar o launcher a destruir pecas de equipamento.
   */
  function openForge() {
    if (!api.forgeWindow) return;
    api.forgeWindow().catch(e => report('forge', e));
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
    'party.invite.already': 'já havia um convite pendente que o servidor não soltou',
    'party.join.level_range': 'o nível da conta está fora da faixa aceita pelo grupo',
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

    const marketBtn = document.getElementById('marketBtn');
    if (marketBtn) marketBtn.onclick = () => openMarket();

    // Proxies e Cadastro
    const proxiesBtn = document.getElementById('proxiesBtn');
    if (proxiesBtn) proxiesBtn.onclick = () => api.proxiesWindow?.().catch(e => report('proxies', e));
    const signupBtn = document.getElementById('signupBtn');
    if (signupBtn) signupBtn.onclick = () => api.signupWindow?.().catch(e => report('signup', e));

    const sniperBtn = document.getElementById('sniperBtn');
    if (sniperBtn) sniperBtn.onclick = () => openSniper();
    const expeditionBtn = document.getElementById('expeditionBtn');
    if (expeditionBtn) expeditionBtn.onclick = () => openExpedition();

    const bossBtn = document.getElementById('bossBtn');
    if (bossBtn) bossBtn.onclick = () => openBoss();
    const autosellBtn = document.getElementById('autosellBtn');
    if (autosellBtn) autosellBtn.onclick = () => openAutosell();
    const cambioBtn = document.getElementById('cambioBtn');
    if (cambioBtn) cambioBtn.onclick = () => openCambio();

    const statsBtn = document.getElementById('statsBtn');
    if (statsBtn) statsBtn.onclick = () => openStats();
    const forgeBtn = document.getElementById('forgeBtn');
    if (forgeBtn) forgeBtn.onclick = () => openForge();
    const othersBtn = document.getElementById('othersBtn');
    if (othersBtn) othersBtn.onclick = () => api.othersWindow && api.othersWindow();

    const automationBtn = document.getElementById('automationBtn');
    const automationItems = document.getElementById('automationItems');
    const automationMenu = document.getElementById('automationMenu');
    if (automationBtn && automationItems) {
      closeAutomationMenu = () => {
        automationItems.hidden = true;
        automationBtn.setAttribute('aria-expanded', 'false');
      };
      automationBtn.onclick = e => {
        e.stopPropagation();
        automationItems.hidden = !automationItems.hidden;
        automationBtn.setAttribute('aria-expanded', String(!automationItems.hidden));
      };
      automationItems.addEventListener('click', closeAutomationMenu);
      document.addEventListener('click', e => {
        if (!automationMenu?.contains(e.target)) closeAutomationMenu();
      });
    }
    if (marketOverlay) {
      document.getElementById('marketCloseBtn').onclick = closeMarket;
      document.getElementById('marketClose').onclick = closeMarket;
      marketOverlay.onclick = e => { if (e.target === marketOverlay) closeMarket(); };
    }

    window.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (!document.getElementById('automationItems')?.hidden) {
        e.preventDefault();
        closeAutomationMenu();
        return;
      }
      // Do mais recente para o mais antigo: o seletor de caçada abre por cima.
      if (marketOverlay && marketOverlay.classList.contains('show')) {
        e.preventDefault();
        closeMarket();
      } else if (huntOverlay && huntOverlay.classList.contains('show')) {
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

    const add = document.getElementById('tabAdd');
    if (add) add.onclick = () => setTabCount(tabs + 1).catch(e => report('tabs', e));

    // Remover a aba **apaga** as credenciais e a sessão das contas que saem,
    // então passa por confirmação. Sem isso, recriar a aba traria de volta um
    // login que o usuário achava que tinha ido embora.
    const remove = document.getElementById('tabRemove');
    if (remove) remove.onclick = () => setTabCount(tabs - 1, true).catch(e => report('tabs', e));

    // Abrir já em monitor: nenhum renderer do jogo é criado no boot. Vale para
    // o launcher inteiro — por aba, o botão gravava só na aba visível, e as
    // outras ficavam no modo normal esperando uma visita.
    const bootMonitor = document.getElementById('bootMonitorBtn');
    if (bootMonitor) {
      bootMonitor.onclick = async () => {
        const next = !prefs.bootMonitor;
        prefs = await api.setPrefs({ bootMonitor: next }).catch(() => prefs);
        bootMonitor.classList.toggle('is-on', !!prefs.bootMonitor);
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
    const bootBtn = document.getElementById('bootMonitorBtn');
    if (bootBtn) bootBtn.classList.toggle('is-on', !!prefs.bootMonitor);

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
    //
    // Percorre **todas** as abas, não só a visível. O monitor não depende de
    // painel pintado — uma conta de aba escondida conecta e farma igual —, e
    // olhar só a aba ativa deixava as outras esperando uma visita do usuário
    // para ligar, que é o oposto de "no início".
    if (prefs.bootMonitor) {
      for (let t = 0; t < tabs; t++) await startMonitors(t);
    }
  }

  /**
   * Liga o monitor nas contas de uma aba que ainda não o têm.
   *
   * Sem argumento é a aba visível, que é o caso do botão. O recorte é a
   * contagem de painéis **daquela** aba: painel escondido não deve conectar,
   * nem na aba que está na tela nem nas outras.
   */
  async function startMonitors(tab = activeTab) {
    const tabConfig = tabPrefs(tab);
    const total = Math.min(PER_TAB, Math.max(1, +tabConfig.panels || 1));

    for (let slot = 0; slot < total; slot++) {
      const index = tab * PER_TAB + slot;
      const entry = stateOf(index);
      if (ACTIVE.has(entry.status)) continue;
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

  /**
   * Recebe as rotas do pool e decide o que cada painel mostra.
   *
   * O shell é quem cria as WebViews, então é aqui que a regra "sem proxy, sem
   * view" tem efeito: uma conta que perdeu a rota tem a view descartada na
   * hora, e não na próxima vez que alguém trocar de aba.
   */
  function applyRoutes(contas) {
    const lista = Array.isArray(contas) ? contas : [];
    lista.forEach((conta, index) => {
      if (!conta) return;
      const entry = stateOf(index);
      entry.route = conta.route || null;
      entry.canOpen = conta.canOpen || null;
      paintRoute(index);

      const bloqueada = entry.canOpen && entry.canOpen.ok === false;
      if (bloqueada) {
        // Nem monitor nem WebView: a rota é condição das duas, e deixar a view
        // viva seria manter a conta saindo pelo IP errado.
        if (!ACTIVE.has(entry.status)) paintBlocked(index, entry.canOpen.motivo);
      } else {
        clearBlocked(index);
        // Ganhou rota: a view volta, se a conta não está no monitor.
        if (!ACTIVE.has(entry.status)) loadGame(index);
      }
    });
  }

  window.PioShell = {
    panels,
    accountState,
    applyRoutes,
    get tabs() { return tabs; },
    get activeTab() { return activeTab; },
    get prefs() { return prefs; },
    tabPrefs,
    selectTab,
    setTabCount,
    applyPanelCount,
    applyLayout,
    openAccounts,
    closeAccounts,
    openHunt,
    closeHunt,
    openMarket,
    closeMarket,
    openSniper,
    toggleHeadless,
    startMonitors,
    openSignupTabs,
    onSignupMonitor,
    assembleParty,
    loadGame,
    unloadGame
  };

  if (api) boot().catch(e => report('boot', e));
})();
