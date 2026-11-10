(() => {
  'use strict';
  const api = window.pokeAPI;
  if (!api || !api.othersGet) return;
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const clock = value => value ? new Date(Number(value)).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const state = { config: {}, accounts: [], log: [], stats: {} };
  let saveTimer = null;

  function render() {
    const c = state.config;
    $('othersControls').innerHTML = `
      <label><input type="checkbox" data-key="enabled" ${c.enabled ? 'checked' : ''}> Ativar automações</label>
      <label><input type="checkbox" data-key="daily" ${c.daily ? 'checked' : ''}> Resgatar diárias</label>
      <label><input type="checkbox" data-key="bestTeam" ${c.bestTeam ? 'checked' : ''}> Montar melhor time</label>
      <label><input type="checkbox" data-key="mail" ${c.mail ? 'checked' : ''}> Auto-correio</label>
      <label>Intervalo <input type="number" min="60000" step="60000" data-key="intervalMs" value="${Number(c.intervalMs) || 600000}"></label>`;
    $('othersAccounts').innerHTML = state.accounts.map(account => `
      <label class="lv-account"><span>${esc(account.name || account.username || `Conta ${account.index + 1}`)}</span>
      <span>${account.connected ? 'conectada' : 'offline'}</span>
      <input type="checkbox" data-account="${account.index}" ${!(c.disabled || []).includes(account.index) ? 'checked' : ''}>
    </label>`).join('') || '<p class="hint">Nenhuma conta configurada.</p>';
    $('othersLog').innerHTML = state.log.slice(0, 100).map(row => `
      <div class="lv-auto-log-row ${row.ok === false ? 'is-warn' : ''}">
        <b>${clock(row.atMs)}</b> <span>${esc(row.operation || '')}</span>
        ${row.index == null ? '' : `<span>conta ${Number(row.index) + 1}</span>`}
        <span>${row.ok === false ? 'falhou' : 'ok'}</span>
        <small>${esc(row.error || '')}</small>
      </div>`).join('') || '<p class="hint">Nenhuma rodada registrada.</p>';
    const s = state.stats || {};
    $('othersStatus').textContent = `Rodadas: ${s.runs || 0} · contas processadas: ${s.processed || 0} · sucesso: ${s.succeeded || 0} · falhas: ${s.failed || 0}`;
  }

  async function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const result = await api.othersSet(state.config).catch(() => null);
      if (result) apply(result);
    }, 120);
  }

  function apply(result) {
    if (result.config) state.config = result.config;
    if (result.accounts) state.accounts = result.accounts;
    if (result.log) state.log = result.log;
    if (result.stats) state.stats = result.stats;
    render();
  }

  $('othersControls').addEventListener('change', event => {
    const input = event.target;
    const key = input.dataset.key;
    if (!key) return;
    state.config[key] = input.type === 'checkbox' ? input.checked : Number(input.value);
    save();
  });
  $('othersAccounts').addEventListener('change', event => {
    const index = Number(event.target.dataset.account);
    if (!Number.isInteger(index)) return;
    const disabled = new Set(state.config.disabled || []);
    if (event.target.checked) disabled.delete(index); else disabled.add(index);
    state.config.disabled = [...disabled].sort((a, b) => a - b);
    save();
  });
  $('othersPoll').onclick = async () => apply(await api.othersPoll().catch(() => null) || {});
  $('othersClear').onclick = async () => { await api.othersLogClear(); state.log = []; render(); };
  api.onOthers(data => { state.log.unshift(data); render(); });
  api.othersGet().then(apply).catch(() => { $('othersStatus').textContent = 'Não foi possível ler a configuração.'; });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && api.marketWindowClose) api.marketWindowClose();
  });
})();
