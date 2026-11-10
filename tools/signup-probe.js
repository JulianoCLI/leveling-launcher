/**
 * @file signup-probe.js
 * Descobre, contra o servidor de verdade, como o cadastro realmente funciona.
 *
 * O cadastro assistido foi escrito supondo o formato de `Register`. Esta sonda
 * troca a suposição por evidência. Ela responde, nesta ordem:
 *
 *   1. `Register` exige `captcha_token`? (manda sem e lê o erro)
 *   2. quais são os `class_id` reais? (lê o `content_catalog`, não uma lista inventada)
 *   3. `Register` já devolve `AuthOk`, ou precisa de `Login` depois?
 *   4. a conta nova nasce sem classe? `ChooseClass` aceita na hora?
 *   5. que erro o servidor dá para username repetido, curto, com símbolos?
 *
 * ATENÇÃO: se o servidor não exigir captcha, a etapa 3 cria contas de verdade.
 * Os nomes gerados começam com `probe` e carregam um timestamp, para dar para
 * reconhecer e apagar depois.
 *
 * O catálogo de classes é push, não request: só chega depois de autenticar.
 * Por isso a etapa 2 precisa de uma conta que já existe.
 *
 *   npx electron tools/signup-probe.js
 *   npx electron tools/signup-probe.js --login SuaConta --pass Senha
 *   npx electron tools/signup-probe.js --account 0        (rota de proxy da conta 0)
 *
 * Ferramenta de investigação, não parte do launcher.
 */

'use strict';

const path = require('path');
const { app, safeStorage } = require('electron');

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].replace(/^--/, '');
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

const opts = args();
const WS_URL = 'wss://game.levelingidle2d.com.br:8443/ws';
const ORIGIN = 'https://levelingidle2d.com.br';

app.name = 'leveling-launcher';
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'leveling-launcher'));
} catch {}

const log = (...a) => console.log(...a);
const full = v => JSON.stringify(v, null, 2);
const T0 = Date.now();
const ms = () => String(Date.now() - T0).padStart(6) + 'ms';

/**
 * Conexão crua. Diferente das outras sondas, esta não autentica de saída:
 * o ponto é justamente ver o que acontece antes de ter conta.
 */
class Probe {
  constructor(codec, dispatcher) {
    this.codec = codec;
    this.dispatcher = dispatcher;
    this.nextId = 1;
    this.pending = new Map();
    this.pushes = [];
    this.pushWaiters = new Map();
    this.catalog = null;
    this.ws = null;
  }

  async open() {
    const init = { headers: { Origin: ORIGIN } };
    if (this.dispatcher) init.dispatcher = this.dispatcher;
    const ws = new WebSocket(WS_URL, init);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('conexão falhou'));
      setTimeout(() => reject(new Error('timeout ao conectar')), 20000);
    });
    ws.onmessage = e => this.onPacket(e.data);
    ws.onclose = e => log(`${ms()} == socket fechado code=${e && e.code}`);
  }

  /** Espera um push que não responde a nenhum request, como `content_catalog`. */
  waitPush(caseName, timeoutMs = 20000) {
    const achado = this.pushes.find(x => x.caseName === caseName);
    if (achado) return Promise.resolve(achado.value);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pushWaiters.delete(caseName);
        resolve(null);
      }, timeoutMs);
      this.pushWaiters.set(caseName, v => { clearTimeout(timer); resolve(v); });
    });
  }

  send(caseName, value, timeoutMs = 15000) {
    const id = this.nextId++;
    let payload;
    try {
      payload = this.codec.encode(id, caseName, value);
    } catch (e) {
      return Promise.resolve({ caseName: 'ENCODE_FAIL', value: { message: e.message } });
    }
    this.ws.send(payload);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ caseName: 'TIMEOUT', value: {} });
      }, timeoutMs);
      this.pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); } });
    });
  }

  onPacket(data) {
    const buf = Buffer.from(data);
    let packet;
    try { packet = this.codec.decode(buf); } catch { return; }
    const value = packet.value || {};

    if (packet.caseName === 'content_catalog') this.catalog = value;

    if (packet.requestId && this.pending.has(packet.requestId)) {
      const entry = this.pending.get(packet.requestId);
      this.pending.delete(packet.requestId);
      entry.resolve({ caseName: packet.caseName, value });
      return;
    }

    // Push sem requestId: guarda para o relatório. `scene_enter` diz se a
    // conta nova já entrou no mundo ou ficou parada esperando a classe.
    this.pushes.push({ at: ms(), caseName: packet.caseName, value });
    const esperando = this.pushWaiters.get(packet.caseName);
    if (esperando) {
      this.pushWaiters.delete(packet.caseName);
      esperando(value);
    }
    if (packet.caseName !== 'content_catalog') {
      log(`${ms()} PUSH ${packet.caseName} ${full(value).slice(0, 400)}`);
    } else {
      log(`${ms()} PUSH content_catalog (${(value.classes || []).length} classes)`);
    }
  }

  close() {
    try { this.ws && this.ws.close(1000); } catch {}
  }
}

