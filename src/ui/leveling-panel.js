/**
 * @file leveling-panel.js
 * Modal de contas do Leveling Idle 2D.
 *
 * Duas tarefas: guardar credenciais (que nunca voltam do processo principal,
 * só os indicadores `hasPassword`/`hasToken`) e ligar/desligar o monitor
 * headless, que é somente leitura.
 *
 * Como o jogo aceita uma sessão por conta, ligar o monitor derruba a WebView e
 * entrar pela WebView derruba o monitor. O segundo caso chega como
 * `session.replaced`, e aqui ele vira texto, não tentativa de reconexão.
 *
 * O modal segue as mesmas abas da grade: quatro cartões por vez, numerados
 * pelo índice global da conta. Renderizar só a aba visível é o que mantém o
 * modal barato com dezenas de contas.
 */

(() => {
  'use strict';

  /** Contas por aba. O modal mostra exatamente um grupo destes. */
  const ACCOUNTS = 4;

  const STATUS_TEXT = {
    disconnected: 'Desligado',
    connecting: 'Conectando',
    connected: 'Monitorando',
    reconnecting: 'Reconectando',
    error: 'Erro'
  };

  const STATUS_CLASS = {
    connected: 'is-connected',
    connecting: 'is-working',
    reconnecting: 'is-working',
    error: 'is-error'
  };

  /** Mensagens de erro do servidor em português, para não vazar código cru. */
  const ERROR_TEXT = {
    'ratelimit.login': 'Muitas tentativas de login; aguardando o servidor liberar',
    'ratelimit.auth': 'Muitas tentativas de login; aguardando o servidor liberar',
    'account.invalid_credentials': 'Usuário ou senha incorretos',
    'session.replaced': 'Sessão assumida em outro lugar',
    'session.duplicate': 'Sessão assumida em outro lugar',
    'session.expired': 'Sessão expirada'
  };

  function describeError(code) {
    if (!code) return '';
    return ERROR_TEXT[code] || code;
  }

  function emptyAccount() {
    return {
      username: '',
      hasPassword: false,
      hasToken: false,
      /** Rota de saída, já sem a senha do proxy. */
      proxy: '',
      status: 'disconnected',
      error: '',
      ended: '',
      state: null
    };
  }

  const PioLeveling = {
    /** Estado por conta, indexado globalmente: a aba só escolhe a fatia visível. */
    accounts: Array.from({ length: ACCOUNTS }, emptyAccount),
    encrypted: true,
    tabs: 1,
    activeTab: 0,

    get api() {
      return typeof window !== 'undefined' ? window.pokeAPI : null;
    },

    init(options = {}) {
      this.root = options.root || document.getElementById('levelingAccounts');
      this.statusBar = options.statusBar || document.getElementById('levelingStatusBar');
      this.tabsRoot = options.tabsRoot !== undefined
        ? options.tabsRoot
        : document.getElementById('levelingTabs');
      if (!this.root) return;

      this.tabs = Math.max(1, +options.tabs || 1);
      this.activeTab = Math.min(this.tabs - 1, Math.max(0, +options.activeTab || 0));
      this.grow(this.tabs * ACCOUNTS);

      this.renderTabs();
      this.render();
      this.refreshCreds();
      this.refreshStatuses();
      this.subscribe();
    },

    /** Índice global da conta do cartão `slot` da aba atual. */
    accountIndex(slot) {
      return this.activeTab * ACCOUNTS + slot;
    },

    grow(total) {
      while (this.accounts.length < total) this.accounts.push(emptyAccount());
    },

    /** Muda o número de abas; a grade manda, o modal acompanha. */
    setTabs(tabs, activeTab) {
      this.tabs = Math.max(1, +tabs || 1);
      this.grow(this.tabs * ACCOUNTS);
      this.setTab(activeTab === undefined ? this.activeTab : activeTab);
    },

    setTab(tab) {
      if (!this.root) return;
      this.activeTab = Math.min(this.tabs - 1, Math.max(0, +tab || 0));
      this.renderTabs();
      this.render();
    },

    renderTabs() {
      if (!this.tabsRoot) return;
      this.tabsRoot.innerHTML = Array.from({ length: this.tabs }, (_, t) => {
        const first = t * ACCOUNTS + 1;
        return `<button type="button" role="tab" class="lv-tab" data-tab="${t}"
          aria-selected="${t === this.activeTab}">${first}–${first + ACCOUNTS - 1}</button>`;
      }).join('');
      for (const button of this.tabsRoot.querySelectorAll('.lv-tab')) {
        button.onclick = () => this.setTab(+button.dataset.tab);
      }
    },

    subscribe() {
      const api = this.api;
      if (!api) return;

      if (typeof api.onLevelingStatus === 'function') {
        api.onLevelingStatus(({ index, status, error }) => {
          const acc = this.accounts[index];
          if (!acc) return;
          acc.status = status || 'disconnected';
          acc.error = error || '';
          // Status novo invalida o motivo do encerramento anterior.
          if (status === 'connecting' || status === 'connected') acc.ended = '';
          this.paint(index);
        });
      }

      if (typeof api.onLevelingUpdate === 'function') {
        api.onLevelingUpdate(({ index, state }) => {
          const acc = this.accounts[index];
          if (!acc) return;
          acc.state = state;
          if (state && state.name) acc.username = state.name;
          this.paintMeta(index);
        });
      }

      if (typeof api.onLevelingEnded === 'function') {
        api.onLevelingEnded(({ index, code }) => {
          const acc = this.accounts[index];
          if (!acc) return;
          acc.ended = code || '';
          acc.status = 'disconnected';
          this.paint(index);
        });
      }

      if (typeof api.onLevelingDeath === 'function') {
        api.onLevelingDeath(({ index }) => {
          this.say(`Conta ${index + 1}: morreu na caçada. O revive automático do servidor cuida disso.`);
        });
      }
    },

    async refreshCreds() {
      const api = this.api;
      if (!api || typeof api.levelingGetCreds !== 'function') return;
      try {
        const status = await api.levelingGetCreds();
        this.applyCreds(status);
      } catch {
        this.say('Não foi possível ler as credenciais salvas.');
      }
    },

    /** O processo principal só devolve indicadores; a senha nunca chega aqui. */
    applyCreds(status) {
      if (!status) return;
      this.encrypted = status.encrypted !== false;
      this.grow((status.accounts || []).length);
      (status.accounts || []).forEach((entry, i) => {
        const acc = this.accounts[i];
        if (!acc) return;
        acc.username = entry.username || '';
        acc.hasPassword = !!entry.hasPassword;
        acc.hasToken = !!entry.hasToken;
        acc.proxy = entry.proxy || '';
      });
      for (let i = 0; i < this.accounts.length; i++) this.paint(i);
      if (!this.encrypted) {
        this.say('Atenção: o armazenamento seguro do sistema não está disponível; as senhas ficam em texto no disco.');
      }
    },

    async refreshStatuses() {
      const api = this.api;
      if (!api || typeof api.levelingStatus !== 'function') return;
      // Todas as contas, não só a aba aberta: o monitor de uma aba escondida
      // segue rodando e o estado dele precisa estar pronto na troca.
      for (let i = 0; i < this.accounts.length; i++) {
        try {
          const status = await api.levelingStatus(i);
          const acc = this.accounts[i];
          if (!status || !acc) continue;
          acc.status = status.status || 'disconnected';
          acc.error = status.error || '';
          acc.ended = status.ended || '';
          acc.state = status.state || null;
          this.paint(i);
        } catch {
          // Modal aberto antes do processo principal responder: tudo bem.
        }
      }
    },

    render() {
      this.root.innerHTML = Array.from({ length: ACCOUNTS }, (_, slot) => {
        const i = this.accountIndex(slot);
        return `
        <div class="lv-account" data-index="${i}">
          <div class="lv-account-head">
            <span class="lv-account-title">Conta ${i + 1}</span>
            <span class="lv-pill" data-role="pill">Desligado</span>
          </div>
          <div class="lv-fields">
            <input type="text" data-role="user" placeholder="Usuário" autocomplete="off" spellcheck="false">
            <input type="password" data-role="pass" placeholder="Senha" autocomplete="off">
            <button type="button" data-role="save">Salvar</button>
            <button type="button" data-role="toggle" class="primary">Ativar monitor</button>
          </div>
          <div class="lv-fields lv-fields-proxy">
            <input type="text" data-role="proxy" autocomplete="off" spellcheck="false"
              placeholder="Proxy (vazio = meu IP)"
              title="host:porta, host:porta:usuario:senha ou uma URL completa (http://, socks5://)">
            <button type="button" data-role="saveProxy">Aplicar rota</button>
          </div>
          <div class="lv-account-meta" data-role="meta"></div>
        </div>
      `;
      }).join('');

      for (let slot = 0; slot < ACCOUNTS; slot++) {
        const i = this.accountIndex(slot);
        const card = this.card(i);
        if (!card) continue;
        card.querySelector('[data-role="save"]').onclick = () => this.save(i);
        card.querySelector('[data-role="saveProxy"]').onclick = () => this.saveProxy(i);
        card.querySelector('[data-role="proxy"]').onkeydown = e => {
          if (e.key === 'Enter') this.saveProxy(i);
        };
        card.querySelector('[data-role="toggle"]').onclick = () => this.toggle(i);
        // Enter no campo de senha salva, que é o fluxo esperado.
        card.querySelector('[data-role="pass"]').onkeydown = e => {
          if (e.key === 'Enter') this.save(i);
        };
        this.paint(i);
      }
    },

    card(index) {
      return this.root.querySelector(`.lv-account[data-index="${index}"]`);
    },

    paint(index) {
      const card = this.card(index);
      const acc = this.accounts[index];
      if (!card || !acc) return;

      const active = acc.status === 'connected' || acc.status === 'connecting' || acc.status === 'reconnecting';

      const pill = card.querySelector('[data-role="pill"]');
      pill.className = 'lv-pill ' + (STATUS_CLASS[acc.status] || '');
      pill.textContent = STATUS_TEXT[acc.status] || acc.status;

      const user = card.querySelector('[data-role="user"]');
      // Não sobrescreve o que o usuário está digitando.
      if (document.activeElement !== user) user.value = acc.username;
      user.disabled = active;

      const pass = card.querySelector('[data-role="pass"]');
      pass.disabled = active;
      pass.placeholder = acc.hasPassword ? 'Senha salva (deixe em branco)' : 'Senha';

      card.querySelector('[data-role="save"]').disabled = active;

      const proxy = card.querySelector('[data-role="proxy"]');
      // A senha do proxy nunca volta do principal, então o campo mostra só a
      // rota; reescrever tudo é o jeito de trocá-la.
      if (document.activeElement !== proxy) proxy.value = acc.proxy;

      const toggle = card.querySelector('[data-role="toggle"]');
      toggle.textContent = active ? 'Desligar monitor' : 'Ativar monitor';
      toggle.classList.toggle('is-on', active);
      toggle.classList.toggle('primary', !active);
      toggle.disabled = !active && !acc.hasPassword;
      toggle.title = toggle.disabled ? 'Salve usuário e senha antes de ativar.' : '';

      this.paintMeta(index);
    },

    /** Linha de detalhe: erro, motivo do encerramento ou telemetria da caçada. */
    paintMeta(index) {
      const card = this.card(index);
      const acc = this.accounts[index];
      if (!card || !acc) return;
      const meta = card.querySelector('[data-role="meta"]');

      if (acc.error) {
        meta.textContent = describeError(acc.error);
        return;
      }
      if (acc.ended) {
        meta.textContent = acc.ended === 'session.replaced' || acc.ended === 'session.duplicate'
          ? 'Sessão assumida em outro lugar — a conta voltou para o navegador.'
          : `Sessão encerrada: ${describeError(acc.ended)}`;
        return;
      }

      const state = acc.state;
      if (acc.status === 'connected' && state) {
        const fmt = window.PioHudMetrics ? window.PioHudMetrics.format : null;
        const compact = fmt ? fmt.compact : (n => String(+n || 0));
        const hunt = state.hunt || {};
        const rates = state.a || {};
        meta.textContent = [
          state.level ? `Nv ${state.level}` : '',
          hunt.gateId ? hunt.gateId.replace(/[_-]+/g, ' ') : '',
          hunt.kills ? `${compact(hunt.kills)} abates` : '',
          rates.xph ? `${compact(rates.xph)} xp/h` : ''
        ].filter(Boolean).join(' · ');
        return;
      }

      meta.textContent = acc.hasToken ? 'Token salvo; reconecta sem novo login.' : '';
    },

    async save(index) {
      const api = this.api;
      const card = this.card(index);
      if (!api || !card || typeof api.levelingSetCreds !== 'function') return;

      const username = card.querySelector('[data-role="user"]').value.trim();
      const passField = card.querySelector('[data-role="pass"]');
      const password = passField.value;
      const acc = this.accounts[index];

      if (!username) {
        this.say(`Conta ${index + 1}: informe o usuário.`);
        return;
      }
      // Senha em branco mantém a que já está salva, se o usuário não mudou.
      if (!password) {
        if (acc.hasPassword && username === acc.username) {
          this.say(`Conta ${index + 1}: nada a salvar.`);
          return;
        }
        this.say(`Conta ${index + 1}: informe a senha.`);
        return;
      }

      try {
        const result = await api.levelingSetCreds(index, username, password);
        passField.value = '';
        if (result && result.status) this.applyCreds(result.status);
        this.say(result && result.ok
          ? `Conta ${index + 1}: credenciais salvas.`
          : `Conta ${index + 1}: não foi possível salvar.`);
      } catch (err) {
        this.say(`Conta ${index + 1}: ${err.message}`);
      }
    },

    /**
     * A rota vale para os dois modos: o principal reaponta a partição da
     * WebView e o monitor passa a discar pelo mesmo proxy. Um monitor em curso
     * cai, porque ele está conectado pela rota antiga.
     */
    async saveProxy(index) {
      const api = this.api;
      const card = this.card(index);
      if (!api || !card || typeof api.levelingSetProxy !== 'function') return;

      const value = card.querySelector('[data-role="proxy"]').value.trim();
      try {
        const result = await api.levelingSetProxy(index, value);
        if (result && result.status) this.applyCreds(result.status);
        if (!result || result.ok === false) {
          this.say(`Conta ${index + 1}: não foi possível salvar a rota.`);
          return;
        }
        const acc = this.accounts[index];
        if (acc) {
          acc.status = 'disconnected';
          acc.error = '';
          acc.state = null;
          this.paint(index);
        }
        const onde = value ? `saindo por ${(acc && acc.proxy) || value}` : 'saindo pelo IP local';
        this.say(`Conta ${index + 1}: ${onde}. Recarregue o painel para a WebView usar a rota nova.`);
      } catch (err) {
        this.say(`Conta ${index + 1}: ${err.message}`);
      }
    },

    async toggle(index) {
      const api = this.api;
      const acc = this.accounts[index];
      if (!api || !acc) return;

      const active = acc.status === 'connected' || acc.status === 'connecting' || acc.status === 'reconnecting';

      if (active) {
        if (typeof api.levelingStop !== 'function') return;
        await api.levelingStop(index).catch(() => {});
        acc.status = 'disconnected';
        acc.error = '';
        acc.ended = '';
        acc.state = null;
        this.paint(index);
        this.say(`Conta ${index + 1}: monitor desligado. A conta pode voltar para o navegador.`);
        return;
      }

      if (typeof api.levelingStart !== 'function') return;
      acc.ended = '';
      acc.error = '';
      try {
        const result = await api.levelingStart(index);
        if (result && result.ok === false) {
          this.say(`Conta ${index + 1}: ${result.error}`);
          return;
        }
        acc.status = 'connecting';
        this.paint(index);
        this.say(`Conta ${index + 1}: conectando. A aba do jogo desta conta vai cair.`);
      } catch (err) {
        this.say(`Conta ${index + 1}: ${err.message}`);
      }
    },

    say(message) {
      if (this.statusBar) this.statusBar.textContent = message;
    }
  };

  PioLeveling.describeError = describeError;

  if (typeof window !== 'undefined') window.PioLeveling = PioLeveling;
  if (typeof module !== 'undefined' && module.exports) module.exports = PioLeveling;
})();
