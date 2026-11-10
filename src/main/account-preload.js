/**
 * @file account-preload.js
 * Preload da WebView de cada conta. Faz a sessão atravessar os dois modos.
 *
 * O cliente web guarda o token de sessão em `localStorage['leveling.session-token']`
 * e, se ele estiver lá, entra por `resume` em vez de pedir login. O monitor
 * headless recebe um token novo a cada `auth_ok` e o guarda cifrado no processo
 * principal — mas num armazenamento que a página não vê, porque o monitor nem
 * tem renderer.
 *
 * Este arquivo liga as duas pontas:
 *
 *   1. na entrada, grava o token conhecido antes de qualquer script do jogo
 *      rodar, para que sair do monitor devolva a conta já logada;
 *   2. na saída, avisa o principal quando a própria página troca o token
 *      (login manual, renovação), para que o monitor seguinte também entre por
 *      `resume`.
 *
 * Roda antes dos scripts da página, então o passo 1 chega a tempo. O principal
 * identifica a conta pela partição de sessão de quem chamou, não por um índice
 * vindo daqui.
 */

'use strict';

const { ipcRenderer } = require('electron');

const TOKEN_KEY = 'leveling.session-token';

/** Só a página do jogo; um iframe de anúncio ou de pagamento não recebe nada. */
function isGameOrigin() {
  try {
    return location.origin === 'https://levelingidle2d.com.br';
  } catch {
    return false;
  }
}

function seedToken() {
  let token = '';
  try {
    // Síncrono de propósito: assíncrono perderia a corrida com o bundle.
    token = ipcRenderer.sendSync('leveling:token:get') || '';
  } catch {
    return;
  }
  if (!token) return;

  try {
    // Sobrescreve sempre. O token do principal é o mais novo por construção: o
    // monitor o renova a cada `auth_ok` e o login da própria página é capturado
    // por `watchToken`. O que estiver no `localStorage` é de uma sessão que já
    // foi substituída, e tentar `resume` com ele só devolve a tela de login.
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // localStorage bloqueado (modo restrito): a conta só pede login de novo.
  }
}

/**
 * Observa a chave em vez de pesquisar em intervalo: o `setItem` do jogo é o
 * único momento em que o token muda, e interceptá-lo não custa nada enquanto
 * nada acontece.
 */
function watchToken() {
  let storage;
  try {
    storage = window.localStorage;
    if (!storage) return;
  } catch {
    return;
  }

  const report = value => {
    try {
      ipcRenderer.send('leveling:token:set', value || '');
    } catch {}
  };

  const original = storage.setItem.bind(storage);
  const remove = storage.removeItem.bind(storage);

  try {
    storage.setItem = function (key, value) {
      original(key, value);
      if (key === TOKEN_KEY) report(value);
    };
    storage.removeItem = function (key) {
      remove(key);
      // Logout limpa a chave; o token guardado também não vale mais.
      if (key === TOKEN_KEY) report('');
    };
  } catch {
    // Storage congelado por alguma política: segue sem captura.
  }
}

function watchWebgl() {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  const report = kind => {
    try {
      ipcRenderer.send('graphics:webgl', kind);
    } catch {}
  };

  // O jogo pode criar vários canvas; escutar no document cobre tanto o canvas
  // atual quanto os que surgirem depois sem tocar no código remoto do jogo.
  document.addEventListener('webglcontextlost', () => report('contextlost'), true);
  document.addEventListener('webglcontextrestored', () => report('contextrestored'), true);
}

/**
 * Captura as credenciais de login/cadastro.
 * 
 * Observa o formulário de autenticação e, quando o usuário envia, lê os campos
 * e avisa o processo principal. O token que chegar logo depois confirma que
 * o login foi bem-sucedido.
 */
function watchAuthSubmit() {
  // O preload roda antes da página; em teste não há DOM nenhum. Sem o guarda,
  // a função derruba tudo que vem depois dela, inclusive a semeadura do token.
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;

  let lastSeenCreds = { username: '', password: '' };

  // Observa o input de senha para capturar o que o usuário digitou.
  document.addEventListener(
    'input',
    e => {
      if (e.target && e.target.type === 'password') {
        lastSeenCreds.password = e.target.value;
      } else if (e.target && (e.target.type === 'text' || e.target.type === 'email')) {
        // Usuário ou email próximo ao campo de senha é o username.
        const context = e.target.parentElement || document;
        const passField = context.querySelector('input[type="password"]');
        if (passField) lastSeenCreds.username = e.target.value;
      }
    },
    true
  );

  // Captura o envio do formulário.
  document.addEventListener(
    'submit',
    e => {
      if (!e.target || !e.target.closest('[data-role="login"], form')) return;

      const form = e.target.closest('form') || e.target;
      const passField = form.querySelector('input[type="password"]');
      const userField = form.querySelector('input[type="text"], input[type="email"]');

      if (!passField || !userField) return;

      const username = (userField.value || '').trim();
      const password = (passField.value || '').trim();

      if (username && password) {
        try {
          ipcRenderer.send('leveling:creds:capture', {
            username,
            password,
            kind: 'login' // Ou 'register' se detectado formulário de cadastro
          });
        } catch {
          // Erro ao enviar, continua mesmo assim
        }
      }
    },
    true
  );
}

