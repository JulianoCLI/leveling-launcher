/**
 * @file signup-rules2-probe.js
 * Fecha as regras do cadastro que a sonda anterior deixou em aberto.
 *
 * O que já está provado (signup-probe.js e signup-rules-probe.js):
 *   - `Register` NÃO exige `captcha_token`. Cadastro headless é viável.
 *   - username: 3 a 16 caracteres; aceita [A-Za-z0-9_-]; recusa ponto,
 *     espaço, acento, cedilha e símbolos.
 *   - senha: precisa de símbolo. Maiúscula + minúscula + dígito não basta.
 *   - `email` é OBRIGATÓRIO: assim que a senha passa, o servidor responde
 *     `auth.email_invalid` em vez de aceitar.
 *
 * O que falta, e é o que esta sonda mede:
 *   1. qual exatamente é a exigência de senha? (símbolo basta? precisa das
 *      quatro classes? qual o comprimento mínimo?)
 *   2. que formato de email o servidor aceita? descartáveis passam?
 *   3. com username, senha e email válidos, `Register` devolve `auth_ok`?
 *   4. a conta nasce sem classe, exigindo `ChooseClass`?
 *
 * A etapa 3 cria UMA conta de verdade, com nome `pb<timestamp>`.
 *
 *   npx electron tools/signup-rules2-probe.js
 *   npx electron tools/signup-rules2-probe.js --criar   (vai até criar a conta)
 *
 * Ferramenta de investigação, não parte do launcher.
 */

'use strict';

const path = require('path');
const { app } = require('electron');

const WS_URL = 'wss://game.levelingidle2d.com.br:8443/ws';
const ORIGIN = 'https://levelingidle2d.com.br';

app.name = 'leveling-launcher';
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'leveling-launcher'));
} catch {}

const log = (...a) => console.log(...a);
const opts = process.argv.slice(2);
const CRIAR = opts.includes('--criar');

let contador = 0;
const nomeNovo = () => `pb${Date.now().toString(36)}${(contador++).toString(36)}`;

