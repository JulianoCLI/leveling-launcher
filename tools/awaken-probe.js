/**
 * @file awaken-probe.js
 * Mede em que nível o jogo libera a escolha de classe.
 *
 * Existe por causa de uma pergunta do assistente de cadastro: dá para escolher
 * a classe logo depois de criar a conta? O bundle esconde a resposta numa regra
 * do servidor — o modal de escolha só aparece quando
 *
 *     !identity.classId && level >= catalog.raw.rules.awakenLevel
 *
 * Se `awakenLevel` for maior que 1, uma conta recém-criada **não** pode escolher
 * classe, e automatizar esse passo no cadastro é impossível, não difícil.
 *
 * Entra com uma credencial já guardada no launcher (a conta 1 por padrão) e
 * imprime a regra que veio no catálogo, mais o nível e a classe da conta.
 *
 *   npx electron tools/awaken-probe.js
 *   npx electron tools/awaken-probe.js --conta 3
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
const args = process.argv.slice(2);
const idx = args.indexOf('--conta');
const CONTA = idx >= 0 ? Math.max(1, +args[idx + 1] || 1) : 1;

app.whenReady().then(async () => {
  const { getCodec } = require('../src/domain/leveling-codec');
  const { levelingCredentials } = require('../src/domain/leveling-credentials');
  const codec = getCodec();

  const cred = levelingCredentials.get(CONTA - 1);
  if (!cred || !cred.username || !cred.password) {
    log(`!! conta ${CONTA} não tem credencial guardada. Use --conta N de uma que tenha.`);
    setTimeout(() => app.quit(), 200);
    return;
  }
  log(`== entrando como ${cred.username} (conta ${CONTA})`);

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
  }

  async function enviar(caseName, value, timeoutMs = 15000) {
    if (!ws) await abrir();
    const id = nextId++;
    ws.send(codec.encode(id, caseName, value));
    return new Promise(resolve => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ caseName: 'TIMEOUT', value: {} }); }, timeoutMs);
      pending.set(id, v => { clearTimeout(timer); resolve(v); });
    });
  }

  /** Procura a chave em qualquer profundidade: o catálogo muda de forma. */
  function procurar(obj, chave, profundidade = 0) {
    if (!obj || typeof obj !== 'object' || profundidade > 6) return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, chave)) return obj[chave];
    for (const v of Object.values(obj)) {
      const achado = procurar(v, chave, profundidade + 1);
      if (achado !== undefined) return achado;
    }
    return undefined;
  }

  try {
    const r = await enviar('login', {
      username: cred.username, password: cred.password, locale: 'pt_BR'
    }, 25000);
    log(`   login: ${r.caseName} ${r.caseName !== 'auth_ok' ? JSON.stringify(r.value).slice(0, 300) : ''}`);
    if (r.caseName !== 'auth_ok') throw new Error('login recusado');

    log('   esperando os pushes do catálogo…');
    await new Promise(res => setTimeout(res, 6000));

    log(`\n== ${pushes.length} pushes: ${[...new Set(pushes.map(p => p.caseName))].join(', ')}`);

    let awaken;
    let regras;
    for (const p of pushes) {
      const achado = procurar(p.value, 'awakenLevel');
      if (achado !== undefined) { awaken = achado; break; }
    }
    for (const p of pushes) {
      const achado = procurar(p.value, 'rules');
      if (achado !== undefined) { regras = achado; break; }
    }

    log(`\n>>> awakenLevel = ${awaken === undefined ? '(não veio)' : awaken}`);
    if (regras !== undefined) log(`    rules = ${JSON.stringify(regras).slice(0, 600)}`);

    const ident = pushes.map(p => procurar(p.value, 'identity')).find(v => v);
    const prog = pushes.map(p => procurar(p.value, 'progress')).find(v => v);
    log(`    identity = ${JSON.stringify(ident || null).slice(0, 300)}`);
    log(`    progress = ${JSON.stringify(prog || null).slice(0, 300)}`);

    const classes = pushes.map(p => procurar(p.value, 'classes')).find(v => v);
    if (classes) {
      const lista = Array.isArray(classes) ? classes : Object.values(classes);
      log(`    classes = ${lista.map(c => (c && (c.id || c.classId)) || c).join(', ')}`);
    }

    log('\n>>> conclusão:');
    if (awaken === undefined) {
      log('    `awakenLevel` não apareceu no catálogo: o padrão do bundle é 0,');
      log('    e com 0 uma conta nível 1 JÁ pode escolher classe.');
    } else if (+awaken <= 1) {
      log(`    awakenLevel=${awaken}: conta nova JÁ pode escolher classe no cadastro.`);
    } else {
      log(`    awakenLevel=${awaken}: conta nova NÃO pode escolher classe.`);
      log(`    O modal só aparece ao chegar no nível ${awaken}.`);
    }
  } catch (e) {
    log(`!! ${e.message}`);
  } finally {
    try { ws && ws.close(1000); } catch {}
    setTimeout(() => app.quit(), 500);
  }
});