/**
 * Preenche o formulário de autenticação com a credencial guardada.
 *
 * Existe por causa do assistente de cadastro: o cadastro exige um token do
 * Cloudflare Turnstile, que só nasce dentro de um navegador de verdade. O
 * launcher não consegue cadastrar sozinho, mas consegue tirar do caminho tudo
 * o que não é o captcha — o nome que precisa casar com a regex, a senha com
 * maiúscula, dígito e símbolo, o email. Resta um clique no desafio.
 *
 * Preenche e para. Não envia o formulário: o `submit` é o consentimento do
 * usuário, e disparar isso sozinho criaria contas sem ele pedir.
 *
 * O formulário é montado pelo bundle depois da página carregar, então observar
 * é melhor que esperar: o `MutationObserver` pega o momento em que os campos
 * aparecem, inclusive quando o usuário alterna entre login e cadastro.
 */
function autofillAuth() {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return null;

  let dados;
  try {
    dados = ipcRenderer.sendSync('leveling:signup:prefill');
  } catch {
    return null;
  }
  if (!dados || !dados.username) return null;

  /*
   * O jogo lê os campos por um objeto próprio, atualizado no evento `input` —
   * então mexer só em `.value` deixaria o estado interno vazio e o envio sairia
   * em branco. O evento é a parte que faz o preenchimento valer.
   */
  const preencher = (campo, valor) => {
    if (!campo || !valor || campo.value === valor) return false;
    campo.value = valor;
    campo.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };

  /*
   * A tela abre na aba de login, e os campos de email e confirmação **não
   * existem** até a aba de cadastro ser escolhida: o bundle remonta o
   * formulário a cada troca (`ce()` em `slAuthTab-*`). Clicar na aba é parte do
   * preenchimento, não um extra — sem isso o cadastro ficava só com o nome.
   *
   * O id vem do bundle: `slAuthTab-register`, irmão de `slAuthTab-login`.
   */
  const abrirAbaCadastro = () => {
    const aba = document.getElementById('slAuthTab-register');
    if (!aba) return false;
    if (aba.getAttribute('aria-selected') === 'true') return true;
    aba.click();
    return aba.getAttribute('aria-selected') === 'true';
  };

  /**
   * Preenche o que der. Devolve `true` só quando **todos** os campos daquele
   * modo estão prontos.
   *
   * Exigir o conjunto completo é o que corrigiu o preenchimento pela metade: a
   * versão anterior parava no primeiro sucesso, e como o campo de nome aparece
   * antes dos de cadastro, ela desistia com o formulário quase vazio.
   */
  const tentar = () => {
    const cadastro = dados.mode === 'register';
    if (cadastro && !abrirAbaCadastro()) return false;

    const user = document.getElementById('slAuth-username');
    const pass = document.getElementById('slAuth-password');
    if (!user || !pass) return false;

    preencher(user, dados.username);
    preencher(pass, dados.password);
    if (!cadastro) return !!user.value && !!pass.value;

    const email = document.getElementById('slAuth-email');
    const confirm = document.getElementById('slAuth-confirm');
    preencher(email, dados.email);
    preencher(confirm, dados.password);

    return !!(user.value && pass.value && email && email.value && confirm && confirm.value);
  };

  if (tentar()) return dados;

  // O formulário ainda não existe. Observa até aparecer, e desiste depois: um
  // observador vivo pela sessão inteira pagaria por cada mutação do jogo, que
  // repinta muito, para um ganho que só existe nos primeiros segundos.
  const observer = new MutationObserver(() => {
    if (tentar()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 30000);
  return dados;
}

/**
 * Cuida do que vem **depois** do captcha: os modais que o jogo abre numa conta
 * recém-criada.
 *
 * A sequência foi lida no bundle, não suposta:
 *
 *   1. `ale()` abre o pedido de email (`#slEmailPrompt-title`). O botão
 *      secundário é `auth.email_prompt.later` — "Depois" —, que só fecha o
 *      modal (`f()`), sem mandar nada ao servidor.
 *   2. `Dse()` abre a escolha de classe (`.slHudClassPick`) quando
 *      `!identity.classId && level >= rules.awaken_level`. O `awaken_level`
 *      medido no servidor é **1**, então a conta nova já escolhe.
 *   3. Escolhida a classe, o jogo pede confirmação por `ui.confirm` — um
 *      `.slModal` com dois botões, cancelar primeiro e confirmar depois.
 *   4. Confirmada, se a conta tem `appearanceFreeSave`, `Ose()` abre o convite
 *      de visual, cujo único botão é `hud.welcome_look.skip`, em
 *      `.slHudWelcomeLook`.
 *
 * Tudo por clique no DOM, e não por mensagem ao servidor, porque é o cliente
 * que sabe a hora de cada passo. Clicar é também o que mantém o jogo e o
 * launcher com a mesma visão do estado.
 *
 * `classId` vazio significa "não escolha classe": os modais de email e visual
 * ainda são dispensados, mas a classe fica para o usuário.
 */
function watchPostSignup(classId) {
  if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return;

  const clicar = el => {
    if (!el || el.disabled) return false;
    el.click();
    return true;
  };

  const feito = { email: false, classe: false, confirmada: false, visual: false };

  /** O modal de email: fecha com o botão secundário, que é o "Depois". */
  const passoEmail = () => {
    if (feito.email) return;
    const titulo = document.getElementById('slEmailPrompt-title');
    if (!titulo) return;
    const modal = titulo.closest('.slModal');
    const depois = modal && modal.querySelector('.slModalActions .slBtn-secondary');
    if (clicar(depois)) feito.email = true;
  };

  /**
   * A escolha de classe. O cartão certo é achado pelo nome da classe no
   * `.slCharClsName`, porque o cartão não carrega o id em nenhum atributo —
   * é só um `<button>` com `onclick` ligado por closure.
   */
  const passoClasse = () => {
    if (feito.classe || !classId) return;
    const painel = document.querySelector('.slHudClassPick:not([hidden])');
    if (!painel) return;

    const alvo = (classId || '').toLowerCase();
    for (const card of painel.querySelectorAll('.slCharClsCard')) {
      const nome = card.querySelector('.slCharClsName');
      const texto = (nome && nome.textContent || '').trim().toLowerCase();
      // O catálogo manda os ids em português (`guerreiro`, `healer`), e o nome
      // visível é o mesmo em quatro das cinco classes. `includes` nos dois
      // sentidos cobre "Curandeiro" para o id `healer`.
      if (!texto || (texto !== alvo && !texto.includes(alvo) && !alvo.includes(texto))) continue;
      if (!clicar(card)) continue;
      // O botão primário só habilita depois do cartão selecionado, e o bundle
      // o remonta no mesmo tique: ele é buscado de novo na próxima passada.
      const botao = painel.querySelector('.slHudClassPickActions button:not([disabled])');
      if (clicar(botao)) feito.classe = true;
      return;
    }
  };

  /**
   * A confirmação da classe. É o `ui.confirm` genérico, e os botões não têm id:
   * a ordem do bundle é cancelar e depois confirmar, então o **último** botão é
   * o que confirma.
   *
   * Preso ao painel de classe aberto de propósito: um `.slModal` qualquer na
   * tela não deve ter o último botão clicado por iniciativa nossa.
   */
  const passoConfirmar = () => {
    if (!feito.classe || feito.confirmada) return;
    const modal = document.querySelector('.slModalFundo .slModal');
    if (!modal || document.getElementById('slEmailPrompt-title')) return;
    const botoes = modal.querySelectorAll('.slModalActions button');
    if (botoes.length < 2) return;
    if (clicar(botoes[botoes.length - 1])) feito.confirmada = true;
  };

  /** O convite de visual: um botão só, `hud.welcome_look.skip`. */
  const passoVisual = () => {
    if (feito.visual) return;
    const card = document.querySelector('.slHudWelcomeLook');
    if (!card) return;
    const pular = card.querySelector('.slHudClassPickActions button');
    if (clicar(pular)) feito.visual = true;
  };

  const passar = () => {
    try {
      passoEmail();
      passoClasse();
      passoConfirmar();
      passoVisual();
    } catch { /* o jogo repintou no meio; a próxima passada tenta de novo */ }

    if (feito.email && feito.visual && (!classId || feito.confirmada)) encerrar();
  };

  const observer = new MutationObserver(passar);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  // Os modais aparecem em resposta a pushes do servidor, que podem chegar sem
  // mutação nenhuma entre eles: o intervalo cobre essa folga.
  const timer = setInterval(passar, 700);

  let encerrado = false;
  function encerrar() {
    if (encerrado) return;
    encerrado = true;
    observer.disconnect();
    clearInterval(timer);
    // O teto de tempo também sai: deixá-lo armado manteria a página presa a um
    // trabalho que já acabou, e o `encerrar` rodaria duas vezes.
    clearTimeout(limite);
    try {
      ipcRenderer.send('leveling:signup:post-done');
    } catch { /* a janela já fechou */ }
  }

  // Teto de tempo: um observador e um intervalo vivos para sempre custariam a
  // sessão inteira por um trabalho que dura segundos.
  const limite = setTimeout(encerrar, 180000);
  passar();
}

if (isGameOrigin()) {
  seedToken();
  watchToken();
  watchWebgl();
  watchAuthSubmit();

  /**
   * Depois do DOM existir: as duas funções consultam `document`, e no preload a
   * página ainda está vazia.
   *
   * `watchPostSignup` só roda num cadastro pendente. Numa conta que já existe
   * os modais não aparecem, e deixar um observador à espera deles custaria por
   * cada repintura do jogo sem nada para fazer.
   */
  const iniciar = () => {
    const dados = autofillAuth();
    if (dados && dados.mode === 'register') watchPostSignup(dados.classId);
  };

  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar, { once: true });
  } else {
    iniciar();
  }
}
