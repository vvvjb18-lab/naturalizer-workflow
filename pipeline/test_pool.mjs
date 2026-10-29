#!/usr/bin/env node
// test_pool.mjs — smoke test for the 10.0 parallel pool.
// Runs two paragraphs of highAI-0983 through preset beta (3× routeb, 1× routea)
// and prints per-candidate coverage plus basic structural stats.
import fs from 'node:fs';
import { generatePool, POOL_PRESETS, ENGINES, unloadEngine } from './candidates.mjs';

const SRC = 'F:/Humanizer/pipeline/canary/highAI-0983.txt';
const raw = fs.readFileSync(SRC, 'utf8');
const paras = raw.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const body = paras.slice(1, 3);       // two body paragraphs

const plan = {
  targets: Object.fromEntries(body.map((text, i) => [String(i), {
    units: [{ id: `p${i}u0`, text }],
    joiner: ' ',
  }])),
};

const preset = process.argv[2] || 'beta';
console.log(`preset=${preset} paragraphs=${body.length} engines=${JSON.stringify(ENGINES[preset] ? Object.keys(POOL_PRESETS[preset]) : [])}`);

const log = (m) => console.log(m);
const t0 = Date.now();
const cands = await generatePool({ plan, preset, retries: 1, lang: 'en', log });

console.log(`\n=== ${cands.length} candidates in ${((Date.now() - t0) / 1000).toFixed(0)}s ===`);
const WORD = /[A-Za-z']+/g;
const SENT = /(?<=[.!?])\s+/;
function cv(t) {
  const lens = t.split(SENT).map((s) => (s.match(WORD) || []).length).filter((x) => x > 0);
  if (lens.length < 2) return 0;
  const m = lens.reduce((a, b) => a + b, 0) / lens.length;
  return Math.sqrt(lens.reduce((a, b) => a + (b - m) ** 2, 0) / lens.length) / m;
}
const AI = ['furthermore', 'moreover', 'in conclusion', 'additionally', 'consequently', 'delve', 'crucial', 'comprehensive'];
for (const c of cands) {
  const text = Object.values(c.paras).join(' ');
  const words = text.split(/\s+/).length;
  const ai = AI.reduce((s, k) => s + (text.toLowerCase().split(k).length - 1), 0) * 100 / Math.max(1, words);
  console.log(`${c.id} ${c.engine.padEnd(7)} t=${c.sampling.temperature} `
    + `cov=${(c.coverage * 100).toFixed(0)}% fail=${c.failures.length} `
    + `words=${words} CV=${cv(text).toFixed(3)} ai_mk=${ai.toFixed(2)}`);
}

const outFile = 'E:/download/naturalizer-workflow/finetune/pool_test_output.json';
fs.writeFileSync(outFile, JSON.stringify(cands.map((c) => ({
  id: c.id, engine: c.engine, sampling: c.sampling, coverage: c.coverage,
  failures: c.failures, paras: c.paras,
})), null, 1), 'utf8');
console.log(`\nwritten ${outFile}`);
await unloadEngine('routea');
await unloadEngine('routeb');
