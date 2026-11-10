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
/**
 * Formulário de autenticação de mentira, com os ids que o bundle do jogo usa.
 *
 * Os campos registram cada evento que recebem porque é isso que importa no
 * preenchimento: o jogo lê os valores de um estado próprio que só acompanha o
 * evento `input`, então mexer em `.value` sem disparar não preenche nada.
 *
 * A aba de cadastro entra no cenário porque o bundle remonta o formulário a
 * cada troca: email e confirmação só existem depois do clique em
 * `#slAuthTab-register`. Aqui ela apenas registra o clique e passa a se
 * declarar selecionada, que é o sinal que o preload consulta.
 */
function fakeForm(ids, { comAba = true } = {}) {
  const campos = {};
  for (const id of ids) {
    campos[id] = { id, value: '', events: [], dispatchEvent(e) { this.events.push(e.type); return true; } };
  }

  const aba = comAba
    ? {
        id: 'slAuthTab-register',
        selecionada: false,
        cliques: 0,
        getAttribute: name => (name === 'aria-selected' ? (aba.selecionada ? 'true' : 'false') : null),
        click() { aba.cliques++; aba.selecionada = true; }
      }
    : null;

  return {
    campos,
    aba,
    document: {
      readyState: 'complete',
      getElementById: id => (aba && id === aba.id ? aba : campos[id] || null),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      documentElement: {}
    }
  };
}

/** Observador de mentira: o preload só o instancia, e aqui nada muta sozinho. */
class FakeMutationObserver {
  observe() {}
  disconnect() {}
}

