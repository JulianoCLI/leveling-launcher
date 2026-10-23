const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * DOM mínimo: o painel só usa innerHTML, querySelector, value, textContent,
 * className e classList. Um stub é mais honesto aqui do que um navegador
 * inteiro, porque o que está em teste é a lógica de estado.
 */
function makeEl(tag = 'div') {
  const el = {
    tagName: tag,
    children: [],
    attrs: {},
    value: '',
    textContent: '',
    className: '',
    placeholder: '',
    title: '',
    disabled: false,
    onclick: null,
    onkeydown: null,
    _classes: new Set(),
    classList: {
      add: c => el._classes.add(c),
      remove: c => el._classes.delete(c),
      contains: c => el._classes.has(c),
      toggle: (c, on) => { if (on) el._classes.add(c); else el._classes.delete(c); }
    },
    querySelector: sel => el.children.find(c => c.matches(sel)) || null,
    querySelectorAll: sel => el.children.filter(c => c.matches(sel)),
    matches(sel) {
      const role = /\[data-role="([^"]+)"\]/.exec(sel);
      if (role) return this.attrs['data-role'] === role[1];
      const idx = /\[data-index="([^"]+)"\]/.exec(sel);
      if (idx) return this.attrs['data-index'] === idx[1];
      return false;
    }
  };
  Object.defineProperty(el, 'classList', { value: el.classList });
  return el;
}

/**
 * Monta os quatro cartões a partir do innerHTML que o painel escreve. Os
 * índices vêm do próprio HTML: com abas, a segunda aba escreve 4..7, e um
 * stub que renumerasse a partir de zero esconderia justamente esse erro.
 */
function makeRoot() {
  const root = makeEl();
  Object.defineProperty(root, 'innerHTML', {
    set(html) {
      const indices = [...html.matchAll(/class="lv-account" data-index="(\d+)"/g)].map(m => m[1]);
      root.children = indices.map(index => {
        const card = makeEl();
        card.attrs['data-index'] = index;
        const roles = ['pill', 'user', 'pass', 'save', 'toggle', 'proxy', 'saveProxy', 'meta'];
        card.children = roles.map(role => {
          const child = makeEl();
          child.attrs['data-role'] = role;
          return child;
        });
        return card;
      });
    },
    get() { return ''; }
  });
  return root;
}

function load(api, options = {}) {
  delete require.cache[require.resolve('../src/ui/leveling-panel')];
  const root = makeRoot();
  const statusBar = makeEl();
  global.window = { pokeAPI: api, PioHudMetrics: null };
  global.document = { activeElement: null, getElementById: () => null };

  const panel = require('../src/ui/leveling-panel');
  panel.init({ root, statusBar, ...options });
  return { panel, root, statusBar, card: i => root.children[i] };
}

/** Status público com `n` contas, a primeira já configurada. */
function creds(n) {
  return {
    encrypted: true,
    accounts: Array.from({ length: n }, (_, i) => ({
      username: i === 0 ? 'desjunior' : '',
      hasPassword: i === 0,
      hasToken: i === 0
    }))
  };
}

function field(card, role) {
  return card.querySelector(`[data-role="${role}"]`);
}

/** API que registra as chamadas e devolve os handlers para disparo manual. */
function makeApi(overrides = {}) {
  const calls = [];
  const handlers = {};
  const api = {
    calls,
    handlers,
    levelingGetCreds: async () => ({
      encrypted: true,
      accounts: [
        { username: 'desjunior', hasPassword: true, hasToken: true },
        { username: '', hasPassword: false, hasToken: false },
        { username: '', hasPassword: false, hasToken: false },
        { username: '', hasPassword: false, hasToken: false }
      ]
    }),
    levelingStatus: async () => ({ active: false, status: 'disconnected', state: null }),
    levelingStart: async i => { calls.push(['start', i]); return { ok: true }; },
    levelingStop: async i => { calls.push(['stop', i]); return { ok: true }; },
    levelingSetCreds: async (i, u, p) => {
      calls.push(['set', i, u, p]);
      return {
        ok: true,
        status: {
          encrypted: true,
          accounts: Array.from({ length: 4 }, (_, k) => k === i
            ? { username: u, hasPassword: !!p, hasToken: false }
            : { username: '', hasPassword: false, hasToken: false })
        }
      };
    },
    onLevelingStatus: cb => { handlers.status = cb; },
    onLevelingUpdate: cb => { handlers.update = cb; },
    onLevelingEnded: cb => { handlers.ended = cb; },
    onLevelingDeath: cb => { handlers.death = cb; },
    ...overrides
  };
  return api;
}

