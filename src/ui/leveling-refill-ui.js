/**
 * @file leveling-refill-ui.js
 * Modal da reposição automática de consumíveis.
 *
 * Uma configuração só, para todas as contas: o que varia entre contas é o ouro,
 * não o mínimo de poção que o usuário quer manter. Dez campos por conta seriam
 * um formulário que ninguém preenche.
 *
 * A lista de itens vem do processo principal (`leveling-refill.ITEMS`), não
 * daqui: as chaves gravadas em `prefs.json` têm uma única fonte, e acrescentar
 * um consumível no domínio já o faz aparecer nesta tela.
 *
 * Nada aqui valida de verdade — o planejador normaliza o que receber. Esta tela
 * só evita digitar número negativo sem perceber.
 */

(() => {
  'use strict';

  /** Rótulo de cada grupo, para as dez linhas não virarem uma lista plana. */
  const GROUPS = {
    hp: 'Poções de vida',
    mana: 'Poções de mana',
    revive: 'Revives',
    essence: 'Essência'
  };

  const PioRefill = {
    items: [],
    config: null,
    inputs: new Map(),

    /** Carrega a configuração salva e desenha as linhas. */
    async init() {
      const api = window.pokeAPI;
      if (!api || !api.levelingGetRefill) return;

      const data = await api.levelingGetRefill().catch(() => null);
      if (!data) {
        this.say('Não foi possível ler a configuração.', true);
        return;
      }

      this.items = data.items || [];
      this.config = data.config || { enabled: false, reserveGold: 0, items: {} };
      this.render();
      this.wire();
    },

    render() {
      const host = document.getElementById('refillItems');
      if (!host) return;

      const saved = this.config.items || {};
      let html = '';
      let group = null;

      for (const item of this.items) {
        if (item.group !== group) {
          group = item.group;
          html += `<h3 class="rf-group">${GROUPS[group] || group}</h3>`;
        }
        const rule = saved[item.key] || { min: 0, target: 0 };
        html += `
          <div class="rf-row">
            <span class="rf-label">${item.label}</span>
            <label class="rf-field">
              <span>mín</span>
              <input type="number" min="0" step="1" data-refill="${item.key}" data-field="min"
                value="${rule.min || 0}">
            </label>
            <label class="rf-field">
              <span>alvo</span>
              <input type="number" min="0" step="1" data-refill="${item.key}" data-field="target"
                value="${rule.target || 0}">
            </label>
          </div>`;
      }

      host.innerHTML = html;

      this.inputs = new Map();
      for (const input of host.querySelectorAll('[data-refill]')) {
        const key = input.dataset.refill;
        if (!this.inputs.has(key)) this.inputs.set(key, {});
        this.inputs.get(key)[input.dataset.field] = input;
      }

      const enabled = document.getElementById('refillEnabled');
      if (enabled) enabled.checked = !!this.config.enabled;
      const reserve = document.getElementById('refillReserve');
      if (reserve) reserve.value = this.config.reserveGold || 0;
    },

    wire() {
      const save = document.getElementById('refillSave');
      if (save) save.onclick = () => this.save();
    },

    /** Lê a tela. Números são deixados crus de propósito: o domínio normaliza. */
    collect() {
      const items = {};
      for (const [key, fields] of this.inputs) {
        items[key] = {
          min: +(fields.min && fields.min.value) || 0,
          target: +(fields.target && fields.target.value) || 0
        };
      }
      return {
        enabled: !!document.getElementById('refillEnabled').checked,
        reserveGold: +document.getElementById('refillReserve').value || 0,
        items
      };
    },

    async save() {
      const api = window.pokeAPI;
      const result = await api.levelingSetRefill(this.collect()).catch(e => ({ error: e.message }));
      if (!result || result.error) {
        this.say('Falha ao salvar: ' + ((result && result.error) || 'desconhecida'), true);
        return;
      }

      // Devolvido já normalizado: redesenhar mostra o `alvo` corrigido quando o
      // usuário digitou um mínimo maior que ele.
      this.config = result.config;
      this.render();

      const ligados = this.items.filter(i => this.config.items[i.key].min > 0).length;
      this.say(this.config.enabled
        ? (ligados ? `Salvo. ${ligados} ${ligados === 1 ? 'item' : 'itens'} em reposição.`
          : 'Salvo, mas nenhum item tem mínimo: nada será comprado.')
        : 'Salvo. A reposição está desligada.');
    },

    /** Último refill de qualquer conta, para o usuário ver que funcionou. */
    report(data) {
      if (!data) return;
      if (!data.ok) {
        this.say(`Conta ${data.index + 1}: compra recusada (${data.error}).`, true);
        return;
      }
      const resumo = (data.items || []).map(i => `${i.qty}× ${i.label}`).join(', ');
      this.say(`Conta ${data.index + 1}: ${resumo} — ${data.cost} de ouro.`);
    },

    say(text, isError) {
      const bar = document.getElementById('refillStatusBar');
      if (!bar) return;
      bar.textContent = text;
      bar.classList.toggle('is-error', !!isError);
    }
  };

  if (typeof window !== 'undefined') window.PioRefill = PioRefill;
  if (typeof module !== 'undefined' && module.exports) module.exports = PioRefill;
})();