app.whenReady().then(async () => {
  const { getCodec } = require('../src/domain/leveling-codec');
  const codec = getCodec();

  let ws = null;
  let nextId = 1;
  const pending = new Map();
  const pushes = [];

  async function abrir() {
    ws = new WebSocket(WS_URL, { headers: { Origin: ORIGIN } });
    ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('conexão falhou'));
      setTimeout(() => reject(new Error('timeout')), 20000);
    });
    ws.onmessage = e => {
      let pkt;
      try { pkt = codec.decode(Buffer.from(e.data)); } catch { return; }
      const entry = pending.get(pkt.requestId);
      if (entry) {
        pending.delete(pkt.requestId);
        entry({ caseName: pkt.caseName, value: pkt.value || {} });
        return;
      }
      pushes.push({ caseName: pkt.caseName, value: pkt.value || {} });
    };
    ws.onclose = () => { ws = null; };
  }

  async function enviar(caseName, value, timeoutMs = 10000) {
    if (!ws) await abrir();
    const id = nextId++;
    ws.send(codec.encode(id, caseName, value));
    return new Promise(resolve => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ caseName: 'TIMEOUT', value: {} }); }, timeoutMs);
      pending.set(id, v => { clearTimeout(timer); resolve(v); });
    });
  }

  /** Código curto do resultado, para as tabelas. */
  async function tentar(campos) {
    const r = await enviar('register', {
      username: nomeNovo(), gender: 1, locale: 'pt_BR', ...campos
    });
    if (r.caseName === 'auth_ok') return { tag: 'CRIOU', r };
    return { tag: (r.value && r.value.code) || r.caseName, r };
  }

  const FRACA = 'account.password_weak';
  const EMAIL = 'auth.email_invalid';

  try {
    // ------------------------------------------------------------- 1. senha
    // `email_invalid` aqui é boa notícia: significa que a senha passou e o
    // servidor seguiu para o campo seguinte.
    log('== 1. exigência real de senha (email vazio de propósito)');
    log('   "email_invalid" significa: a SENHA foi aceita\n');
    const senhas = [
      ['Ab1!', 4],
      ['Ab1!xy', 6],
      ['Ab1!xyz', 7],
      ['Ab1!xyzw', 8],
      ['abcdefg!', 8],
      ['ABCDEFG!', 8],
      ['1234567!', 8],
      ['Abcdefg!', 8],
      ['abcdef1!', 8],
      ['ABCDEF1!', 8],
      ['Abcdefg1', 8],
      ['Abcdef1@', 8],
      ['Abcdef1#', 8],
      ['Abcdef1$', 8],
      ['Abcdef1 ', 8]
    ];
    for (const [senha, n] of senhas) {
      const { tag } = await tentar({ password: senha, email: '' });
      const veredito = tag === EMAIL ? 'SENHA OK' : tag === FRACA ? 'fraca' : tag;
      log(`   ${JSON.stringify(senha).padEnd(18)} ${String(n).padStart(2)} chars  ${veredito}`);
    }

    // -------------------------------------------------------------- 2. email
    log('\n== 2. formato de email aceito (senha já válida)');
    const BOA = 'Abcdef1!';
    const emails = [
      ['', 'vazio'],
      ['abc', 'sem arroba'],
      ['abc@', 'sem domínio'],
      ['abc@def', 'domínio sem ponto'],
      ['abc@def.com', 'comum'],
      ['abc+tag@def.com', 'com +tag'],
      ['abc@mailinator.com', 'descartável conhecido'],
      ['abc@10minutemail.com', 'descartável conhecido'],
      ['abc@gmail.com', 'gmail'],
      ['abc.def@gmail.com', 'gmail com ponto']
    ];
    for (const [email, descricao] of emails) {
      const { tag } = await tentar({ password: BOA, email });
      const veredito = tag === 'CRIOU' ? '>>> ACEITO (conta criada!)' : tag === EMAIL ? 'recusado' : tag;
      log(`   ${descricao.padEnd(24)} ${String(email || '(vazio)').padEnd(22)} ${veredito}`);
      if (tag === 'CRIOU') {
        log('   >>> parando: já sabemos o formato e não convém criar mais contas');
        break;
      }
    }

    // ------------------------------------------- 3. cadastro completo de fato
    if (CRIAR) {
      log('\n== 3. cadastro completo, com tudo válido');
      const usuario = nomeNovo();
      const senha = 'Abcdef1!';
      const email = `${usuario}@mailinator.com`;
      log(`   usuário=${usuario} senha=${senha} email=${email}`);

      pushes.length = 0;
      const r = await enviar('register', {
        username: usuario, password: senha, gender: 1,
        email, locale: 'pt_BR'
      }, 20000);
      log(`   resposta: ${r.caseName} ${JSON.stringify(r.value).slice(0, 500)}`);

      if (r.caseName === 'auth_ok') {
        // --------------------------- 4. a conta nasce com classe, ou sem?
        await new Promise(res => setTimeout(res, 3000));
        log('\n== 4. o que o servidor empurrou depois do register');
        for (const p of pushes) {
          log(`   ${p.caseName} ${JSON.stringify(p.value).slice(0, 300)}`);
        }
        const cena = pushes.find(p => p.caseName === 'scene_enter');
        log(cena
          ? '\n   >>> veio scene_enter: ver se o personagem já tem class_id acima'
          : '\n   >>> nenhum scene_enter: a conta espera ChooseClass');
      }
    } else {
      log('\n== 3. pulada. use --criar para criar uma conta de verdade.');
    }

  } catch (e) {
    log(`!! ${e.message}`);
  } finally {
    try { ws && ws.close(1000); } catch {}
    setTimeout(() => app.quit(), 500);
  }
});