const tick = () => new Promise(r => setTimeout(r, 5));

test('monta quatro contas e carrega os indicadores salvos', async () => {
  const { root, card } = load(makeApi());
  await tick();

  assert.equal(root.children.length, 4);
  assert.equal(field(card(0), 'user').value, 'desjunior');
  assert.match(field(card(0), 'pass').placeholder, /Senha salva/);
  assert.equal(field(card(1), 'user').value, '');
  assert.equal(field(card(1), 'pass').placeholder, 'Senha');
});

test('ativar exige credencial salva', async () => {
  const { card } = load(makeApi());
  await tick();

  assert.equal(field(card(0), 'toggle').disabled, false, 'conta 0 tem senha salva');
  assert.equal(field(card(1), 'toggle').disabled, true, 'conta 1 não tem senha');
  assert.match(field(card(1), 'toggle').title, /Salve usuário e senha/);
});

test('salvar envia usuário e senha e limpa o campo', async () => {
  const api = makeApi();
  const { card, statusBar } = load(api);
  await tick();

  const c = card(1);
  field(c, 'user').value = ' cacador ';
  field(c, 'pass').value = 'segredo';
  await field(c, 'save').onclick();
  await tick();

  assert.deepEqual(api.calls[0], ['set', 1, 'cacador', 'segredo'], 'usuário vai sem espaços');
  assert.equal(field(c, 'pass').value, '', 'a senha não fica no DOM depois de salvar');
  assert.match(statusBar.textContent, /credenciais salvas/);
  assert.equal(field(c, 'toggle').disabled, false, 'agora dá para ativar');
});

test('salvar sem senha em conta nova avisa em vez de gravar vazio', async () => {
  const api = makeApi();
  const { card, statusBar } = load(api);
  await tick();

  const c = card(1);
  field(c, 'user').value = 'cacador';
  await field(c, 'save').onclick();
  await tick();

  assert.equal(api.calls.length, 0, 'nada é enviado');
  assert.match(statusBar.textContent, /informe a senha/);
});

test('senha em branco com credencial já salva não sobrescreve', async () => {
  const api = makeApi();
  const { card, statusBar } = load(api);
  await tick();

  await field(card(0), 'save').onclick();
  await tick();

  assert.equal(api.calls.length, 0, 'não pode apagar a senha guardada');
  assert.match(statusBar.textContent, /nada a salvar/);
});

test('ativar chama start e avisa que a aba do jogo vai cair', async () => {
  const api = makeApi();
  const { card, statusBar } = load(api);
  await tick();

  await field(card(0), 'toggle').onclick();
  await tick();

  assert.deepEqual(api.calls[0], ['start', 0]);
  assert.match(statusBar.textContent, /aba do jogo desta conta vai cair/);
  assert.equal(field(card(0), 'toggle').textContent, 'Desligar monitor');
});

test('campos travam enquanto o monitor está ligado', async () => {
  const api = makeApi();
  const { card } = load(api);
  await tick();

  api.handlers.status({ index: 0, status: 'connected' });

  const c = card(0);
  assert.equal(field(c, 'user').disabled, true);
  assert.equal(field(c, 'pass').disabled, true);
  assert.equal(field(c, 'save').disabled, true);
  assert.equal(field(c, 'pill').textContent, 'Monitorando');
  assert.ok(field(c, 'pill').className.includes('is-connected'));
});

test('desligar chama stop e libera os campos', async () => {
  const api = makeApi();
  const { card } = load(api);
  await tick();

  api.handlers.status({ index: 0, status: 'connected' });
  await field(card(0), 'toggle').onclick();
  await tick();

  assert.deepEqual(api.calls[0], ['stop', 0]);
  assert.equal(field(card(0), 'user').disabled, false);
  assert.equal(field(card(0), 'toggle').textContent, 'Ativar monitor');
});

test('erro do servidor aparece em português', async () => {
  const api = makeApi();
  const { card, panel } = load(api);
  await tick();

  api.handlers.status({ index: 0, status: 'error', error: 'ratelimit.login' });
  assert.match(field(card(0), 'meta').textContent, /Muitas tentativas de login/);

  api.handlers.status({ index: 0, status: 'error', error: 'account.invalid_credentials' });
  assert.match(field(card(0), 'meta').textContent, /Usuário ou senha incorretos/);

  // Código desconhecido não pode virar texto vazio.
  assert.equal(panel.describeError('algo.novo'), 'algo.novo');
});

