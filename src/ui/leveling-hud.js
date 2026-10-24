/**
 * @file leveling-hud.js
 * HUD de um painel: cobre a WebView quando o monitor headless assume a conta.
 *
 * Só desenha o que `hud-metrics.js` resolve, então as colunas vêm do adapter do
 * jogo e não deste arquivo. Nada aqui manda comando: é um painel de leitura.
 */

(() => {
  'use strict';

  const STATUS_TEXT = {
    disconnected: 'Desligado',
    connecting: 'Conectando',
    connected: 'Monitorando',
    reconnecting: 'Reconectando',
    error: 'Erro'
  };

  const PioLevelingHud = {
    /**
     * @param {HTMLElement} host elemento que recebe o HUD (um por painel)
     */
    create(host) {
      host.innerHTML = `
        <div class="lh-head">
          <span class="lh-name" data-role="name">—</span>
          <span class="lh-level" data-role="level"></span>
          <span class="lh-status" data-role="status">Desligado</span>
        </div>
        <div class="lh-hp"><span data-role="hpfill"></span></div>
        <div class="lh-hptext" data-role="hptext"></div>
        <div class="lh-alert" data-role="alert" hidden></div>
        <div class="lh-grid" data-role="grid"></div>
        <div class="lh-party" data-role="party" hidden></div>
        <div class="lh-refill" data-role="refill" hidden></div>
        <div class="lh-foot" data-role="foot"></div>
      `;

      const pick = role => host.querySelector(`[data-role="${role}"]`);
      const el = {
        name: pick('name'), level: pick('level'), status: pick('status'),
        hpfill: pick('hpfill'), hptext: pick('hptext'), alert: pick('alert'),
        grid: pick('grid'), party: pick('party'), refill: pick('refill'),
        foot: pick('foot')
      };

      const escape = text => String(text).replace(/[&<>"]/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
      ));

      return {
        host,

        setStatus(status, error) {
          el.status.textContent = STATUS_TEXT[status] || status || '—';
          el.status.className = 'lh-status is-' + (status || 'disconnected');
          if (error) {
            el.foot.textContent = error;
          } else if (status === 'connecting') {
            el.foot.textContent = 'Entrando na conta…';
          }
        },

        /**
         * @param {boolean} [handoff] a conta assumiu em outro lugar. Sem isso,
         *   uma queda de sessão parecia encerramento definitivo, quando o
         *   monitor está só reconectando.
         */
        setEnded(code, handoff) {
          if (!code) {
            el.foot.textContent = '';
            return;
          }
          const assumida = handoff === undefined
            ? code === 'session.replaced' || code === 'session.duplicate'
            : !!handoff;
          el.foot.textContent = assumida
            ? 'Sessão assumida em outro lugar — a conta voltou para o jogo.'
            : `Sessão caiu (${code}) — reconectando…`;
        },

        /** Atualiza identidade, HP, alerta e colunas a partir do estado bruto. */
        update(state) {
          if (!state) return;
          const metrics = window.PioHudMetrics;
          el.name.textContent = state.name || '—';
          el.level.textContent = state.level ? 'Nv ' + state.level : '';

          const hp = +state.hp || 0;
          const maxHp = +state.maxHp || 0;
          if (maxHp > 0) {
            const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100));
            el.hpfill.style.width = pct + '%';
            el.hpfill.className = pct < 25 ? 'is-low' : (pct < 60 ? 'is-mid' : '');
            el.hptext.textContent = `${metrics.format.num(hp)} / ${metrics.format.num(maxHp)}`;
          } else {
            el.hpfill.style.width = '0%';
            el.hptext.textContent = '';
          }

          const resolved = metrics.resolve(state);

          if (resolved.banner) {
            el.alert.hidden = false;
            el.alert.textContent = resolved.banner.text;
            el.alert.className = 'lh-alert is-' + resolved.banner.kind;
          } else {
            el.alert.hidden = true;
          }

          // Recria a grade só quando o conjunto de colunas muda; o caso comum é
          // atualização de valores, que não deve mexer no DOM mais do que preciso.
          const signature = resolved.columns.map(c => c.key).join(',');
          if (signature !== this._signature) {
            this._signature = signature;
            el.grid.innerHTML = resolved.columns.map(c => `
              <div class="lh-cell" data-key="${c.key}">
                <span class="lh-label">${c.label}</span>
                <span class="lh-value">—</span>
              </div>
            `).join('');
          }
          for (const column of resolved.columns) {
            const cell = el.grid.querySelector(`.lh-cell[data-key="${column.key}"] .lh-value`);
            if (cell && cell.textContent !== column.value) cell.textContent = column.value;
          }

          // Nomes vêm de outros jogadores, então vão escapados para o HTML.
          const roster = resolved.roster;
          if (roster) {
            const rows = roster.rows.map(row => `
              <div class="lh-member is-${row.state}${row.self ? ' is-self' : ''}">
                <span class="lh-member-name">${row.leader ? '★ ' : ''}${escape(row.name)}</span>
                <span class="lh-member-detail">${escape(row.detail)}</span>
                <span class="lh-member-hp">${escape(row.hp)}</span>
              </div>
            `).join('');
            const html = `<div class="lh-party-title">${escape(roster.title)}</div>${rows}`;
            if (el.party.innerHTML !== html) el.party.innerHTML = html;
            el.party.hidden = false;
          } else {
            el.party.hidden = true;
            el.party.innerHTML = '';
          }

          // Última reposição desta conta. Fica visível porque é a única coisa
          // que o monitor faz com o ouro do usuário: ela precisa aparecer.
          // A viagem tem prioridade sobre o histórico: enquanto a conta está
          // fora da caçada por conta do launcher, é isso que precisa estar na
          // tela, senão a cena virar cidade parece um bug.
          const refill = state.refill;
          let texto = '';
          let modo = '';
          if (state.refillTrip) {
            texto = '⚗️ Comprando na cidade…';
            modo = 'trip';
          } else if (refill && refill.error) {
            texto = `⚗️ Reposição falhou — ${refill.error}`;
            modo = 'erro';
          } else if (refill && refill.items && refill.items.length) {
            const resumo = refill.items.map(i => `${i.qty}× ${i.label}`).join(', ');
            texto = `⚗️ ${resumo} — ${metrics.format.num(refill.cost)} de ouro`;
          }
          if (texto) {
            if (el.refill.textContent !== texto) el.refill.textContent = texto;
            if (el.refill.dataset.mode !== modo) el.refill.dataset.mode = modo;
            el.refill.hidden = false;
          } else {
            el.refill.hidden = true;
          }

          const hunt = state.hunt || {};
          if (hunt.gateId) el.foot.textContent = String(hunt.gateId).replace(/[_-]+/g, ' ');
        },

        clear() {
          this._signature = '';
          el.name.textContent = '—';
          el.level.textContent = '';
          el.alert.hidden = true;
          el.grid.innerHTML = '';
          el.party.hidden = true;
          el.party.innerHTML = '';
          el.refill.hidden = true;
          el.refill.textContent = '';
          el.refill.dataset.mode = '';
          el.foot.textContent = '';
          el.hptext.textContent = '';
          el.hpfill.style.width = '0%';
        }
      };
    }
  };

  if (typeof window !== 'undefined') window.PioLevelingHud = PioLevelingHud;
  if (typeof module !== 'undefined' && module.exports) module.exports = PioLevelingHud;
})();
