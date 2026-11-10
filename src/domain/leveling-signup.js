/**
 * @file leveling-signup.js
 * Regras de cadastro do jogo, copiadas do cliente oficial.
 *
 * As regras aqui não são suposição: saíram do bundle do jogo
 * (`/assets/main-*.js`) e foram confirmadas contra o servidor pelas sondas
 * `tools/signup-probe.js`, `tools/signup-rules-probe.js` e
 * `tools/signup-rules2-probe.js`. O que elas apuraram:
 *
 *   nome      /^[a-z0-9_-]{3,16}$/   e o cliente faz `.toLowerCase()` antes
 *   senha     >= 8 caracteres, com maiúscula, dígito e símbolo
 *   email     OBRIGATÓRIO, e o provedor é filtrado pelo servidor
 *   captcha   OBRIGATÓRIO (Cloudflare Turnstile)
 *
 * A ordem em que o servidor recusa é útil para diagnosticar, porque ele para
 * no primeiro problema:
 *
 *   account.invalid_hunter_name → nome fora da regex
 *   account.password_weak       → nome passou, senha fraca
 *   auth.email_invalid          → senha passou, email mal formado ou vazio
 *   auth.email_provider         → email bem formado, provedor recusado
 *   auth.captcha_failed         → tudo válido, falta o token do Turnstile
 *
 * CONSEQUÊNCIA PARA O CADASTRO EM LOTE: `auth.captcha_failed` é a última
 * barreira e não há como transpô-la sem um navegador. O Turnstile emite o
 * token a partir de um desafio ligado ao domínio do jogo; mandar `Register`
 * direto pelo socket nunca vai funcionar. Por isso este módulo não executa
 * cadastro: ele só prepara e valida os dados, e quem registra é a WebView,
 * onde o widget do Turnstile existe de verdade.
 */

'use strict';

/**
 * Regex do nome, idêntica à do cliente (`nle` no bundle). O cliente aplica
 * `trim().toLowerCase()` no campo antes de testar, então `Player01` passa e
 * chega ao servidor como `player01`.
 */
const USERNAME_RE = /^[a-z0-9_-]{3,16}$/;

/** Mínimo de caracteres da senha (`R9` no bundle). */
const PASSWORD_MIN = 8;

const GENDER_M = 1;
const GENDER_F = 2;

/**
 * As cinco classes, com os ids que o servidor usa.
 *
 * Medidos em `tools/awaken-probe.js`, que leu `content_catalog` de uma conta
 * logada: `guerreiro, assassino, mago, arqueiro, healer`. Os ids são em
 * português, com `healer` fora do padrão — e é por isso que medir importou: a
 * lista anterior, tirada do carrossel do bundle, usava `warrior`/`archer`/
 * `mage` e teria feito todo `ChooseClass` falhar.
 *
 * A fonte canônica continua sendo `ContentCatalog.classes`; esta lista é o que
 * o assistente mostra *antes* de haver sessão. Se divergirem, a do servidor
 * vence.
 */
const CLASSES = [
  { id: 'guerreiro', name: 'Guerreiro' },
  { id: 'assassino', name: 'Assassino' },
  { id: 'arqueiro', name: 'Arqueiro' },
  { id: 'mago', name: 'Mago' },
  { id: 'healer', name: 'Curandeiro' }
];

/**
 * Normaliza o nome como o cliente faz antes de validar e enviar.
 * Normalizar e validar são coisas separadas: quem monta o nome precisa saber
 * qual forma vai de fato para o servidor.
 */
function normalizeUsername(username) {
  return String(username == null ? '' : username).trim().toLowerCase();
}

/** O nome é aceito? Normaliza antes, como o cliente. */
function validateUsername(username) {
  return USERNAME_RE.test(normalizeUsername(username));
}

/**
 * As quatro condições de senha, uma por posição, na mesma ordem do cliente
 * (`z9` no bundle). Devolver o detalhe em vez de um booleano permite dizer ao
 * usuário o que falta, em vez de só "senha fraca".
 *
 * O teste de símbolo é "não é letra, não é número e não é espaço", com as
 * classes Unicode do cliente — e não uma lista fixa de pontuação.
 */
