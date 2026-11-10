/**
 * @file leveling-signup.test.cjs
 * Testes das regras de cadastro.
 *
 * Os casos aqui não são inventados: cada regra foi lida no bundle do cliente
 * e confirmada contra o servidor pelas sondas em `tools/signup*-probe.js`.
 * Os comentários dizem de onde veio cada número, para que uma mudança futura
 * nas regras seja uma decisão e não um acidente.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  USERNAME_RE,
  PASSWORD_MIN,
  GENDER_M,
  GENDER_F,
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
} = require('../src/domain/leveling-signup.js');

// ----------------------------------------------------------------- username

test('signup: a regex do nome é a mesma do cliente', () => {
  assert.equal(USERNAME_RE.source, '^[a-z0-9_-]{3,16}$');
});

test('signup: o nome é normalizado para minúsculas, como o cliente faz', () => {
  assert.equal(normalizeUsername('  Player01  '), 'player01');
  // Maiúscula passa porque o cliente converte antes de validar.
  assert.ok(validateUsername('Player01'));
});

test('signup: o nome vai de 3 a 16 caracteres', () => {
  // Confirmado pelo servidor: 2 dá invalid_hunter_name, 3 passa,
  // 16 passa e 17 volta a falhar.
  assert.ok(!validateUsername('ab'));
  assert.ok(validateUsername('abc'));
  assert.ok(validateUsername('a'.repeat(16)));
  assert.ok(!validateUsername('a'.repeat(17)));
});

test('signup: o nome aceita _ e -, e recusa ponto, espaço e acento', () => {
  // Tabela verificada em tools/signup-rules-probe.js, etapa B.
  assert.ok(validateUsername('abc_def'));
  assert.ok(validateUsername('abc-def'));
  assert.ok(validateUsername('_abcdef'));
  assert.ok(!validateUsername('abc.def'));
  assert.ok(!validateUsername('abc def'));
  assert.ok(!validateUsername('abcdéf'));
  assert.ok(!validateUsername('abcçef'));
  assert.ok(!validateUsername('abc!ef'));
});

// -------------------------------------------------------------------- senha

test('signup: a senha exige 8 caracteres, maiúscula, dígito e símbolo', () => {
  assert.equal(PASSWORD_MIN, 8);

  // Confirmado pelo servidor: estas quatro passaram da etapa de senha.
  assert.ok(validatePassword('Ab1!xyzw'));
  assert.ok(validatePassword('ABCDEF1!'));
  assert.ok(validatePassword('Abcdef1@'));

  // E estas foram recusadas como password_weak.
  assert.ok(!validatePassword('Ab1!xyz'), '7 caracteres é curto');
  assert.ok(!validatePassword('abcdefg!'), 'falta maiúscula e dígito');
  assert.ok(!validatePassword('Abcdefg1'), 'falta símbolo');
  assert.ok(!validatePassword('Abcdefg!'), 'falta dígito');
  assert.ok(!validatePassword('abcdef1!'), 'falta maiúscula');
});

test('signup: espaço não conta como símbolo', () => {
  // O servidor recusou "Abcdef1 ": o teste do cliente exclui \s.
  assert.ok(!validatePassword('Abcdef1 '));
});

test('signup: passwordChecks aponta qual condição falhou', () => {
  const c = passwordChecks('abcdefgh');
  assert.equal(c.length, true);
  assert.equal(c.upper, false);
  assert.equal(c.digit, false);
  assert.equal(c.symbol, false);
});

test('signup: generatePassword sempre satisfaz as quatro condições', () => {
  // Por construção, não por sorte: vale repetir para pegar regressão.
  for (let i = 0; i < 200; i++) {
    const senha = generatePassword();
    assert.ok(validatePassword(senha), `senha gerada inválida: ${senha}`);
  }
});

test('signup: generatePassword respeita o mínimo mesmo se pedirem menos', () => {
  assert.ok(generatePassword(4).length >= PASSWORD_MIN);
  assert.equal(generatePassword(24).length, 24);
});

test('signup: generatePassword não repete', () => {
  const vistas = new Set();
  for (let i = 0; i < 100; i++) vistas.add(generatePassword());
  assert.equal(vistas.size, 100);
});

// -------------------------------------------------------------------- email

test('signup: o email segue a validação do cliente', () => {
  assert.equal(normalizeEmail('  ABC@Def.Com '), 'abc@def.com');
  assert.ok(validateEmail('abc@def.com'));
  assert.ok(validateEmail('abc+tag@def.com'));

  assert.ok(!validateEmail(''), 'vazio');
  assert.ok(!validateEmail('abc'), 'sem arroba');
  assert.ok(!validateEmail('abc@'), 'sem domínio');
  assert.ok(!validateEmail('abc@def'), 'domínio sem ponto');
  assert.ok(!validateEmail('a@b.c'), 'curto demais, menos de 6');
  assert.ok(!validateEmail('a@b@c.com'), 'duas arrobas');
  assert.ok(!validateEmail('abc@def..com'), 'rótulo vazio no domínio');
});

// --------------------------------------------------------------- usernames

test('signup: buildUsernames alinha a largura pelo maior número', () => {
  assert.deepEqual(buildUsernames('p', 3), ['p1', 'p2', 'p3']);
  assert.deepEqual(buildUsernames('p', 10), [
    'p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08', 'p09', 'p10'
  ]);
  // A largura vem do fim da série, para não misturar p099 com p100.
  assert.equal(buildUsernames('p', 101)[0], 'p001');
});

test('signup: buildUsernames aceita começar de outro número', () => {
  assert.deepEqual(buildUsernames('p', 3, 8), ['p08', 'p09', 'p10']);
});

// -------------------------------------------------------------------- plano

const EMAIL_OK = '{user}@exemplo.com';

test('signup: buildPlan monta itens completos', () => {
  const { items, invalid } = buildPlan({
    prefix: 'hero', count: 3, gender: GENDER_F,
    classId: 'alguma-classe', referral: 'CODE123', emailTemplate: EMAIL_OK
  });

  assert.equal(invalid.length, 0);
  assert.equal(items.length, 3);
  assert.equal(items[0].username, 'hero1');
  assert.equal(items[0].email, 'hero1@exemplo.com');
  assert.equal(items[0].gender, GENDER_F);
  assert.equal(items[0].classId, 'alguma-classe');
  assert.equal(items[0].referral, 'CODE123');
  assert.ok(validatePassword(items[0].password));
});

test('signup: buildPlan explica o que recusou, em vez de sumir com a linha', () => {
  // Prefixo de 16 chars mais o número passa de 16.
  const { items, invalid } = buildPlan({
    prefix: 'a'.repeat(16), count: 2, emailTemplate: EMAIL_OK
  });
  assert.equal(items.length, 0);
  assert.equal(invalid.length, 2);
  assert.match(invalid[0].reasons[0], /16/);
});

test('signup: buildPlan recusa o plano sem email, que é obrigatório', () => {
  const { items, invalid } = buildPlan({ prefix: 'hero', count: 2 });
  assert.equal(items.length, 0);
  assert.equal(invalid.length, 2);
  assert.ok(invalid[0].reasons.some(r => /email/.test(r)));
});

test('signup: buildPlan usa prefixo normalizado', () => {
  const { items } = buildPlan({ prefix: '  HERO  ', count: 1, emailTemplate: EMAIL_OK });
  assert.equal(items[0].username, 'hero1');
});

// ---------------------------------------------------------------- SignupItem

test('signup: SignupItem passa pelo estado de espera do captcha', () => {
  const item = new SignupItem({ username: 'test01' }, 0);
  assert.equal(item.state, 'pending');

  item.awaitCaptcha();
  assert.equal(item.state, 'awaiting_captcha');

  item.start();
  assert.equal(item.state, 'registering');

  item.registered('token123');
  assert.equal(item.state, 'choosing_class');
  assert.equal(item.token, 'token123');

  item.done();
  assert.equal(item.state, 'done');
});

test('signup: SignupItem guarda o código do servidor como veio', () => {
  const item = new SignupItem({ username: 'test01' }, 0);
  item.fail('auth.captcha_failed');
  assert.equal(item.state, 'failed');
  assert.equal(item.error, 'auth.captcha_failed');
});

// ----------------------------------------------------------------- comandos

test('signup: buildRegisterCommand recusa montar sem captcha', () => {
  // O servidor responde auth.captcha_failed; falhar aqui é mais claro.
  const item = new SignupItem({
    username: 'hero1', password: 'Abcdef1!', email: 'a@b.com',
    gender: GENDER_M, referral: ''
  }, 0);
  assert.throws(() => buildRegisterCommand(item), /captcha/);
});

test('signup: buildRegisterCommand monta o envelope do jogo', () => {
  const item = new SignupItem({
    username: 'hero1', password: 'Abcdef1!', email: 'a@b.com',
    gender: GENDER_M, referral: 'CODE'
  }, 0);
  const cmd = buildRegisterCommand(item, { captchaToken: 'tk' });

  assert.deepEqual(cmd, {
    register: {
      username: 'hero1',
      password: 'Abcdef1!',
      gender: GENDER_M,
      referral_code: 'CODE',
      email: 'a@b.com',
      captcha_token: 'tk',
      locale: 'pt-BR'
    }
  });
});

test('signup: buildChooseClassCommand exige um class_id', () => {
  assert.deepEqual(buildChooseClassCommand('guerreiro'), {
    choose_class: { class_id: 'guerreiro' }
  });
  assert.throws(() => buildChooseClassCommand(''), /class_id/);
});
