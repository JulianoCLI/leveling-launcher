/**
 * @file leveling-sniper-ui.js
 * Tela do sniper de mercado: regras, interruptor e log.
 *
 * Três partes, e a ordem na tela é a ordem de uso: o formulário de adicionar,
 * a lista do que está sendo caçado, e o log do que aconteceu. O log fica em
 * baixo porque é o que se consulta depois, mas é a parte maior — é dele que
 * sai a resposta "o item entrou e eu perdi?".
 *
 * O catálogo do mercado é a fonte da lista de itens. Digitar o nome e escolher
 * da lista grava o `def_id`, que é o que o servidor filtra de verdade: regra
 * por nome é busca por texto, casa com "Poção Pequena" e "Poção Grande" ao
 * mesmo tempo. O nome continua aceito — às vezes o catálogo não chegou ainda,
 * e uma regra por nome é melhor que nenhuma.
 *
 * Nada aqui valida de verdade: `leveling-sniper.js` normaliza o que receber.
 */

(() => {
  'use strict';

  const escape = s => String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const num = n => Number(n || 0).toLocaleString('pt-BR');

  const moeda = c => (c === 'diamond' ? '💎' : '🪙');

  /** Hora do dia. O log é de uma sessão: a data seria ruído em toda linha. */
  const hora = ms => {
    const n = Number(ms);
    if (!n) return '—';
    const d = new Date(n);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes())
      .padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  };

  /**
   * O que cada estado do log significa, em uma frase.
   *
   * `lost` é o aviso que o usuário pediu: o item entrou dentro do teto e outra
   * pessoa levou. Ele é distinto de `failed`, que é recusa do servidor por
   * outro motivo — ouro insuficiente, por exemplo —, porque as duas coisas
   * levam a decisões opostas: numa se baixa o intervalo, na outra se põe ouro
   * na conta.
   */
  const STATUS = {
    announced: { label: 'anunciado', css: 'is-wait' },
    bought: { label: 'comprado', css: 'is-ok' },
    lost: { label: 'outra pessoa levou', css: 'is-lost' },
    gone: { label: 'saiu do mercado', css: 'is-gone' },
    failed: { label: 'recusado', css: 'is-err' }
  };

  /** Recusas do servidor, em português. O código cru fica no `title`. */
  const ERROS = {
    'market.gold': 'ouro insuficiente',
    'market.diamonds': 'diamantes insuficientes',
    'market.notFound': 'o anúncio já não existia',
    'market.notActive': 'o anúncio já estava fechado',
    'market.sold': 'vendido antes',
    'market.own': 'é um anúncio da própria conta',
    'market.inventoryFull': 'mochila cheia',
    'sniper.accountOffline': 'a conta da regra não está em modo monitor'
  };

  const PioSniper = {
    api: null,
    config: { enabled: false, intervalMs: 5000, rules: [] },
    accounts: [],
    log: [],
    stats: null,
    limits: { minIntervalMs: 1000, maxIntervalMs: 60000, maxRules: 30 },
    /**
     * Itens do catálogo do jogo, para a busca por nome. Começa vazio e nunca
     * é esperado: sem catálogo a tela ainda funciona com regra por nome, e
     * travar o formulário atrás de um login que pode não acontecer seria pior.
     */
    catalog: { items: {}, rarities: {}, origin: '' },
    /**
     * Câmbio: diamante e ouro vendidos um pelo outro.
     *
     * Vem do processo principal, não do catálogo do jogo, porque não está
     * lá: `content_catalog` traz 180 `ItemDef` e nenhum é diamante. Sem esta
     * lista, digitar "diamante" no campo de item não sugeria nada e a regra
     * só podia ser criada por nome solto — que não casa com o `def_id` real.
     */
    exchanges: {},
    /** Rascunho do formulário, para a repintura não apagar o que foi digitado. */
    draft: { search: '', defId: '', name: '', maxGold: '', maxDiamond: '', target: '0', account: 0 },
    /** Sugestões abertas sob o campo de busca. */
    sugestoes: [],
    busy: false,

    async init(api) {
      this.api = api || window.pokeAPI;
      if (!this.api) return;

      if (this.api.onSniper) {
        // Linha nova de log. A tela se atualiza sozinha: o laço roda no
        // processo principal, inclusive com esta janela em segundo plano.
        this.api.onSniper(data => {
          if (!data) return;
          if (data.stats) this.stats = data.stats;
          if (data.entry) this.mergeEntry(data.entry);
          this.renderLog();
          this.renderStatus();
        });
      }
      if (this.api.onMarketCatalog) {
        this.api.onMarketCatalog(d => {
          if (d && d.catalog) this.applyCatalog(d.catalog);
        });
      }

      this.loadCatalog();
      await this.load();
      this.wire();
    },

    async loadCatalog() {
      if (!this.api.marketCatalog) return;
      const res = await this.api.marketCatalog().catch(() => null);
      if (res && res.catalog) this.applyCatalog(res.catalog);
    },

    applyCatalog(cat) {
      this.catalog = {
        items: (cat && cat.items) || {},
        rarities: (cat && cat.rarities) || {},
        origin: (cat && cat.origin) || ''
      };
      // A lista aberta pode ter sido montada sem catálogo: refazer a busca é
      // o que faz as sugestões aparecerem sem o usuário digitar de novo.
      if (this.draft.search) this.suggest(this.draft.search);
    },

    async load() {
      const res = await this.api.sniperGet().catch(() => null);
      if (!res) {
        this.say('Não foi possível ler a configuração do sniper.', true);
        return;
      }
      this.config = res.config || this.config;
      this.accounts = res.accounts || [];
      this.log = res.log || [];
      this.stats = res.stats || null;
      if (res.limits) this.limits = res.limits;
      if (res.exchanges) this.exchanges = res.exchanges;
      // Conta padrão do formulário: a primeira em modo monitor, que é a única
      // que pode pagar agora. Sem nenhuma, a primeira configurada.
      const viva = this.accounts.find(a => a.connected);
      if (viva) this.draft.account = viva.index;
      this.render();
    },

    /** Substitui a linha do mesmo anúncio em vez de empilhar duas. */
    mergeEntry(entry) {
      const i = this.log.findIndex(e => e.id === entry.id);
      if (i >= 0) this.log.splice(i, 1);
      this.log.unshift(entry);
      if (this.log.length > 300) this.log.length = 300;
    },

    // ------------------------------------------------------------- busca

    /**
     * Sugestões do catálogo para o que foi digitado.
     *
     * Casa por nome **e** por id: o usuário digita "poção", mas quem já
     * conhece o jogo digita o id direto. Teto de 12 linhas — a lista é um
     * atalho para escolher, não uma tabela para ler.
     */
    suggest(texto) {
      const alvo = String(texto || '').trim().toLowerCase();
      if (alvo.length < 2) {
        this.sugestoes = [];
        return;
      }
      const out = [];
      // Câmbio primeiro e fora do teto de 40: são duas linhas, e enterrá-las
      // atrás do corte do catálogo recriaria o problema que elas resolvem.
      for (const [id, def] of Object.entries(this.exchanges)) {
        const nome = String((def && def.name) || id);
        if (!nome.toLowerCase().includes(alvo) && !id.toLowerCase().includes(alvo)) continue;
        out.push({ defId: id, name: nome, rarity: '', icon: '', exchange: true });
      }
      for (const [id, def] of Object.entries(this.catalog.items)) {
        const nome = String((def && def.name) || id);
        if (!nome.toLowerCase().includes(alvo) && !id.toLowerCase().includes(alvo)) continue;
        out.push({ defId: id, name: nome, rarity: (def && def.rarity) || '', icon: (def && def.icon) || '' });
        if (out.length >= 40) break;
      }
      // Quem começa com o que foi digitado vem antes de quem só contém: é
      // quase sempre o item que o usuário quis.
      out.sort((a, b) => {
        const pa = a.name.toLowerCase().startsWith(alvo) ? 0 : 1;
        const pb = b.name.toLowerCase().startsWith(alvo) ? 0 : 1;
        return pa - pb || a.name.localeCompare(b.name, 'pt-BR');
      });
      this.sugestoes = out.slice(0, 12);
    },

    /** Escolheu um item da lista: a regra passa a ter `def_id`. */
    pick(defId) {
      const cambio = this.exchanges[defId];
      const def = cambio || this.catalog.items[defId];
      this.draft.defId = defId;
      this.draft.name = (def && def.name) || defId;
      this.draft.search = this.draft.name;
      this.sugestoes = [];
      this.renderForm();
      // O foco vai para o teto da moeda que de fato paga por este anúncio.
      // Em câmbio ela é cruzada — diamante se compra com ouro —, e mandar o
      // cursor para o campo errado faria a regra nascer sem critério.
      const campo = document.getElementById(
        cambio && cambio.currency === 'diamond' ? 'snMaxDiamond' : 'snMaxGold'
      );
      if (campo) campo.focus();
    },

    // ------------------------------------------------------------- regras

    /**
     * Acrescenta a regra do formulário.
     *
     * Sem `def_id` a regra vale por nome, e isso é dito na lista: é a
     * diferença entre caçar um item e caçar tudo que tem aquela palavra no
     * nome, e o usuário tem de poder ver qual das duas ele configurou.
     */
    async add() {
      const d = this.draft;
      const defId = d.defId;
      const name = (d.name || d.search || '').trim();
      if (!defId && !name) {
        this.say('Escolha um item ou digite o nome.', true);
        return;
      }
      const maxGold = Math.max(0, Math.floor(Number(d.maxGold) || 0));
      const maxDiamond = Math.max(0, Math.floor(Number(d.maxDiamond) || 0));
      if (!maxGold && !maxDiamond) {
        this.say('Defina um teto de ouro ou de diamante: sem teto não há critério de compra.', true);
        return;
      }

      const rules = [...this.config.rules, {
        defId,
        name,
        maxGold,
        maxDiamond,
        target: Math.max(0, Math.floor(Number(d.target) || 0)),
        account: Math.max(0, Math.floor(Number(d.account) || 0)),
        enabled: true,
        bought: 0
      }];

      const ok = await this.save({ ...this.config, rules });
      if (!ok) return;
      this.draft = {
        search: '', defId: '', name: '', maxGold: '', maxDiamond: '',
        target: '0', account: d.account
      };
      this.sugestoes = [];
      this.render();
      this.say('Regra adicionada.');
    },

    async remove(id) {
      const rules = this.config.rules.filter(r => r.id !== id);
      if (await this.save({ ...this.config, rules })) {
        this.render();
        this.say('Regra removida.');
      }
    },

    async toggleRule(id) {
      const rules = this.config.rules.map(r => (r.id === id ? { ...r, enabled: !r.enabled } : r));
      if (await this.save({ ...this.config, rules })) this.render();
    },

    /** Zera o contador de comprados: volta a caçar um alvo já cumprido. */
    async resetRule(id) {
      const rules = this.config.rules.map(r => (r.id === id ? { ...r, bought: 0 } : r));
      if (await this.save({ ...this.config, rules })) {
        this.render();
        this.say('Contagem zerada: a regra volta a comprar.');
      }
    },

    async toggleMaster() {
      const next = !this.config.enabled;
      if (await this.save({ ...this.config, enabled: next })) {
        this.render();
        this.say(next
          ? 'Sniper ligado: ele compra sozinho o que entrar abaixo do teto.'
          : 'Sniper desligado.');
      }
    },

    async setInterval(ms) {
      if (await this.save({ ...this.config, intervalMs: ms })) this.renderStatus();
    },

    /**
     * Grava. A configuração devolvida substitui a local de propósito: ela vem
     * normalizada, então um campo corrigido pelo domínio aparece na tela em
     * vez de a tela seguir mostrando o que foi digitado.
     */
    async save(config) {
      if (this.busy) return false;
      this.busy = true;
      try {
        const res = await this.api.sniperSet(config).catch(e => ({ error: e.message }));
        if (!res || !res.ok) {
          this.say('Falha ao salvar: ' + ((res && res.error) || 'desconhecida'), true);
          return false;
        }
        this.config = res.config;
        this.stats = res.stats || this.stats;
        return true;
      } finally {
        this.busy = false;
      }
    },

    async pollNow() {
      this.say('Varrendo o mercado…');
      const res = await this.api.sniperPoll().catch(e => ({ error: e.message }));
      if (!res || res.error) {
        this.say('A varredura falhou: ' + ((res && res.error) || 'desconhecida'), true);
        return;
      }
      this.log = res.log || this.log;
      this.stats = res.stats || this.stats;
      this.renderLog();
      this.renderStatus();
      this.say(res.bought
        ? `Varredura concluída: ${num(res.bought)} ${res.bought === 1 ? 'unidade' : 'unidades'} compradas.`
        : 'Varredura concluída: nada dentro do teto.');
    },

    async clearLog() {
      await this.api.sniperLogClear().catch(() => {});
      this.log = [];
      this.renderLog();
    },

    // ------------------------------------------------------------- pintura

    wire() {
      const poll = document.getElementById('sniperPoll');
      if (poll) poll.onclick = () => this.pollNow().catch(() => {});
    },

    render() {
      this.renderForm();
      this.renderRules();
      this.renderLog();
      this.renderStatus();
    },

    accountLabel(index) {
      const conta = this.accounts.find(a => a.index === Number(index));
      if (!conta) return `Conta ${Number(index) + 1}`;
      const nome = conta.name || conta.username || `Conta ${conta.index + 1}`;
      return `${conta.index + 1} · ${nome}`;
    },

    accountOptions(selected) {
      return this.accounts.map(a => {
        const nome = a.name || a.username || `Conta ${a.index + 1}`;
        const marca = a.connected ? '' : ' (offline)';
        return `<option value="${a.index}"${Number(selected) === a.index ? ' selected' : ''}>${
          escape(`${a.index + 1} · ${nome}${marca}`)}</option>`;
      }).join('');
    },

    /**
     * O formulário. Repintado inteiro a cada mudança de rascunho, mas o foco é
     * devolvido ao campo que o usuário estava usando — sem isso, digitar no
     * campo de busca perderia o cursor a cada tecla.
     */
    renderForm() {
      const host = document.getElementById('sniperForm');
      if (!host) return;

      const ativo = document.activeElement;
      const foco = ativo && ativo.id ? ativo.id : '';
      const caret = ativo && ativo.selectionStart !== undefined ? ativo.selectionStart : null;
      const d = this.draft;

      const lista = this.sugestoes.length
        ? `<ul class="sn-sug" role="listbox">${this.sugestoes.map(s => {
          const r = this.catalog.rarities[s.rarity];
          const cor = r && r.color ? ` style="color:${escape(r.color)}"` : '';
          const src = s.icon ? this.catalog.origin + s.icon : '';
          return `<li><button type="button" data-pick="${escape(s.defId)}" role="option">
            <span class="sn-sug-ic">${src
            ? `<img src="${escape(src)}" alt="" width="22" height="22" loading="lazy" decoding="async" onerror="this.remove()">`
            : ''}</span>
            <b${cor}>${escape(s.name)}</b>
            <small>${s.exchange
            ? `câmbio · teto por unidade em ${this.exchanges[s.defId].currency === 'diamond' ? '💎' : '🪙'}`
            : escape(s.defId)}</small>
          </button></li>`;
        }).join('')}</ul>`
        : '';

      host.innerHTML = `
        <div class="sn-form">
          <label class="sn-field sn-field-wide">
            <span>Item</span>
            <input type="text" id="snSearch" autocomplete="off" placeholder="digite o nome do item"
              value="${escape(d.search)}">
            ${lista}
            ${d.defId
          ? `<small class="sn-pick">catálogo: ${escape(d.defId)}</small>`
          : (d.search.trim()
            ? '<small class="sn-pick is-loose">por nome: casa com qualquer item que contenha esse texto</small>'
            : '')}
          </label>
          <label class="sn-field">
            <span>Teto 🪙 ouro</span>
            <input type="number" id="snMaxGold" min="0" step="100" placeholder="0" value="${escape(d.maxGold)}">
          </label>
          <label class="sn-field">
            <span>Teto 💎 diamante</span>
            <input type="number" id="snMaxDiamond" min="0" step="1" placeholder="0" value="${escape(d.maxDiamond)}">
          </label>
          <label class="sn-field">
            <span>Quantidade alvo</span>
            <input type="number" id="snTarget" min="0" step="1" value="${escape(d.target)}">
            <small>0 = sem limite</small>
          </label>
          <label class="sn-field">
            <span>Conta que compra</span>
            <select id="snAccount">${this.accountOptions(d.account)}</select>
          </label>
          <button type="button" id="snAdd" class="primary">Adicionar</button>
        </div>`;

      const busca = document.getElementById('snSearch');
      if (busca) {
        busca.oninput = () => {
          this.draft.search = busca.value;
          // Digitar depois de escolher desfaz a escolha: senão o teto seria
          // aplicado ao item antigo enquanto a tela mostra o nome novo.
          this.draft.defId = '';
          this.draft.name = busca.value;
          this.suggest(busca.value);
          this.renderForm();
        };
        busca.onkeydown = e => {
          if (e.key === 'Enter' && this.sugestoes.length) {
            e.preventDefault();
            this.pick(this.sugestoes[0].defId);
          }
        };
      }
      for (const [id, chave] of [
        ['snMaxGold', 'maxGold'], ['snMaxDiamond', 'maxDiamond'],
        ['snTarget', 'target'], ['snAccount', 'account']
      ]) {
        const campo = document.getElementById(id);
        if (campo) campo.oninput = () => { this.draft[chave] = campo.value; };
      }
      for (const botao of host.querySelectorAll('[data-pick]')) {
        botao.onclick = () => this.pick(botao.dataset.pick);
      }
      const add = document.getElementById('snAdd');
      if (add) add.onclick = () => this.add().catch(() => {});

      if (foco) {
        const volta = document.getElementById(foco);
        if (volta) {
          volta.focus();
          if (caret !== null && volta.setSelectionRange) {
            try { volta.setSelectionRange(caret, caret); } catch {}
          }
        }
      }
    },

    renderRules() {
      const host = document.getElementById('sniperRules');
      if (!host) return;

      if (!this.config.rules.length) {
        host.innerHTML = '<p class="sn-empty">Nenhum item na lista. Acrescente um acima para o sniper ter o que caçar.</p>';
        return;
      }

      host.innerHTML = `
        <table class="sn-table">
          <thead>
            <tr>
              <th class="sn-c-name">Item</th>
              <th>Teto unitário</th>
              <th>Alvo</th>
              <th>Comprado</th>
              <th>Conta</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${this.config.rules.map(r => {
        const tetos = [];
        if (r.maxGold) tetos.push(`🪙 ${num(r.maxGold)}`);
        if (r.maxDiamond) tetos.push(`💎 ${num(r.maxDiamond)}`);
        const alvo = r.target ? num(r.target) : '∞';
        const cumprido = r.target && r.bought >= r.target;
        return `
              <tr class="${r.enabled ? '' : 'is-off'}">
                <td class="sn-c-name">
                  <b>${escape(r.name || r.defId)}</b>
                  <small>${r.defId
            ? escape(r.defId)
            : 'por nome · casa com qualquer item que contenha esse texto'}</small>
                </td>
                <td>${tetos.join(' · ')}</td>
                <td>${alvo}</td>
                <td class="${cumprido ? 'is-done' : ''}">${num(r.bought)}${
          cumprido ? ' · alvo cumprido' : ''}</td>
                <td>${escape(this.accountLabel(r.account))}</td>
                <td class="sn-c-act">
                  <button type="button" data-toggle="${escape(r.id)}">${r.enabled ? 'Pausar' : 'Ligar'}</button>
                  ${cumprido ? `<button type="button" data-reset="${escape(r.id)}">Zerar</button>` : ''}
                  <button type="button" data-remove="${escape(r.id)}">Remover</button>
                </td>
              </tr>`;
      }).join('')}
          </tbody>
        </table>`;

      for (const botao of host.querySelectorAll('[data-toggle]')) {
        botao.onclick = () => this.toggleRule(botao.dataset.toggle).catch(() => {});
      }
      for (const botao of host.querySelectorAll('[data-reset]')) {
        botao.onclick = () => this.resetRule(botao.dataset.reset).catch(() => {});
      }
      for (const botao of host.querySelectorAll('[data-remove]')) {
        botao.onclick = () => this.remove(botao.dataset.remove).catch(() => {});
      }
    },

    /**
     * O log. Uma linha por anúncio, com os dois horários lado a lado: o do
     * anúncio e o do fecho. A distância entre eles é o que diz se o intervalo
     * de verificação está largo demais — e é a única forma de entender por que
     * um item apareceu e outra pessoa levou.
     */
    renderLog() {
      const host = document.getElementById('sniperLog');
      if (!host) return;

      if (!this.log.length) {
        host.innerHTML = '<p class="sn-empty">O log está vazio. Ele se preenche quando um item da lista entra no mercado.</p>';
        return;
      }

      host.innerHTML = `
        <table class="sn-table sn-log">
          <thead>
            <tr>
              <th class="sn-c-name">Item</th>
              <th>Valor unit.</th>
              <th>Qtd.</th>
              <th>Total</th>
              <th>Anunciado</th>
              <th>Fechado</th>
              <th>Quem levou</th>
            </tr>
          </thead>
          <tbody>
            ${this.log.map(e => {
        const st = STATUS[e.status] || STATUS.announced;
        const erro = e.error ? (ERROS[e.error] || e.error) : '';
        // Quem levou: eu, a pessoa nomeada pelo servidor, ou ninguém ainda.
        // "—" e "outra pessoa" são respostas diferentes e precisam parecer
        // diferentes: a primeira é "ainda aberto".
        const quem = e.mine
          ? `<b class="is-ok">eu · ${escape(this.accountLabel(e.account))}</b>`
          : (e.status === 'announced'
            ? '<small>—</small>'
            : `<span>${escape(e.buyer || 'outra pessoa')}</span>`);
        return `
              <tr class="${st.css}">
                <td class="sn-c-name">
                  <b>${escape(e.name || e.defId)}</b>
                  <small>
                    <span class="sn-badge ${st.css}">${st.label}</span>
                    ${e.level ? ` nv. ${e.level}` : ''}
                    ${e.toMail ? ' · foi para o correio (mochila cheia)' : ''}
                    ${erro ? ` · <span title="${escape(e.error)}">${escape(erro)}</span>` : ''}
                  </small>
                </td>
                <td>${moeda(e.currency)} ${num(e.unitPrice)}</td>
                <td>${num(e.quantity)}</td>
                <td>${moeda(e.currency)} ${num(e.total)}</td>
                <td>${hora(e.announcedAtMs || e.seenAtMs)}</td>
                <td>${hora(e.closedAtMs)}</td>
                <td class="sn-c-who">${quem}</td>
              </tr>`;
      }).join('')}
          </tbody>
        </table>`;
    },

    /** Interruptor, intervalo e números da sessão. */
    renderStatus() {
      const host = document.getElementById('sniperControls');
      if (!host) return;

      const ativo = document.activeElement;
      const foco = ativo && ativo.id ? ativo.id : '';

      const s = this.stats || {};
      const ligadas = this.config.rules.filter(r => r.enabled).length;
      const semConta = this.config.rules.some(r => {
        const conta = this.accounts.find(a => a.index === Number(r.account));
        return r.enabled && (!conta || !conta.connected);
      });

      host.innerHTML = `
        <div class="sn-controls">
          <label class="sn-master">
            <input type="checkbox" id="snEnabled"${this.config.enabled ? ' checked' : ''}>
            <span>Ligar o sniper</span>
          </label>
          <label class="sn-field sn-interval">
            <span>Verificar a cada</span>
            <select id="snInterval">
              ${[1000, 2000, 3000, 5000, 10000, 15000, 30000, 60000]
          .filter(ms => ms >= this.limits.minIntervalMs && ms <= this.limits.maxIntervalMs)
          .map(ms => `<option value="${ms}"${this.config.intervalMs === ms ? ' selected' : ''}>${
            ms < 60000 ? `${ms / 1000} s` : '1 min'}</option>`).join('')}
            </select>
          </label>
          <span class="sn-stats">
            ${ligadas} ${ligadas === 1 ? 'regra ativa' : 'regras ativas'} ·
            ${num(s.polls)} ${s.polls === 1 ? 'varredura' : 'varreduras'} ·
            ${num(s.buys)} ${s.buys === 1 ? 'compra' : 'compras'} ·
            gasto 🪙 ${num(s.spentGold)}${s.spentDiamond ? ` · 💎 ${num(s.spentDiamond)}` : ''}
            ${s.running ? '' : ' · <b>parado</b>'}
          </span>
          <button type="button" id="snClear">Limpar o log</button>
        </div>
        ${semConta
          ? '<p class="sn-warn">Alguma regra ativa aponta para uma conta que não está em modo monitor: ela não compra nada até a conta conectar.</p>'
          : ''}
        ${s.lastError && s.lastError !== 'sniper.accountOffline'
          ? `<p class="sn-warn">Última falha: ${escape(ERROS[s.lastError] || s.lastError)}</p>`
          : ''}`;

      const chave = document.getElementById('snEnabled');
      if (chave) chave.onchange = () => this.toggleMaster().catch(() => {});
      const intervalo = document.getElementById('snInterval');
      if (intervalo) {
        intervalo.onchange = () => this.setInterval(Number(intervalo.value)).catch(() => {});
      }
      const limpar = document.getElementById('snClear');
      if (limpar) limpar.onclick = () => this.clearLog().catch(() => {});

      if (foco) {
        const volta = document.getElementById(foco);
        if (volta) volta.focus();
      }
    },

    say(text, isError) {
      const bar = document.getElementById('sniperStatusBar');
      if (!bar) return;
      bar.textContent = text;
      bar.classList.toggle('is-error', !!isError);
    }
  };

  if (typeof window !== 'undefined') window.PioSniper = PioSniper;
  if (typeof module !== 'undefined' && module.exports) module.exports = PioSniper;
})();