function passwordChecks(password) {
  const p = String(password == null ? '' : password);
  return {
    length: [...p].length >= PASSWORD_MIN,
    upper: /\p{Uppercase}/u.test(p),
    digit: /[0-9]/.test(p),
    symbol: /[^\p{Alphabetic}\p{N}\s]/u.test(p)
  };
}

/** A senha passa em todas as condições? */
function validatePassword(password) {
  const c = passwordChecks(password);
  return c.length && c.upper && c.digit && c.symbol;
}

/**
 * Valida o email com a mesma função do cliente (`V9` no bundle).
 * Devolve o email normalizado, ou `null` se for inválido.
 *
 * Isto só cobre o formato. Se o provedor é aceito, só o servidor sabe: ele
 * responde `auth.email_provider` para domínios que recusa, incluindo os
 * descartáveis.
 */
function normalizeEmail(email) {
  const t = String(email == null ? '' : email).trim().toLowerCase();
  if (t.length < 6 || t.length > 254 || !/^[\x21-\x7e]+$/.test(t)) return null;
  const partes = t.split('@');
  if (partes.length !== 2) return null;
  const [local, dominio] = partes;
  if (local.length < 1 || local.length > 64) return null;
  const rotulos = dominio.split('.');
  if (rotulos.length < 2 || rotulos.some(r => !r)) return null;
  return t;
}

/** Atalho booleano de `normalizeEmail`. */
function validateEmail(email) {
  return normalizeEmail(email) !== null;
}

/**
 * Gera uma senha que satisfaz as quatro condições por construção, em vez de
 * sortear e torcer: uma maiúscula, uma minúscula, um dígito e um símbolo
 * garantidos, o resto aleatório, e tudo embaralhado no fim.
 *
 * Usa `crypto.randomInt`, não `Math.random`: é uma credencial.
 */