test('session.replaced é explicado como handoff, não como falha', async () => {
  const api = makeApi();
  const { card } = load(api);
  await tick();

  api.handlers.status({ index: 0, status: 'connected' });
  api.handlers.ended({ index: 0, code: 'session.replaced' });

  const c = card(0);
  assert.match(field(c, 'meta').textContent, /voltou para o navegador/);
  assert.equal(field(c, 'pill').textContent, 'Desligado');
  assert.equal(field(c, 'user').disabled, false, 'os campos voltam a ser editáveis');
});

test('telemetria da caçada aparece na linha de detalhe', async () => {
  const api = makeApi();
  const { card } = load(api);
  await tick();

  api.handlers.status({ index: 0, status: 'connected' });
  api.handlers.update({
    index: 0,
    state: {
      game: 'leveling-idle',
      name: 'desjunior',
      level: 41,
      hunt: { gateId: 'castelo-demonios', kills: 248 },
      a: { xph: 376634 }
    }
  });

  const meta = field(card(0), 'meta').textContent;
  assert.match(meta, /Nv 41/);
  assert.match(meta, /castelo demonios/);
  assert.match(meta, /248 abates/);
});

test('morte é reportada sem sugerir ação do launcher', async () => {
  const api = makeApi();
  const { statusBar } = load(api);
  await tick();

  api.handlers.death({ index: 0, death: { dead: true } });
  assert.match(statusBar.textContent, /revive automático do servidor/);
});

test('start recusado pelo processo principal mostra o motivo', async () => {
  const api = makeApi({
    levelingStart: async () => ({ ok: false, error: 'Credenciais não configuradas.' })
  });
  const { card, statusBar } = load(api);
  await tick();

  await field(card(0), 'toggle').onclick();
  await tick();

  assert.match(statusBar.textContent, /Credenciais não configuradas/);
  assert.equal(field(card(0), 'toggle').textContent, 'Ativar monitor', 'não finge que ligou');
});

test('aviso quando o armazenamento seguro não está disponível', async () => {
  const api = makeApi({
    levelingGetCreds: async () => ({
      encrypted: false,
      accounts: [{ username: 'u', hasPassword: true, hasToken: false }]
    })
  });
  const { statusBar } = load(api);
  await tick();

  assert.match(statusBar.textContent, /senhas ficam em texto no disco/);
});

test('a segunda aba mostra as contas 5 a 8, não as quatro primeiras de novo', async () => {
  const api = makeApi({ levelingGetCreds: async () => creds(8) });
  const { panel, root } = load(api, { tabsRoot: null, tabs: 2 });
  await tick();

  panel.setTab(1);
  await tick();

  assert.equal(root.children.length, 4, 'uma aba mostra quatro cartões');
  assert.deepEqual(root.children.map(c => c.attrs['data-index']), ['4', '5', '6', '7']);
});

test('ligar o monitor na segunda aba usa o índice global da conta', async () => {
  const api = makeApi({
    levelingGetCreds: async () => ({
      encrypted: true,
      accounts: Array.from({ length: 8 }, () => ({ username: 'u', hasPassword: true, hasToken: false }))
    })
  });
  const { panel, card } = load(api, { tabsRoot: null, tabs: 2 });
  await tick();

  panel.setTab(1);
  await tick();
  await field(card(0), 'toggle').onclick();
  await tick();

  assert.deepEqual(api.calls, [['start', 4]], 'o primeiro cartão da aba 2 é a conta 5');
});

test('trocar de aba preserva o estado da conta que ficou monitorando', async () => {
  const api = makeApi({ levelingGetCreds: async () => creds(8) });
  const { panel, card } = load(api, { tabsRoot: null, tabs: 2 });
  await tick();

  api.handlers.status({ index: 0, status: 'connected' });
  panel.setTab(1);
  await tick();
  panel.setTab(0);
  await tick();

  assert.equal(field(card(0), 'toggle').textContent, 'Desligar monitor');
});

test('adicionar uma aba cria quatro contas vazias sem tocar nas existentes', async () => {
  const api = makeApi({ levelingGetCreds: async () => creds(4) });
  const { panel } = load(api, { tabsRoot: null, tabs: 1 });
  await tick();

  panel.setTabs(2);

  assert.equal(panel.accounts.length, 8);
  assert.equal(panel.accounts[0].username, 'desjunior');
  assert.equal(panel.accounts[7].hasPassword, false);
});

test('sem pokeAPI o painel monta sem quebrar', async () => {
  const { root } = load(undefined);
  await tick();
  assert.equal(root.children.length, 4);
});
