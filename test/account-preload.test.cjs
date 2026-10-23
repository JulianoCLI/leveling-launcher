/**
 * Valida o preload que faz a sessão atravessar monitor e WebView.
 *
 * O cliente web decide entre entrar e pedir login com isto, no bundle:
 *
 *   !(net.token && !await net.tokenLiveElsewhere() && await resumeSaved())
 *     && showLogin()
 *
 * `net.token` é `sessionStorage[chave]` e, na falta dele,
 * `localStorage['leveling.session-token']`. Então basta a chave estar no
 * `localStorage` antes de o bundle rodar para a conta voltar do monitor já
 * logada — e é exatamente isso que este preload garante.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PRELOAD = path.resolve(__dirname, '..', 'src', 'main', 'account-preload.js');
const TOKEN_KEY = 'leveling.session-token';

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: key => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: key => { delete data[key]; }
  };
}

/**
 * Roda o preload num ambiente de mentira. Ele age no `require`, como faria no
 * renderer, então montar o cenário antes é parte do teste.
 */
function run({ origin = 'https://levelingidle2d.com.br', token = '', storage = fakeStorage() } = {}) {
  const sent = [];
  const electron = {
    ipcRenderer: {
      sendSync: channel => (channel === 'leveling:token:get' ? token : undefined),
      send: (channel, payload) => sent.push({ channel, payload })
    }
  };

  const electronPath = require.resolve('electron');
  const previous = require.cache[electronPath];
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron };

  const savedWindow = global.window;
  const savedLocation = global.location;
  global.window = { localStorage: storage };
  global.location = { origin };

  delete require.cache[PRELOAD];
  try {
    require(PRELOAD);
  } finally {
    if (previous) require.cache[electronPath] = previous;
    else delete require.cache[electronPath];
    global.window = savedWindow;
    global.location = savedLocation;
  }

  return { storage, sent };
}

test('o token salvo entra no localStorage antes de o jogo carregar', () => {
  const { storage } = run({ token: 'tok-do-monitor' });

  assert.equal(storage.getItem(TOKEN_KEY), 'tok-do-monitor',
    'sem a chave gravada o cliente cai em showLogin()');
});

test('o token do principal vence o que ficou na página', () => {
  // O monitor renova o token a cada `auth_ok`; o que sobrou no navegador é de
  // uma sessão já substituída e só daria `session.expired` no resume.
  const { storage } = run({
    token: 'tok-novo',
    storage: fakeStorage({ [TOKEN_KEY]: 'tok-de-sessao-morta' })
  });

  assert.equal(storage.getItem(TOKEN_KEY), 'tok-novo');
});

test('sem token guardado nada é inventado', () => {
  const { storage } = run({ token: '' });

  assert.equal(storage.getItem(TOKEN_KEY), null, 'gravar vazio faria o resume falhar à toa');
});

test('o login feito na WebView volta para o processo principal', () => {
  const { storage, sent } = run({ token: '' });

  // É o que o cliente faz em `onAuthOk`.
  storage.setItem(TOKEN_KEY, 'tok-do-login-manual');

  assert.deepEqual(sent, [{ channel: 'leveling:token:set', payload: 'tok-do-login-manual' }],
    'sem isso o monitor seguinte precisaria logar de novo');
  assert.equal(storage.getItem(TOKEN_KEY), 'tok-do-login-manual',
    'a interceptação não pode engolir a escrita original');
});

test('logout limpa o token guardado também', () => {
  const { storage, sent } = run({ token: 'tok-velho' });
  sent.length = 0;

  storage.removeItem(TOKEN_KEY);

  assert.deepEqual(sent, [{ channel: 'leveling:token:set', payload: '' }]);
  assert.equal(storage.getItem(TOKEN_KEY), null);
});

test('escrever outras chaves não vira tráfego de IPC', () => {
  const { storage, sent } = run({ token: '' });

  storage.setItem('leveling.lite', '1');
  storage.removeItem('leveling.lite');

  assert.deepEqual(sent, [], 'o jogo grava muitas chaves; só a do token interessa');
});

test('origem estranha não recebe nem entrega token', () => {
  const { storage, sent } = run({ origin: 'https://anuncio.example', token: 'tok-secreto' });

  assert.equal(storage.getItem(TOKEN_KEY), null, 'o token não pode vazar para um iframe de terceiro');
  storage.setItem(TOKEN_KEY, 'forjado');
  assert.deepEqual(sent, [], 'e nada que venha de lá pode virar token da conta');
});