/** Mostra o que o servidor respondeu, inteiro, sem resumir. */
function relatar(titulo, r) {
  log(`\n-- ${titulo}`);
  log(`   caso: ${r.caseName}`);
  log(`   valor: ${full(r.value)}`);
}

app.whenReady().then(async () => {
  const { getCodec } = require('../src/domain/leveling-codec');
  const { proxyDispatcher } = require('../src/domain/leveling-headless-service');
  const { LevelingCredentialStore } = require('../src/domain/leveling-credentials');

  const codec = getCodec();

  // Rota de saída. Cadastrar várias contas pelo mesmo IP é justamente o que o
  // servidor recusa, então a sonda sai pela rota de uma conta já configurada
  // quando `--account N` é passado.
  let dispatcher = null;
  if (opts.account !== undefined) {
    const store = new LevelingCredentialStore({ safeStorage });
    store.ensureCapacity(64);
    const { accounts } = store.load();
    const acc = accounts[Number(opts.account) || 0];
    const proxy = acc && acc.proxy;
    if (proxy) {
      dispatcher = proxyDispatcher(proxy);
      log(`== saindo pelo proxy da conta ${opts.account}`);
    } else {
      log(`!! conta ${opts.account} não tem proxy; saindo pelo IP local`);
    }
  }

  const p = new Probe(codec, dispatcher);

  try {
    // --------------------------------------------------------- 1. o catálogo
    // As classes vêm do servidor. Qualquer lista escrita à mão no launcher é
    // chute; aqui sai a verdade.
    //
    // Não existe request de catálogo: `content_catalog` é push e só chega
    // depois de autenticar. Por isso esta etapa precisa de uma conta já
    // existente, e num socket separado: o resto da sonda tem de falar com o
    // servidor sem estar autenticado, como um visitante faria.
    log('== 1. classes reais do servidor');
    let classes = [];
    if (opts.login && opts.pass) {
      const leitor = new Probe(codec, dispatcher);
      try {
        await leitor.open();
        const auth = await leitor.send('login', { username: opts.login, password: opts.pass });
        log(`   login de ${opts.login}: ${auth.caseName}`);
        if (auth.caseName === 'auth_ok') {
          const cat = await leitor.waitPush('content_catalog');
          classes = (cat && cat.classes) || [];
        } else {
          log(`   ${full(auth.value).slice(0, 300)}`);
        }
      } finally {
        leitor.close();
      }
    } else {
      log('   (pulada: passe --login U --pass P de uma conta existente)');
    }
    if (!classes.length) {
      log('   !! sem catálogo: os class_id continuam desconhecidos');
    } else {
      for (const c of classes) {
        log(`   ${String(c.id).padEnd(16)} ${String(c.name).padEnd(20)} alcance=${c.range} magia=${!!c.uses_magic}`);
      }
      log(`\n   >>> class_id válidos: ${classes.map(c => c.id).join(', ')}`);
    }

    // ------------------------------------------------- 2. Register sem captcha
    // Pergunta central. Se o servidor responder erro de captcha, o cadastro
    // headless não funciona e o caminho tem de ser híbrido (WebView).
    log('\n== 2. conectar como visitante, sem autenticar');
    await p.open();
    log(`${ms()} conectado`);

    log('\n== 3. Register sem captcha_token');
    const nomeFalso = `probe${Date.now().toString(36)}`;
    const semCaptcha = await p.send('register', {
      username: nomeFalso,
      password: 'ProbeSenha123',
      gender: 1,
      referral_code: '',
      email: '',
      captcha_token: '',
      locale: 'pt_BR'
    });
    relatar('resposta ao register sem captcha', semCaptcha);

    if (semCaptcha.caseName === 'auth_ok') {
      log('   >>> CAPTCHA NÃO É EXIGIDO. Cadastro headless funciona.');
      log(`   >>> conta criada de verdade: ${nomeFalso}`);

      // ------------------------------------------- 4. a conta nasce sem classe?
      log('\n== 4. estado da conta nova');
      const cena = p.pushes.filter(x => x.caseName === 'scene_enter');
      if (cena.length) {
        log(`   scene_enter: ${full(cena[0].value).slice(0, 600)}`);
      } else {
        log('   nenhum scene_enter: a conta provavelmente espera ChooseClass');
      }

      // ------------------------------------------------- 5. ChooseClass
      const alvo = (classes[0] && classes[0].id) || '';
      if (alvo) {
        log(`\n== 5. ChooseClass com class_id=${alvo}`);
        const escolha = await p.send('choose_class', { class_id: alvo });
        relatar('resposta ao choose_class', escolha);
      } else {
        log('\n== 5. sem class_id conhecido, pulando ChooseClass');
      }
    } else {
      log('   >>> Register FALHOU sem captcha. Veja o erro acima.');
      log('   >>> Se for erro de captcha, o cadastro headless é impossível');
      log('   >>> e a implementação precisa preencher o formulário na WebView.');
    }

    // --------------------------------------------- 6. erros de validação
    // Confirma as regras reais de username, em vez das que o launcher supõe
    // (3-20 alfanuméricos foi chute).
    log('\n== 6. regras reais de username');
    const casos = [
      { nome: 'ab', porque: 'curto demais?' },
      { nome: 'a'.repeat(32), porque: 'longo demais?' },
      { nome: 'com espaço', porque: 'espaço é aceito?' },
      { nome: 'com-hifen', porque: 'hífen é aceito?' },
      { nome: 'com_under', porque: 'underscore é aceito?' },
      { nome: 'acentuação', porque: 'acento é aceito?' }
    ];
    for (const c of casos) {
      const r = await p.send('register', {
        username: c.nome,
        password: 'ProbeSenha123',
        gender: 1,
        locale: 'pt_BR'
      }, 8000);
      log(`   ${String(c.nome).slice(0, 20).padEnd(22)} ${c.porque.padEnd(24)} -> ${r.caseName} ${full(r.value).slice(0, 200)}`);
    }

    // ----------------------------------------- 7. senha: qual é o mínimo real
    log('\n== 7. regras reais de senha');
    for (const senha of ['1', '12345', '123456', 'abcdefgh']) {
      const r = await p.send('register', {
        username: `probe${Date.now().toString(36)}${Math.floor(Math.random() * 999)}`,
        password: senha,
        gender: 1,
        locale: 'pt_BR'
      }, 8000);
      log(`   senha ${String(senha.length).padStart(2)} chars -> ${r.caseName} ${full(r.value).slice(0, 200)}`);
    }

  } catch (e) {
    log(`!! ${e.message}`);
  } finally {
    p.close();
    setTimeout(() => app.quit(), 500);
  }
});
