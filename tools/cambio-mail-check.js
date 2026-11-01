/**
 * @file cambio-mail-check.js
 * Prova o caminho **do launcher** de resgate de correio contra o servidor
 * real: `LevelingHeadlessClient.mailList()`, `correioDoCambio()` e
 * `mailClaim()`, exatamente como o botão "Resgatar correio" os chama.
 *
 *   npx electron tools/cambio-mail-check.js --conta 7
 *   npx electron tools/cambio-mail-check.js --conta 7 --claim
 *
 * Sem `--claim` só lista o que seria recolhido. Com `--claim`, recolhe.
 *
 * Ferramenta de investigação, não parte do launcher.
 */

'use strict';

const path = require('path');
const { app, safeStorage } = require('electron');

app.name = 'leveling-launcher';
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'leveling-launcher'));
} catch {}

const opts = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    opts[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
}

app.whenReady().then(async () => {
  const { LevelingCredentialStore } = require('../src/domain/leveling-credentials');
  const { LevelingHeadlessClient } = require('../src/domain/leveling-headless-service');
  const cambio = require('../src/domain/leveling-cambio');

  const numero = Number(opts.conta);
  if (!numero) throw new Error('uso: --conta 7 [--claim]');

  const store = new LevelingCredentialStore({ safeStorage });
  store.ensureCapacity(64);
  const acc = store.load().accounts[numero - 1];
  if (!acc || !acc.username) throw new Error(`conta ${numero} não configurada`);
  console.log(`== conta ${numero} (${acc.username})`);

  const client = new LevelingHeadlessClient(numero - 1, {
    username: acc.username,
    password: acc.password,
    proxy: acc.proxy || '',
    autoReconnect: false
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout ao conectar')), 30000);
    client.on('status', s => {
      if (s.status === 'connected') { clearTimeout(timer); resolve(); }
      if (s.status === 'error') { clearTimeout(timer); reject(new Error(s.error || 'erro')); }
    });
    client.connect();
  });
  await new Promise(r => setTimeout(r, 2500));
  console.log(`== conectado. ouro no saldo: ${client.state.gold}`);

  // Exatamente o que `cambioCorreio()` faz.
  const caixa = await client.mailList();
  console.log(`== mailList: ${caixa.entries.length} entradas, unclaimed=${caixa.unclaimed}, total=${caixa.total}`);
  for (const e of caixa.entries) {
    if (e.claimed) continue;
    console.log(`   NAO RESGATADA id=${e.id} kind=${e.kind} gold=${e.gold} dia=${e.diamonds} itens=${e.items} held=${e.heldUntil}`);
  }

  const ids = cambio.correioDoCambio(caixa.entries);
  console.log(`== correioDoCambio escolheu: ${ids.length ? ids.join(', ') : '(nada)'}`);

  if (ids.length && opts.claim) {
    const antes = client.state.gold;
    const r = await client.mailClaim(ids);
    await new Promise(x => setTimeout(x, 2000));
    console.log(`== mailClaim → ${JSON.stringify(r)}`);
    console.log(`== ouro ${antes} → ${client.state.gold}  (+${client.state.gold - antes})`);
  } else if (ids.length) {
    console.log('== (sem --claim: nada foi recolhido)');
  }

  client.disconnect();
  setTimeout(() => process.exit(0), 500);
}).catch(e => {
  console.error('ERRO:', e.message);
  setTimeout(() => process.exit(1), 300);
});