function run({
  origin = 'https://levelingidle2d.com.br',
  token = '',
  storage = fakeStorage(),
  prefill = null,
  doc = null
} = {}) {
  const sent = [];
  const electron = {
    ipcRenderer: {
      sendSync: channel => {
        if (channel === 'leveling:token:get') return token;
        if (channel === 'leveling:signup:prefill') return prefill;
        return undefined;
      },
      send: (channel, payload) => sent.push({ channel, payload })
    }
  };

  const electronPath = require.resolve('electron');
  const previous = require.cache[electronPath];
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron };

  const savedWindow = global.window;
  const savedLocation = global.location;
  const savedDocument = global.document;
  const savedObserver = global.MutationObserver;
  global.window = { localStorage: storage };
  global.location = { origin };
  if (doc) {
    global.document = doc;
    // O observador só existe nos cenários que o querem. Sem ele o preload sai
    // pela guarda de `watchPostSignup` — e é o que os testes de preenchimento
    // precisam: com observador, o teto de três minutos ficaria armado e
    // prenderia o processo depois do teste passar.
    global.MutationObserver = doc.comObservador ? FakeMutationObserver : undefined;
  }

  delete require.cache[PRELOAD];
  try {
    require(PRELOAD);
  } finally {
    if (previous) require.cache[electronPath] = previous;
    else delete require.cache[electronPath];
    global.window = savedWindow;
    global.location = savedLocation;
    global.document = savedDocument;
    global.MutationObserver = savedObserver;
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

/*
 * Preenchimento do formulário. Existe porque o cadastro exige um token do
 * Cloudflare Turnstile, apurado em `tools/signup-rules2-probe.js`: o launcher
 * não consegue cadastrar sozinho, mas consegue deixar só o captcha para o
 * usuário.
 */

const CAMPOS = ['slAuth-username', 'slAuth-password', 'slAuth-email', 'slAuth-confirm'];

test('o cadastro pendente preenche nome, senha, email e confirmação', () => {
  const { campos, document } = fakeForm(CAMPOS);
  run({
    doc: document,
    prefill: {
      mode: 'register', username: 'cacador1',
      password: 'Abcdef1!', email: 'cacador1@exemplo.com'
    }
  });

  assert.equal(campos['slAuth-username'].value, 'cacador1');
  assert.equal(campos['slAuth-password'].value, 'Abcdef1!');
  assert.equal(campos['slAuth-email'].value, 'cacador1@exemplo.com');
  assert.equal(campos['slAuth-confirm'].value, 'Abcdef1!',
    'a confirmação repete a senha; deixá-la vazia só faria o envio falhar');
});

test('preencher dispara input, senão o jogo não vê o valor', () => {
  const { campos, document } = fakeForm(CAMPOS);
  run({
    doc: document,
    prefill: { mode: 'register', username: 'u1', password: 'Abcdef1!', email: 'a@b.com' }
  });

  // O bundle guarda os campos num objeto atualizado no `input`. Sem o evento,
  // o formulário sai em branco apesar de parecer cheio na tela.
  for (const id of CAMPOS) {
    assert.deepEqual(campos[id].events, ['input'], `${id} precisa do evento input`);
  }
});

test('o preenchimento abre a aba de cadastro antes de procurar os campos', () => {
  // O bundle remonta o formulário a cada troca de aba, e email e confirmação
  // não existem na de login. Sem este clique o cadastro ficava só com o nome.
  const { aba, document } = fakeForm(CAMPOS);
  run({
    doc: document,
    prefill: { mode: 'register', username: 'u1', password: 'Abcdef1!', email: 'a@b.com' }
  });

  assert.equal(aba.cliques, 1, 'a aba de cadastro precisa ser escolhida');
});

test('no login a aba de cadastro fica em paz', () => {
  const { aba, document } = fakeForm(['slAuth-username', 'slAuth-password']);
  run({
    doc: document,
    prefill: { mode: 'login', username: 'conta', password: 'senha', email: '' }
  });

  assert.equal(aba.cliques, 0, 'trocar de aba jogaria o usuário para o cadastro');
});

test('no login só o nome e a senha são preenchidos', () => {
  // A aba de login não tem email nem confirmação: os ids não existem, e pedir
  // por eles não pode derrubar o preenchimento do resto.
  const { campos, document } = fakeForm(['slAuth-username', 'slAuth-password']);
  run({
    doc: document,
    prefill: { mode: 'login', username: 'conta', password: 'senha', email: '' }
  });

  assert.equal(campos['slAuth-username'].value, 'conta');
  assert.equal(campos['slAuth-password'].value, 'senha');
});

test('sem credencial guardada o formulário fica intocado', () => {
  // Um campo preenchido sozinho com dado de outra conta seria pior que vazio.
  const { campos, document } = fakeForm(CAMPOS);
  run({ doc: document, prefill: null });

  assert.equal(campos['slAuth-username'].value, '');
  assert.deepEqual(campos['slAuth-username'].events, []);
});

/*
 * Os modais que o jogo abre numa conta recém-criada. A sequência foi lida no
 * bundle: pedido de email (`ale`), escolha de classe (`Dse`), confirmação por
 * `ui.confirm` e convite de visual (`Ose`). Cada um é resolvido por clique no
 * DOM, então o teste encena o DOM e confere os cliques.
 */
function fakePostSignupDom({ classes = ['Guerreiro', 'Mago', 'Curandeiro'] } = {}) {
  const cliques = [];
  const aberto = { email: true, classe: true, confirmar: false, visual: true };
  let escolhida = '';

  const btn = (nome, ao) => ({
    nome,
    disabled: false,
    click() { cliques.push(nome); if (ao) ao(); },
    querySelector: () => null,
    querySelectorAll: () => []
  });

  const emailBtn = btn('email-depois', () => { aberto.email = false; });
  const confirmaBtn = btn('classe-confirmar', () => { aberto.confirmar = false; });
  const visualBtn = btn('visual-pular', () => { aberto.visual = false; });

  const tituloEmail = {
    id: 'slEmailPrompt-title',
    closest: sel => (sel === '.slModal' && aberto.email
      ? { querySelector: s => (s === '.slModalActions .slBtn-secondary' ? emailBtn : null) }
      : null)
  };

  const cards = classes.map(nome => ({
    disabled: false,
    click() { cliques.push('card:' + nome); escolhida = nome; },
    querySelector: sel => (sel === '.slCharClsName' ? { textContent: nome } : null),
    querySelectorAll: () => []
  }));

  // O primário do painel só habilita com um cartão marcado, e é ele que abre a
  // confirmação — como no bundle.
  const escolherBtn = btn('classe-escolher', () => {
    if (!escolhida) return;
    aberto.classe = false;
    aberto.confirmar = true;
  });

  const painelClasse = {
    querySelectorAll: sel => (sel === '.slCharClsCard' ? cards : []),
    querySelector: sel => (sel === '.slHudClassPickActions button:not([disabled])' ? escolherBtn : null)
  };

  const visual = {
    querySelector: sel => (sel === '.slHudClassPickActions button' ? visualBtn : null)
  };

  const modalConfirma = {
    querySelectorAll: sel => (sel === '.slModalActions button'
      ? [btn('classe-cancelar'), confirmaBtn]
      : [])
  };

  // O formulário também existe nesta cena, preenchido sem drama: o que
  // interessa aqui é o que vem depois dele, e um autofill que falhasse deixaria
  // o observador dele esperando à toa.
  const form = fakeForm(CAMPOS);

  return {
    cliques,
    escolhida: () => escolhida,
    document: {
      readyState: 'complete',
      documentElement: {},
      comObservador: true,
      addEventListener() {},
      getElementById: id => {
        if (id === 'slEmailPrompt-title') return aberto.email ? tituloEmail : null;
        return form.document.getElementById(id);
      },
      querySelector: sel => {
        if (sel === '.slHudClassPick:not([hidden])') return aberto.classe ? painelClasse : null;
        if (sel === '.slModalFundo .slModal') return aberto.confirmar ? modalConfirma : null;
        if (sel === '.slHudWelcomeLook') return aberto.visual ? visual : null;
        return null;
      },
      querySelectorAll: () => []
    }
  };
}

test('depois do cadastro os quatro modais são resolvidos na ordem', () => {
  const cena = fakePostSignupDom();
  const { sent } = run({
    doc: cena.document,
    prefill: {
      mode: 'register', username: 'u1', password: 'Abcdef1!',
      email: 'a@b.com', classId: 'mago'
    }
  });

  assert.deepEqual(cena.cliques,
    ['email-depois', 'card:Mago', 'classe-escolher', 'classe-confirmar', 'visual-pular'],
    'cada passo depende do anterior ter fechado seu modal');
  assert.equal(cena.escolhida(), 'Mago', 'a classe do plano é a que entra');
  assert.ok(sent.some(m => m.channel === 'leveling:signup:post-done'),
    'sem este aviso a janela não fecha e o monitor nunca liga');
});

test('o id em português casa com o nome visível da classe', () => {
  // O catálogo manda `healer`, e o cartão mostra "Curandeiro": casar por
  // igualdade exata deixaria essa classe sem escolher.
  const cena = fakePostSignupDom();
  run({
    doc: cena.document,
    prefill: {
      mode: 'register', username: 'u1', password: 'Abcdef1!',
      email: 'a@b.com', classId: 'guerreiro'
    }
  });

  assert.equal(cena.escolhida(), 'Guerreiro');
});

test('sem classe definida os outros modais ainda são dispensados', () => {
  const cena = fakePostSignupDom();
  const { sent } = run({
    doc: cena.document,
    prefill: {
      mode: 'register', username: 'u1', password: 'Abcdef1!',
      email: 'a@b.com', classId: ''
    }
  });

  assert.deepEqual(cena.cliques, ['email-depois', 'visual-pular'],
    'escolher classe por conta própria seria decidir pelo usuário');
  assert.ok(sent.some(m => m.channel === 'leveling:signup:post-done'));
});

test('no login os modais pós-cadastro não são vigiados', () => {
  // Numa conta que já existe eles não aparecem, e o observador custaria por
  // cada repintura do jogo sem nada para fazer.
  const cena = fakePostSignupDom();
  run({
    doc: cena.document,
    prefill: { mode: 'login', username: 'u1', password: 'p', email: '' }
  });

  assert.deepEqual(cena.cliques, []);
});

test('origem estranha não recebe nem entrega token', () => {
  const { storage, sent } = run({ origin: 'https://anuncio.example', token: 'tok-secreto' });

  assert.equal(storage.getItem(TOKEN_KEY), null, 'o token não pode vazar para um iframe de terceiro');
  storage.setItem(TOKEN_KEY, 'forjado');
  assert.deepEqual(sent, [], 'e nada que venha de lá pode virar token da conta');
});
