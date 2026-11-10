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
        <div class="lh-place" data-role="place" hidden>
          <span class="lh-place-label" data-role="placeLabel"></span>
          <span class="lh-place-map" data-role="placeMap"></span>
          <span class="lh-place-detail" data-role="placeDetail"></span>
        </div>
        <div class="lh-groups" data-role="grid"></div>
        <div class="lh-loot" data-role="loot" hidden></div>
        <div class="lh-party" data-role="party" hidden></div>
        <div class="lh-refill" data-role="refill" hidden></div>
        <div class="lh-foot" data-role="foot"></div>
      `;

      const pick = role => host.querySelector(`[data-role="${role}"]`);
      const el = {
        name: pick('name'), level: pick('level'), status: pick('status'),
        hpfill: pick('hpfill'), hptext: pick('hptext'), alert: pick('alert'),
        grid: pick('grid'), party: pick('party'), refill: pick('refill'),
        loot: pick('loot'),
        foot: pick('foot'), place: pick('place'), placeLabel: pick('placeLabel'),
        placeMap: pick('placeMap'), placeDetail: pick('placeDetail')
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

          const place = resolved.location;
          if (place) {
            el.placeLabel.textContent = place.label;
            el.placeMap.textContent = place.map;
            el.placeDetail.textContent = place.detail || '';
            el.place.classList.toggle('is-hunting', !!place.hunting);
            el.place.hidden = false;
          } else {
            el.place.hidden = true;
          }

          // Recria a grade só quando o conjunto de colunas muda; o caso comum é
          // atualização de valores, que não deve mexer no DOM mais do que preciso.
          // A assinatura inclui o bloco de cada coluna: uma coluna que muda de
          // bloco precisa de DOM novo, e só a chave não contaria isso.
          const signature = resolved.groups
            .map(g => g.id + ':' + g.columns.map(c => c.key).join(',')).join('|');
          if (signature !== this._signature) {
            this._signature = signature;
            el.grid.innerHTML = resolved.groups.map(group => `
              <section class="lh-group">
                ${group.title ? `<h3 class="lh-group-title">${escape(group.title)}</h3>` : ''}
                <div class="lh-grid">
                  ${group.columns.map(c => `
                    <div class="lh-cell" data-key="${c.key}">
                      <span class="lh-label">${c.label}</span>
                      <span class="lh-value">—</span>
                      <span class="lh-hint" hidden></span>
                    </div>
                  `).join('')}
                </div>
              </section>
            `).join('');
          }
          for (const column of resolved.columns) {
            const cell = el.grid.querySelector(`.lh-cell[data-key="${column.key}"]`);
            if (!cell) continue;
            const value = cell.querySelector('.lh-value');
            if (value.textContent !== column.value) value.textContent = column.value;
            const hint = cell.querySelector('.lh-hint');
            if (hint.textContent !== column.hint) hint.textContent = column.hint;
            hint.hidden = !column.hint;
            // `dataset` em vez de classe: o tom é um eixo só e sobrescrever a
            // classe inteira apagaria `lh-cell`.
            const tone = column.tone || '';
            if (cell.dataset.tone !== tone) cell.dataset.tone = tone;
          }

          // O que caiu. Nomes de item vêm do servidor e as cores de raridade
          // também, então os dois vão escapados — `color` entra num `style`,
          // que é o lugar onde uma string solta faz mais estrago.
          const loot = resolved.loot;
          if (loot && (loot.items.length || loot.log.length)) {
            const cor = c => (/^#[0-9a-f]{3,8}$/i.test(String(c)) ? String(c) : '');
            const itens = loot.items.map(it => `
              <div class="lh-drop${it.key ? ' is-key' : ''}">
                <span class="lh-drop-qty">${escape(it.qty)}×</span>
                <span class="lh-drop-name"${cor(it.color) ? ` style="color:${cor(it.color)}"` : ''}>${escape(it.name)}</span>
                <span class="lh-drop-bag">${escape(it.bag)}</span>
              </div>
            `).join('');
            const log = loot.log.map(ev => `
              <div class="lh-droplog-row${ev.key ? ' is-key' : ''}">
                <span class="lh-droplog-time">${escape(ev.time)}</span>
                <span class="lh-droplog-qty">+${escape(ev.qty)}</span>
                <span class="lh-droplog-name"${cor(ev.color) ? ` style="color:${cor(ev.color)}"` : ''}>${escape(ev.name)}${
                  // "drop" não aparece: dizer num registro de drops que algo
                  // é drop é ruído. Baú, boss e correio aparecem, porque eles
                  // explicam um item que não veio de matar monstro.
                  ev.reason ? `<span class="lh-droplog-reason">${escape(ev.reason)}</span>` : ''
                }</span>
                <span class="lh-droplog-bag">${escape(ev.bag ? `${ev.bag} na bolsa` : '')}</span>
              </div>
            `).join('');
            const html = `
              <div class="lh-loot-title">${escape(loot.title)}</div>
              <div class="lh-drops">${itens}</div>
              ${log ? `<div class="lh-droplog">${log}</div>` : ''}
            `;
            if (el.loot.innerHTML !== html) el.loot.innerHTML = html;
            el.loot.hidden = false;
          } else {
            el.loot.hidden = true;
            el.loot.innerHTML = '';
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

          // O mapa saiu do rodapé para o bloco `lh-place`; o rodapé volta a ser
          // só de status e erro, que é o que ele sabe escrever.
        },

        clear() {
          this._signature = '';
          el.name.textContent = '—';
          el.level.textContent = '';
          el.alert.hidden = true;
          el.place.hidden = true;
          el.place.classList.remove('is-hunting');
          el.grid.innerHTML = '';
          el.loot.hidden = true;
          el.loot.innerHTML = '';
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
