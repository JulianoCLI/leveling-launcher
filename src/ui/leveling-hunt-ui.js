/**
 * @file leveling-hunt-ui.js
 * Modal de troca de caçada: escolhe portal, faixa e dificuldade e aplica nas
 * contas selecionadas, sem desligar o modo monitor.
 *
 * Existe porque trocar de mapa era a única coisa que obrigava a voltar para a
 * WebView do jogo — desligar o monitor, esperar o renderer subir, trocar, e
 * ligar de novo. Aqui é um `start_hunt`.
 *
 * A lista vem do `content_catalog` do servidor (via `leveling:hunts:get`), não
 * de uma tabela neste arquivo: portal novo no jogo aparece aqui sem alterar o
 * launcher. Antes do primeiro monitor conectar o catálogo não existe, e a tela
 * diz isso em vez de mostrar uma lista vazia.
 *
 * Os níveis são o ponto da tela. O servidor exige três coisas ao mesmo tempo
 * (portal, dificuldade e faixa), então o **exigido** mostrado é o maior dos
 * três, e o **recomendado** é o nível dos monstros da área: é ele que diz se a
 * conta sobrevive lá, não a permissão de entrar.
 *
 * A tela é **uma lista, com um filtro só**. Três seletores em cascata (portal,
 * faixa, dificuldade) obrigavam a abrir um por um para descobrir o nível de
 * cada combinação — escolher exige comparar, e comparar exige ver tudo junto.
 * Portal e faixa viraram linha; a dificuldade continua seletor porque ela
 * recalcula o nível de **todas** as linhas, e repetir cada caçada uma vez por
 * dificuldade triplicaria a lista sem acrescentar escolha.
 */

