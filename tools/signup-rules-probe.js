/**
 * @file signup-rules-probe.js
 * Descobre as regras exatas de username e senha do cadastro.
 *
 * A `signup-probe.js` já provou o que importava: `Register` NÃO exige
 * `captcha_token` — sem ele o servidor responde `account.password_weak`, e
 * não um erro de captcha. O cadastro headless é viável.
 *
 * Ficou um mistério: `ProbeSenha123` (13 chars, maiúscula, minúscula e
 * dígito) foi recusada como `password_weak`. Esta sonda varre o espaço de
 * senhas e de nomes um eixo por vez até a regra aparecer.
 *
 * Dois códigos de erro bastam para separar os eixos:
 *   `account.invalid_hunter_name` → o nome é inválido
 *   `account.password_weak`       → o nome passou, a senha é que não
 *
 * Ou seja: ao varrer nomes com uma senha propositalmente fraca, qualquer
 * resposta `password_weak` significa "este nome é aceito".
 *
 *   npx electron tools/signup-rules-probe.js
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

/** Nome que nunca colide, para a varredura de senha não bater em nome repetido. */
let contador = 0;
const nomeNovo = () => `pb${Date.now().toString(36)}${(contador++).toString(36)}`;

/** Senha que o servidor já recusou, para a varredura de nome isolar o eixo. */
const SENHA_FRACA = '1';

app.whenReady().then(async () => {
  const { getCodec } = require('../src/domain/leveling-codec');
  const codec = getCodec();

  let ws = null;
  let nextId = 1;
  const pending = new Map();

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
      if (!entry) return;
      pending.delete(pkt.requestId);
      entry({ caseName: pkt.caseName, value: pkt.value || {} });
    };
    // O servidor fecha a conexão do visitante depois de alguns registros
    // recusados. Reabrir é parte do protocolo da sonda, não um erro.
    ws.onclose = () => { ws = null; };
  }

  /** Tenta um registro e devolve só o código de erro, ou `auth_ok`. */
  async function tentar(username, password) {
    if (!ws) await abrir();
    const id = nextId++;
    const payload = codec.encode(id, 'register', {
      username, password, gender: 1, locale: 'pt_BR'
    });
    ws.send(payload);
    const r = await new Promise(resolve => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ caseName: 'TIMEOUT', value: {} }); }, 10000);
      pending.set(id, v => { clearTimeout(timer); resolve(v); });
    });
    if (r.caseName === 'auth_ok') return 'CRIOU';
    return (r.value && r.value.code) || r.caseName;
  }

  const NOME = 'account.invalid_hunter_name';
  const SENHA = 'account.password_weak';

  try {
    log('== A. comprimento do username (senha fraca de propósito)');
    log('   "password_weak" aqui significa: o NOME foi aceito\n');
    for (const n of [1, 2, 3, 4, 5, 6, 12, 16, 17, 18, 19, 20, 21, 24, 32]) {
      const r = await tentar('a'.repeat(n), SENHA_FRACA);
      const veredito = r === SENHA ? 'nome OK' : r === NOME ? 'nome RECUSADO' : r;
      log(`   ${String(n).padStart(2)} chars  ${veredito}`);
    }

    log('\n== B. que caracteres o username aceita');
    const amostras = [
      ['abcdef', 'só minúsculas'],
      ['ABCDEF', 'só maiúsculas'],
      ['Abc123', 'letras e dígitos'],
      ['123456', 'só dígitos'],
      ['abc_def', 'underscore'],
      ['abc-def', 'hífen'],
      ['abc.def', 'ponto'],
      ['abc def', 'espaço'],
      ['abcçef', 'cedilha'],
      ['abcdéf', 'acento'],
      ['abc!ef', 'exclamação'],
      ['_abcdef', 'underscore no início'],
      ['abcdef_', 'underscore no fim']
    ];
    for (const [nome, descricao] of amostras) {
      const r = await tentar(nome, SENHA_FRACA);
      const veredito = r === SENHA ? 'OK' : r === NOME ? 'RECUSADO' : r;
      log(`   ${descricao.padEnd(22)} ${String(nome).padEnd(10)} ${veredito}`);
    }

    log('\n== C. o que torna a senha forte (nome sempre válido e novo)');
    const senhas = [
      ['abcdefgh', 'minúsculas, 8'],
      ['abcdefghijkl', 'minúsculas, 12'],
      ['ABCDEFGH', 'maiúsculas, 8'],
      ['12345678', 'dígitos, 8'],
      ['Abcdefgh', 'maiúscula + minúscula, 8'],
      ['Abcdefg1', 'maiúscula + minúscula + dígito, 8'],
      ['abcdefg1', 'minúscula + dígito, 8'],
      ['Abcdef1!', 'as quatro classes, 8'],
      ['abcdefg!', 'minúscula + símbolo, 8'],
      ['Abcdefgh1!', 'as quatro classes, 10'],
      ['Abcdefghijk1!', 'as quatro classes, 13'],
      ['ProbeSenha123', 'a que falhou antes, 13'],
      ['ProbeSenha123!', 'a mesma, com símbolo'],
      ['aaaaaaaaaaaa', 'repetição, 12'],
      ['senha123456', 'palavra comum + dígitos']
    ];
    for (const [senha, descricao] of senhas) {
      const r = await tentar(nomeNovo(), senha);
      const veredito = r === SENHA ? 'FRACA' : r === 'CRIOU' ? '>>> ACEITA (conta criada)' : r;
      log(`   ${descricao.padEnd(36)} ${veredito}`);
      if (r === 'CRIOU') {
        log('   >>> para a varredura aqui: já sabemos o bastante e não convém criar mais contas');
        break;
      }
    }

  } catch (e) {
    log(`!! ${e.message}`);
  } finally {
    try { ws && ws.close(1000); } catch {}
    setTimeout(() => app.quit(), 500);
  }
});