function generatePassword(length = 16) {
  const { randomInt } = require('node:crypto');
  const n = Math.max(PASSWORD_MIN, Number(length) || 16);

  const maiusculas = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const minusculas = 'abcdefghijkmnopqrstuvwxyz';
  const digitos = '23456789';
  // Símbolos sem os que atrapalham em shell, URL ou CSV.
  const simbolos = '!@#$%*-_+=?';
  const todos = maiusculas + minusculas + digitos + simbolos;

  const pega = alfabeto => alfabeto[randomInt(alfabeto.length)];
  const chars = [pega(maiusculas), pega(minusculas), pega(digitos), pega(simbolos)];
  while (chars.length < n) chars.push(pega(todos));

  // Fisher-Yates, para o prefixo não denunciar a estrutura.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * Monta os nomes de uma série: prefixo mais um número com largura fixa.
 *
 * O padding sai do tamanho da série, não de um `02` fixo: pedir 150 contas
 * com largura 2 geraria `p100` e `p1000` lado a lado, desalinhados.
 */
function buildUsernames(prefix, count, start = 1) {
  const base = normalizeUsername(prefix);
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const inicio = Math.max(0, Math.floor(Number(start) || 0));
  const largura = String(inicio + n - 1).length;

  const nomes = [];
  for (let i = 0; i < n; i++) {
    nomes.push(`${base}${String(inicio + i).padStart(largura, '0')}`);
  }
  return nomes;
}

/**
 * Monta um plano de cadastro, já validado item por item.
 *
 * Não filtra em silêncio o que é inválido: um nome recusado volta em
 * `invalid`, com o motivo. Sumir com a linha faria o usuário pedir 20 contas,
 * receber 14 e não saber por quê.
 *
 * `emailTemplate` aceita `{user}`, substituído pelo nome da conta. O email é
 * obrigatório no cadastro, então sem template não há plano válido.
 */
function buildPlan(opts = {}) {
  const {
    prefix = '',
    count = 1,
    start = 1,
    gender = GENDER_M,
    classId = '',
    referral = '',
    emailTemplate = '',
    passwordLength = 16
  } = opts;

  const genero = Number(gender) === GENDER_F ? GENDER_F : GENDER_M;
  const items = [];
  const invalid = [];

  for (const username of buildUsernames(prefix, count, start)) {
    const motivos = [];
    if (!USERNAME_RE.test(username)) {
      motivos.push(username.length > 16
        ? 'nome passa de 16 caracteres'
        : username.length < 3
          ? 'nome tem menos de 3 caracteres'
          : 'nome só aceita letras minúsculas, números, _ e -');
    }

    const email = String(emailTemplate || '').replace(/\{user\}/g, username);
    const emailOk = emailTemplate ? normalizeEmail(email) : null;
    if (!emailTemplate) motivos.push('email é obrigatório no cadastro');
    else if (!emailOk) motivos.push('email fora do formato aceito');

    if (motivos.length) {
      invalid.push({ username, reasons: motivos });
      continue;
    }

    items.push({
      username,
      password: generatePassword(passwordLength),
      email: emailOk,
      gender: genero,
      classId: String(classId || '').trim(),
      referral: String(referral || '').trim()
    });
  }

  return { items, invalid };
}

/**
 * Estado de um item durante o cadastro.
 *
 * `awaiting_captcha` existe porque o Turnstile é o passo que o launcher não
 * pode resolver sozinho: o item para aqui e espera a WebView.
 *
 *   pending → awaiting_captcha → registering → choosing_class → done
 *                                                             ↘ failed
 */
const SIGNUP_STATES = [
  'pending', 'awaiting_captcha', 'registering', 'choosing_class', 'done', 'failed'
];

class SignupItem {
  constructor(plan, index) {
    this.plan = plan;
    this.index = index;
    this.state = 'pending';
    this.error = '';
    this.token = '';
  }

  /** O item foi para a fila da WebView e espera o token do Turnstile. */
  awaitCaptcha() {
    this.state = 'awaiting_captcha';
  }

  /** O token chegou e o `Register` está em voo. */
  start() {
    this.state = 'registering';
  }

  /** `auth_ok` recebido. Falta a classe. */
  registered(token) {
    this.token = String(token || '');
    this.state = 'choosing_class';
  }

  done() {
    this.state = 'done';
  }

  /**
   * Guarda o código do servidor como veio (`auth.captcha_failed`,
   * `account.password_weak`, ...). É o que permite dizer ao usuário o que
   * aconteceu, em vez de "falhou".
   */
  fail(error) {
    this.state = 'failed';
    this.error = String(error || 'unknown');
  }

  toJSON() {
    return {
      index: this.index,
      username: this.plan.username,
      state: this.state,
      error: this.error,
      hasToken: !!this.token
    };
  }
}

/**
 * Monta o `Register` do envelope.
 *
 * `captchaToken` não tem padrão: sem ele o servidor responde
 * `auth.captcha_failed`, e é melhor falhar de forma óbvia do que mandar vazio
 * e deixar a mensagem confusa.
 */
function buildRegisterCommand(item, opts = {}) {
  const plan = item.plan || item;
  if (!opts.captchaToken) {
    throw new Error('captcha_token é obrigatório: o servidor recusa Register sem ele');
  }
  return {
    register: {
      username: plan.username,
      password: plan.password,
      gender: plan.gender,
      referral_code: plan.referral || '',
      email: plan.email || '',
      captcha_token: opts.captchaToken,
      locale: opts.locale || 'pt-BR'
    }
  };
}

/** Monta o `ChooseClass`. O `class_id` vem do `content_catalog` do servidor. */
function buildChooseClassCommand(classId) {
  const id = String(classId || '').trim();
  if (!id) throw new Error('class_id vazio');
  return { choose_class: { class_id: id } };
}

module.exports = {
  USERNAME_RE,
  PASSWORD_MIN,
  GENDER_M,
  GENDER_F,
  CLASSES,
  SIGNUP_STATES,
  normalizeUsername,
  validateUsername,
  passwordChecks,
  validatePassword,
  normalizeEmail,
  validateEmail,
  generatePassword,
  buildUsernames,
  buildPlan,
  SignupItem,
  buildRegisterCommand,
  buildChooseClassCommand
};
