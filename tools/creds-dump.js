/**
 * @file creds-dump.js
 * Lê `leveling_creds.enc` pelo mesmo `safeStorage` que o launcher usa, para que
 * as sondas de protocolo possam entrar com as contas já configuradas sem o
 * usuário redigitar senha.
 *
 *   npx electron tools/creds-dump.js            (só usuário/proxy, sem segredo)
 *   npx electron tools/creds-dump.js --secrets  (inclui senha; imprime segredo)
 *
 * Ferramenta de investigação, não parte do launcher.
 */

'use strict';

const { app, safeStorage } = require('electron');
const path = require('path');

const comSegredo = process.argv.includes('--secrets');

app.name = 'leveling-launcher';
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'leveling-launcher'));
} catch {}

app.whenReady().then(() => {
  const { LevelingCredentialStore } = require('../src/domain/leveling-credentials');
  const store = new LevelingCredentialStore({ safeStorage });
  store.ensureCapacity(64);
  const { accounts } = store.load();

  const out = accounts
    .map((acc, i) => ({ i, ...acc }))
    .filter(acc => acc.username)
    .map(acc => comSegredo
      ? { i: acc.i, username: acc.username, password: acc.password, proxy: acc.proxy }
      : { i: acc.i, username: acc.username, hasPassword: !!acc.password, proxy: acc.proxy });

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  app.quit();
});
