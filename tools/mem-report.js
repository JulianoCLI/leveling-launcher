#!/usr/bin/env node
'use strict';

/**
 * Resumo das amostras gravadas com `--mem-probe` (userData/mem/*.jsonl).
 *
 *   node tools/mem-report.js                  todos os arquivos de %APPDATA%\leveling-launcher\mem
 *   node tools/mem-report.js a.jsonl b.jsonl  arquivos específicos
 *   node tools/mem-report.js --skip=120       ignora os primeiros 120 s de cada fase (aquecimento)
 *   node tools/mem-report.js --md             tabela markdown
 *
 * Métrica principal: soma de Private Bytes de todos os processos do app, em MB.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const asMarkdown = args.includes('--md');
const skipArg = args.find(a => a.startsWith('--skip='));
const skipSeconds = skipArg ? Number(skipArg.slice(7)) || 0 : 60;

let files = args.filter(a => !a.startsWith('--'));
if (!files.length) {
  const dir = path.join(
    process.env.APPDATA || path.join(os.homedir(), '.config'),
    'leveling-launcher',
    'mem'
  );
  try {
    files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .map(f => path.join(dir, f));
  } catch {
    console.error('Nenhum arquivo em ' + dir + '. Rode o app com --mem-probe.');
    process.exit(1);
  }
}

function stats(values) {
  if (!values.length) return { n: 0, avg: 0, p95: 0, max: 0, last: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const r = Math.round;
  return {
    n: values.length,
    avg: r(values.reduce((a, b) => a + b, 0) / values.length),
    p95: r(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]),
    max: r(sorted[sorted.length - 1]),
    last: r(values[values.length - 1])
  };
}

function analyze(file) {
  const lines = fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const meta = lines.find(l => l.meta) || {};
  const rows = lines.filter(l => !l.meta && !l.erro && Array.isArray(l.procs));
  const phases = {
    visivel: rows.filter(r => r.vis === 1),
    bandeja: rows.filter(r => r.vis === 0)
  };

  const out = { file: path.basename(file), tag: meta.tag || '-', phases: {} };

  for (const [name, phaseRows] of Object.entries(phases)) {
    if (!phaseRows.length) continue;
    const t0 = phaseRows[0].s;
    const warm = phaseRows.filter(r => r.s - t0 >= skipSeconds);
    const base = warm.length ? warm : phaseRows;

    const byLabel = {};
    for (const row of base) {
      const agg = {};
      for (const proc of row.procs) {
        const key = proc.label.startsWith('conta') ? 'contas(soma)' : proc.label;
        agg[key] = (agg[key] || 0) + proc.priv;
        if (proc.label.startsWith('conta')) agg[proc.label] = (agg[proc.label] || 0) + proc.priv;
      }
      for (const [key, value] of Object.entries(agg)) (byLabel[key] = byLabel[key] || []).push(value);
    }

    const lastPages = [...base].reverse().find(r => r.pages && Object.keys(r.pages).length);
    out.phases[name] = {
      pages: lastPages ? lastPages.pages : null,
      total: stats(base.map(r => r.totalPriv)),
      ws: stats(base.map(r => r.totalWs)),
      cpu: stats(base.map(r => r.cpu || 0)),
      monitors: stats(base.map(r => r.mon || 0)),
      procs: stats(base.map(r => r.n)),
      labels: Object.fromEntries(
        Object.entries(byLabel)
          .map(([k, v]) => [k, stats(v)])
          .sort((a, b) => b[1].avg - a[1].avg)
      )
    };
  }

  return out;
}

const results = files.map(analyze);

if (asMarkdown) {
  console.log('| arquivo | tag | fase | total avg | p95 | max | CPU% | procs | monitores | contas(soma) | host | GPU | Browser |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    for (const [phase, d] of Object.entries(r.phases)) {
      const get = key => (d.labels[key] || {}).avg || 0;
      console.log(`| ${r.file} | ${r.tag} | ${phase} | ${d.total.avg} | ${d.total.p95} | ${d.total.max} | ${d.cpu.avg} | ${d.procs.max} | ${d.monitors.max} | ${get('contas(soma)')} | ${get('host')} | ${get('GPU')} | ${get('Browser')} |`);
    }
  }
} else {
  for (const r of results) {
    console.log(`\n== ${r.file}  [tag=${r.tag}]`);
    for (const [phase, d] of Object.entries(r.phases)) {
      console.log(`  ${phase}: privado avg=${d.total.avg} MB p95=${d.total.p95} max=${d.total.max}` +
        ` (working set avg=${d.ws.avg}) · CPU avg=${d.cpu.avg}%` +
        ` · ${d.total.n} amostras · até ${d.procs.max} processos · ${d.monitors.max} monitores`);
      for (const [key, s] of Object.entries(d.labels)) {
        console.log(`    ${key.padEnd(16)} avg=${String(s.avg).padStart(5)}  p95=${String(s.p95).padStart(5)}  max=${String(s.max).padStart(5)}`);
      }
      if (d.pages) {
        for (const [key, page] of Object.entries(d.pages)) {
          console.log(`    [pagina ${key}] ${JSON.stringify(page)}`);
        }
      }
    }
  }
}