(() => {
  'use strict';

  const ACTIVE = new Set(['connecting', 'connected', 'reconnecting']);

  const ERROR_TEXT = {
    'hunt.noGate': 'Escolha um portal.',
    'hunt.noneActive': 'Nenhuma das contas escolhidas está em modo monitor.',
    'hunt.offline': 'o monitor não está conectado',
    'hunt.refillBusy': 'a conta está comprando na cidade; tente de novo em alguns segundos',
    'hunt.level': 'nível insuficiente',
    'hunt.comingSoon': 'faixa ainda não liberada no jogo',
    'hunt.failed': 'o servidor recusou a troca',
    'hunt.locked': 'caçada bloqueada para esta conta'
  };

  const escape = text => String(text == null ? '' : text).replace(/[&<>"]/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));

  const PioHunt = {
    api: null,
    catalog: null,
    /** Contas que a tela pode trocar, na ordem dos painéis da aba. */
    targets: [],
    selection: new Set(),
    choice: { gateId: '', tierMin: 0, difficulty: '' },

    init(api) {
      this.api = api || window.pokeAPI;
      if (this.api && this.api.onLevelingHunts) {
        // O catálogo chega no primeiro login: se a tela abriu antes, ela se
        // preenche sozinha em vez de exigir fechar e abrir de novo.
        this.api.onLevelingHunts(({ catalog }) => {
          if (!catalog) return;
          this.catalog = catalog;
          if (this.isOpen()) this.render();
        });
      }
      this.wire();
    },

    isOpen() {
      const overlay = document.getElementById('huntOverlay');
      return !!overlay && overlay.classList.contains('show');
    },

    wire() {
      const save = document.getElementById('huntApply');
      if (save) save.onclick = () => this.apply();
    },

    /**
     * Abre a tela já com as contas monitorando pré-selecionadas, e com a caçada
     * da primeira delas escolhida: o caso comum é trocar a partir de onde o
     * grupo já está.
     *
     * @param {object[]} targets `{index, name, level, status, hunt, party}`
     */
    async open(targets) {
      this.targets = Array.isArray(targets) ? targets : [];
      this.selection = new Set(this.targets.filter(t => ACTIVE.has(t.status)).map(t => t.index));

      if (!this.catalog && this.api && this.api.levelingGetHunts) {
        const data = await this.api.levelingGetHunts().catch(() => null);
        this.catalog = (data && data.catalog) || null;
      }

      const atual = this.targets.find(t => t.hunt && t.hunt.gateId);
      if (atual && !this.choice.gateId) {
        this.choice = {
          gateId: atual.hunt.gateId,
          tierMin: +atual.hunt.tierMin || 0,
          difficulty: atual.hunt.difficulty || ''
        };
      }
      this.normalizeChoice();
      this.render();
      this.say('');
    },

    gates() {
      return (this.catalog && this.catalog.gates) || [];
    },

    tiers(gateId) {
      return (this.catalog && this.catalog.tiers && this.catalog.tiers[gateId]) || [];
    },

    /**
     * Corrige a escolha para uma combinação que existe no catálogo. Sem isto, a
     * caçada lida da conta poderia apontar para uma faixa ou dificuldade que o
     * catálogo não descreve, e a tela mostraria requisitos inexistentes.
     */
    normalizeChoice() {
      const todas = this.allDifficulties();
      if (!todas.some(d => d.id === this.choice.difficulty)) {
        this.choice.difficulty = todas.length ? todas[0].id : '';
      }

      // A linha selecionada tem de continuar existindo na dificuldade atual.
      const linhas = this.rows();
      if (!linhas.some(r => r.gateId === this.choice.gateId && r.tierMin === this.choice.tierMin)) {
        this.choice.gateId = linhas.length ? linhas[0].gateId : '';
        this.choice.tierMin = linhas.length ? linhas[0].tierMin : 0;
      }
    },

    /** Todas as dificuldades do jogo: é a única coisa que a tela filtra. */
    allDifficulties() {
      return (this.catalog && this.catalog.difficulties) || [];
    },

    difficultyOf(id) {
      return this.allDifficulties().find(d => d.id === id) || null;
    },

    /**
     * A lista inteira: uma linha por faixa de cada portal, já com os níveis
     * calculados para a dificuldade escolhida.
     *
     * Achatar portal e faixa numa linha só é o ponto da tela — o que o usuário
     * escolhe é "este mapa nesta faixa", não um portal e depois uma faixa.
     * Faixas que a dificuldade escolhida não oferece ficam de fora: oferecê-las
     * seria oferecer uma combinação que o servidor recusa.
     */
    rows() {
      const difficulty = this.difficultyOf(this.choice.difficulty);
      const linhas = [];

      for (const gate of this.gates()) {
        for (const tier of this.tiers(gate.id)) {
          const areas = tier.areas || {};
          const ids = Object.keys(areas);
          // Faixa sem área declarada não restringe dificuldade; com áreas, só
          // vale a que a dificuldade escolhida tem.
          if (ids.length && difficulty && !ids.includes(difficulty.id)) continue;
          const area = difficulty ? areas[difficulty.id] : null;

          linhas.push({
            gateId: gate.id,
            gateName: gate.name,
            tierMin: tier.min,
            tierMax: tier.max,
            bossId: tier.bossId,
            comingSoon: !!tier.comingSoon,
            // Mesma regra do domínio (`leveling-hunts.requirementFor`): o
            // exigido é o maior dos três requisitos, nunca só o do portal.
            minLevel: Math.max(
              gate.minLevel || 0,
              difficulty ? difficulty.reqLevel || 0 : 0,
              area ? area.requiredLevel || 0 : 0
            ),
            recommended: area && area.level ? area.level : tier.max
          });
        }
      }

      // Ordem de progressão: é como o jogo é jogado, e é o que deixa a lista
      // legível de cima para baixo.
      linhas.sort((a, b) => a.minLevel - b.minLevel || a.tierMin - b.tierMin);
      return linhas;
    },

    /** A linha escolhida, para o botão e para o aviso de nível das contas. */
    current() {
      return this.rows().find(r =>
        r.gateId === this.choice.gateId && r.tierMin === this.choice.tierMin) || null;
    },

    render() {
      const host = document.getElementById('huntBody');
      if (!host) return;

      if (!this.gates().length) {
        host.innerHTML = `
          <p class="hint">A lista de portais vem do servidor e só chega no primeiro login.
          Ligue o monitor em alguma conta e abra esta tela de novo.</p>`;
        this.paintApply();
        return;
      }

      const linhas = this.rows();
      const atual = this.current();

      host.innerHTML = `
        <div class="hu-pickers">
          <label class="hu-field">
            <span>Dificuldade</span>
            <select data-role="difficulty">
              ${this.allDifficulties().map(d => `
                <option value="${escape(d.id)}" ${d.id === this.choice.difficulty ? 'selected' : ''}>
                  ${escape(d.name)}${d.reqLevel ? ' · Nv ' + d.reqLevel + '+' : ''}
                </option>`).join('')}
            </select>
          </label>
        </div>

        <div class="hu-list" role="radiogroup" aria-label="Caçadas">
          <div class="hu-row hu-row-head" aria-hidden="true">
            <span class="hu-col-name">Caçada</span>
            <span class="hu-col-min">Exigido</span>
            <span class="hu-col-rec">Recomendado</span>
            <span class="hu-col-boss">Chefe</span>
          </div>
          ${this.rowsHtml(linhas)}
        </div>

        <h3 class="hu-group">Contas</h3>
        <p class="hint">Marque as contas que vão para esta caçada. Só entram as que estão em
          modo monitor — a conta aberta no jogo troca de mapa lá mesmo.</p>
        <div class="hu-targets">${this.targetsHtml(atual)}</div>
      `;

      const select = host.querySelector('[data-role="difficulty"]');
      if (select) {
        select.onchange = () => {
          this.choice.difficulty = select.value;
          // A dificuldade muda quais faixas existem e o nível de todas elas: a
          // linha escolhida pode ter deixado de ser oferecida.
          this.normalizeChoice();
          this.render();
        };
      }

      for (const row of host.querySelectorAll('[data-gate]')) {
        row.onclick = () => {
          this.choice.gateId = row.dataset.gate;
          this.choice.tierMin = +row.dataset.tier || 0;
          this.render();
        };
      }

      // A linha escolhida pode estar fora de vista numa lista longa.
      const marcada = host.querySelector('.hu-row.is-on');
      if (marcada && marcada.scrollIntoView) marcada.scrollIntoView({ block: 'nearest' });

      for (const box of host.querySelectorAll('[data-target]')) {
        box.onchange = () => {
          const index = +box.dataset.target;
          if (box.checked) this.selection.add(index);
          else this.selection.delete(index);
          // Marcar outra conta muda o nível de referência, e com ele quais
          // linhas da lista ficam avisadas.
          this.render();
        };
      }

      this.paintApply();
    },

    /**
     * A lista de caçadas. Os níveis aparecem em **todas** as linhas, não só na
     * escolhida: comparar é o que faz escolher, e comparar exige ver junto.
     *
     * O nível de referência é o da conta mais baixa entre as marcadas — é ela
     * que o servidor vai recusar primeiro, então é dela que a lista tem de
     * avisar.
     */
    rowsHtml(linhas) {
      if (!linhas.length) {
        return `<p class="hint">Nenhuma caçada nesta dificuldade.</p>`;
      }

      const nivel = this.refLevel();

      return linhas.map(r => {
        const escolhida = r.gateId === this.choice.gateId && r.tierMin === this.choice.tierMin;
        const curto = nivel > 0 && nivel < r.minLevel;

        const notas = [];
        if (r.comingSoon) notas.push('em breve');
        else if (curto) notas.push(`precisa de ${r.minLevel}`);

        return `
          <button type="button" class="hu-row${escolhida ? ' is-on' : ''}${curto || r.comingSoon ? ' is-low' : ''}"
            data-gate="${escape(r.gateId)}" data-tier="${r.tierMin}"
            role="radio" aria-checked="${escolhida}">
            <span class="hu-col-name">
              <b>${escape(r.gateName)}</b>
              <small>tier ${r.tierMin}–${r.tierMax}${notas.length ? ' · ' + escape(notas.join(' · ')) : ''}</small>
            </span>
            <span class="hu-col-min">${r.minLevel || 1}</span>
            <span class="hu-col-rec">${r.recommended || '—'}</span>
            <span class="hu-col-boss">${escape(r.bossId ? r.bossId.replace(/[_-]+/g, ' ') : '—')}</span>
          </button>`;
      }).join('');
    },

    /**
     * Nível da conta mais baixa entre as marcadas, ou da mais baixa da lista se
     * nenhuma está marcada. Usar o maior esconderia justamente a conta que o
     * servidor vai barrar.
     */
    refLevel() {
      const marcadas = this.targets.filter(t => this.selection.has(t.index));
      const niveis = (marcadas.length ? marcadas : this.targets)
        .map(t => +t.level || 0)
        .filter(n => n > 0);
      return niveis.length ? Math.min(...niveis) : 0;
    },

    /**
     * Uma linha por conta, com o nível dela confrontado com o exigido. O aviso
     * de nível não impede marcar: quem decide é o servidor, e o catálogo pode
     * estar desatualizado em relação a ele.
     */
    targetsHtml(escolhida) {
      if (!this.targets.length) return `<p class="hint">Nenhuma conta nesta aba.</p>`;

      return this.targets.map(t => {
        const ativo = ACTIVE.has(t.status);
        const nivel = +t.level || 0;
        const curto = !!escolhida && nivel > 0 && nivel < escolhida.minLevel;
        const mapa = t.hunt && t.hunt.gateId
          ? String(t.hunt.gateId).replace(/[_-]+/g, ' ')
          : '—';

        const notas = [];
        if (!ativo) notas.push('sem monitor');
        if (curto) notas.push(`nível ${nivel} abaixo do exigido`);
        // O líder arrasta o grupo, então a troca de um membro é redundante: a
        // tela avisa para a marcação não parecer ignorada.
        if (t.party && t.party.inParty && !t.party.leader) notas.push('será puxada pelo líder do grupo');

        return `
          <label class="hu-target${ativo ? '' : ' is-off'}${curto ? ' is-low' : ''}">
            <input type="checkbox" data-target="${t.index}"
              ${this.selection.has(t.index) ? 'checked' : ''} ${ativo ? '' : 'disabled'}>
            <span class="hu-target-name">Conta ${t.index + 1}${t.name ? ' · ' + escape(t.name) : ''}</span>
            <span class="hu-target-level">${nivel ? 'Nv ' + nivel : '—'}</span>
            <span class="hu-target-hunt">${escape(mapa)}</span>
            <span class="hu-target-note">${escape(notas.join(' · '))}</span>
          </label>`;
      }).join('');
    },

    paintApply() {
      const button = document.getElementById('huntApply');
      if (!button) return;
      const quantas = this.selection.size;
      button.disabled = !quantas || !this.choice.gateId;
      button.textContent = quantas > 1 ? `Trocar em ${quantas} contas` : 'Trocar a caçada';
    },

    async apply() {
      const api = this.api || window.pokeAPI;
      if (!api || !api.levelingSetHunt) return;

      const indexes = [...this.selection];
      if (!indexes.length) return;

      this.busy(true, 'Trocando a caçada…');
      const result = await api.levelingSetHunt(indexes, {
        gate_id: this.choice.gateId,
        tier_min: this.choice.tierMin,
        difficulty: this.choice.difficulty
      }).catch(e => ({ error: e.message }));
      this.busy(false);

      if (!result) {
        this.say('Sem resposta do processo principal.', true);
        return;
      }
      if (result.error && !(result.changed || []).length) {
        this.say('Não trocou: ' + (ERROR_TEXT[result.error] || result.error), true);
        return;
      }

      const partes = [];
      const trocadas = result.changed || [];
      if (trocadas.length) {
        partes.push(`${trocadas.length} ${trocadas.length === 1 ? 'conta' : 'contas'} em ${result.gateId}.`);
      }
      if ((result.pulled || []).length) {
        partes.push(`${result.pulled.length} puxada${result.pulled.length === 1 ? '' : 's'} pelo líder do grupo.`);
      }
      if ((result.failed || []).length) {
        partes.push('Falhou em: ' + result.failed
          .map(f => `conta ${f.index + 1} (${ERROR_TEXT[f.error] || f.error})`)
          .join(', ') + '.');
      }

      this.say(partes.join(' ') || 'Nada mudou.', !!(result.failed || []).length);
    },

    busy(on, text) {
      const button = document.getElementById('huntApply');
      if (button) button.disabled = !!on;
      if (text) this.say(text);
      if (!on) this.paintApply();
    },

    say(text, isError) {
      const bar = document.getElementById('huntStatusBar');
      if (!bar) return;
      bar.textContent = text || '';
      bar.classList.toggle('is-error', !!isError);
    }
  };

  if (typeof window !== 'undefined') window.PioHunt = PioHunt;
  if (typeof module !== 'undefined' && module.exports) module.exports = PioHunt;
})();
