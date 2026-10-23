/**
 * @file memory-probe.js
 * Telemetria de memória do launcher. Desligada por padrão: só liga com
 * `--mem-probe` ou `LV_MEM_PROBE=1`.
 *
 * Grava uma linha JSON por amostra em `userData/mem/mem-*.jsonl`, que
 * `tools/mem-report.js` resume. Existe para que "consumo baixíssimo" seja um
 * número verificável antes e depois de cada mudança, e não uma impressão.
 *
 * `app.getAppMetrics()` devolve KB; aqui tudo vira MB com uma casa.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const mb = kb => Math.round((Number(kb) || 0) / 102.4) / 10;

function parseArgs(argv, env) {
  const get = name => {
    const hit = argv.find(a => a.startsWith('--' + name + '='));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    enabled: argv.includes('--mem-probe') || env.LV_MEM_PROBE === '1',
    intervalMs: num(get('mem-interval') || env.LV_MEM_INTERVAL, 10) * 1000,
    trayAfterMs: num(get('mem-tray-after') || env.LV_MEM_TRAY_AFTER, 0) * 1000,
    showAfterMs: num(get('mem-show-after') || env.LV_MEM_SHOW_AFTER, 0) * 1000,
    durationMs: num(get('mem-duration') || env.LV_MEM_DURATION, 0) * 1000,
    tag: String(get('mem-tag') || env.LV_MEM_TAG || '').replace(/[^\w.-]/g, '').slice(0, 40)
  };
}

/**
 * Rotula cada PID: `browser`/`GPU`/`Utility` pelo tipo do processo; renderers
 * pelo webContents dono — a janela do launcher é `host` e cada WebView é
 * `contaN`, deduzida da pasta da partição `persist:contaN`. Sem isso o relatório
 * mostra só uma soma e não dá para separar o custo do jogo do custo do monitor.
 */
function labelProcesses(webContentsList) {
  const byPid = new Map();
  for (const wc of webContentsList) {
    try {
      if (wc.isDestroyed()) continue;
      const pid = wc.getOSProcessId();
      if (!pid) continue;
      let label;
      if (wc.getType() === 'webview') {
        const storage = (wc.session && wc.session.storagePath) || '';
        const match = /conta(\d+)/i.exec(path.basename(storage));
        label = match ? 'conta' + match[1] : 'webview';
      } else if (wc.getType() === 'window') {
        label = 'host';
      } else {
        label = wc.getType();
      }
      const previous = byPid.get(pid);
      byPid.set(pid, previous && previous !== label ? previous + '+' + label : label);
    } catch {}
  }
  return byPid;
}

function sample(metrics, labels, extra) {
  const procs = metrics.map(m => {
    const memory = m.memory || {};
    return {
      pid: m.pid,
      type: m.type,
      label: labels.get(m.pid) || (m.type === 'Tab' ? 'renderer-orfao' : m.type),
      priv: mb(memory.privateBytes != null ? memory.privateBytes : memory.workingSetSize),
      ws: mb(memory.workingSetSize),
      cpu: Math.round(((m.cpu && m.cpu.percentCPUUsage) || 0) * 10) / 10
    };
  });
  const round = n => Math.round(n * 10) / 10;
  return {
    t: Date.now(),
    ...extra,
    totalPriv: round(procs.reduce((sum, p) => sum + p.priv, 0)),
    totalWs: round(procs.reduce((sum, p) => sum + p.ws, 0)),
    cpu: round(procs.reduce((sum, p) => sum + p.cpu, 0)),
    n: procs.length,
    procs
  };
}

/**
 * Leitura de dentro de cada página: heap JS (preciso só com
 * `--enable-precise-memory-info`), tamanho do DOM e contagem de canvas/imagens.
 * Somente leitura, e no máximo uma vez por minuto por painel.
 */
const INNER_JS = `(()=>{const m=performance.memory||{};return{
heap:Math.round((m.usedJSHeapSize||0)/1048576),
heapTot:Math.round((m.totalJSHeapSize||0)/1048576),
dom:document.getElementsByTagName('*').length,
cv:document.getElementsByTagName('canvas').length,
img:document.images.length,
ifr:document.getElementsByTagName('iframe').length,
url:location.pathname}})()`;

function createMemoryProbe({ app, webContents, opts, getState, onTrayAfter, onShowAfter, onDuration }) {
  let timer = null;
  let file = null;
  let startedAt = 0;
  let nTick = 0;
  const timers = [];

  async function readPages(list) {
    const out = {};
    await Promise.all(list.map(async wc => {
      try {
        if (wc.isDestroyed()) return;
        const type = wc.getType();
        if (type !== 'webview' && type !== 'window') return;
        const url = wc.getURL() || '';
        if (!url || url === 'about:blank') return;

        let key = 'host';
        if (type === 'webview') {
          const match = /conta(\d+)/i.exec(path.basename((wc.session && wc.session.storagePath) || ''));
          key = match ? 'conta' + match[1] : 'webview' + wc.id;
        }
        out[key] = await Promise.race([
          wc.executeJavaScript(INNER_JS),
          new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 5000))
        ]);
      } catch {
        // painel recarregando: a amostra seguinte pega
      }
    }));
    return out;
  }

  function append(row) {
    try {
      fs.appendFileSync(file, JSON.stringify(row) + '\n');
    } catch {}
  }

  function tick() {
    // A leitura de dentro das páginas é a parte cara: só uma vez por minuto.
    const deep = nTick++ % Math.max(1, Math.round(60000 / opts.intervalMs)) === 0;
    try {
      const all = webContents.getAllWebContents();
      const row = sample(app.getAppMetrics(), labelProcesses(all), {
        s: Math.round((Date.now() - startedAt) / 1000),
        ...((getState && getState()) || {})
      });
      if (!deep) {
        append(row);
        return;
      }
      readPages(all)
        .then(pages => { row.pages = pages; })
        .catch(() => {})
        .finally(() => append(row));
    } catch (err) {
      append({ t: Date.now(), erro: String(err && err.message) });
    }
  }

  return {
    start() {
      if (!opts.enabled || timer) return null;
      startedAt = Date.now();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dir = path.join(app.getPath('userData'), 'mem');
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        return null;
      }
      file = path.join(dir, `mem-${stamp}-${opts.tag || 'base'}.jsonl`);
      fs.writeFileSync(file, JSON.stringify({
        meta: true,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        tag: opts.tag,
        intervalMs: opts.intervalMs
      }) + '\n');

      timer = setInterval(tick, opts.intervalMs);
      setTimeout(tick, 2000);
      if (opts.trayAfterMs && onTrayAfter) timers.push(setTimeout(onTrayAfter, opts.trayAfterMs));
      if (opts.showAfterMs && onShowAfter) timers.push(setTimeout(onShowAfter, opts.showAfterMs));
      if (opts.durationMs && onDuration) {
        timers.push(setTimeout(() => { tick(); onDuration(); }, opts.durationMs));
      }
      return file;
    },

    stop() {
      clearInterval(timer);
      timer = null;
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    },

    tick,

    get file() {
      return file;
    }
  };
}

module.exports = { createMemoryProbe, parseArgs, labelProcesses, sample, mb, INNER_JS };
