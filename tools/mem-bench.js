#!/usr/bin/env node
'use strict';

/**
 * Roda o cenário de medição de RAM uma vez por execução nomeada.
 *
 * Cenário: `--visible` s com a janela na tela, depois bandeja até `--show` s,
 * restaura e fecha em `--duration` s. Isso separa as duas fases que o
 * `mem-report.js` compara (`vis=1` e `vis=0`), que é onde aparece o ganho de
 * não deixar os painéis desenhando para ninguém.
 *
 *   node tools/mem-bench.js --runs=antes,depois --visible=300 --show=660 --duration=720
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const runs = arg('runs', 'base').split(',').filter(Boolean);
const visible = +arg('visible', 300);
const show = +arg('show', 660);
const duration = +arg('duration', 720);

const root = path.join(__dirname, '..');
const electron = path.join(
  root, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
);

const logFile = path.join(root, 'scratch', 'mem-bench.log');
fs.mkdirSync(path.dirname(logFile), { recursive: true });

const say = message => {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + '\n');
  } catch {}
};

function run(name) {
  return new Promise(resolve => {
    const args = [
      '.', '--mem-probe', '--mem-interval=10',
      `--mem-tray-after=${visible}`,
      `--mem-show-after=${show}`,
      `--mem-duration=${duration}`,
      `--mem-tag=${name}`
    ];
    say('inicio ' + name + ' :: ' + args.join(' '));

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;

    const child = spawn(electron, args, { cwd: root, env, stdio: 'ignore' });
    // Rede de segurança: se o app não se fechar sozinho, o bench não trava.
    const hard = setTimeout(() => {
      say('timeout duro em ' + name + ', encerrando');
      try { child.kill(); } catch {}
    }, (duration + 120) * 1000);

    child.on('exit', code => {
      clearTimeout(hard);
      say(`fim ${name} (exit ${code})`);
      setTimeout(resolve, 15000); // deixa o SO liberar os processos antes da próxima
    });
    child.on('error', err => {
      clearTimeout(hard);
      say(`erro ${name}: ${err.message}`);
      resolve();
    });
  });
}

(async () => {
  say(`bench: ${runs.join(', ')} · visivel ${visible}s · bandeja ate ${show}s · fim ${duration}s`);
  for (const name of runs) await run(name);
  say('bench concluido · resuma com: node tools/mem-report.js');
})();
