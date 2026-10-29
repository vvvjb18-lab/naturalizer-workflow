#!/usr/bin/env node
// integrate10.mjs — offline integration test for the 10.0 core loop.
//
// Runs the exact sequence 10.0 uses, without hz-app or the scoring daemon:
//   1. parallel pool generation (routeb / routea)
//   2. per-paragraph assembly with the new-engine CV floor
//   3. deterministic L2 repair (l2_fix.py)
//   4. dual-axis acceptance
//
// Usage: node integrate10.mjs [preset] [nParas]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generatePool, assembleCrossover, qualityAxis, qualityVerdict,
         docCv, unloadEngine } from './candidates.mjs';

const SRC = 'F:/Humanizer/pipeline/canary/highAI-0983.txt';
const preset = process.argv[2] || 'beta';
const nParas = Number(process.argv[3] || 3);
const OUTDIR = 'E:/download/naturalizer-workflow/finetune';

const raw = fs.readFileSync(SRC, 'utf8');
const all = raw.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const body = all.slice(1, 1 + nParas);
const original = body.join('\n\n');

const plan = {
  targets: Object.fromEntries(body.map((text, i) => [String(i), {
    units: [{ id: `p${i}u0`, text }], joiner: ' ',
  }])),
};

console.log(`=== 10.0 integration: preset=${preset} paras=${body.length} ===`);
console.log(`original: ${original.split(/\s+/).length} words, CV ${docCv(original).toFixed(3)}\n`);

// 1 ── pool
const t0 = Date.now();
const cands = await generatePool({
  plan, preset, retries: 1, lang: 'en',
  log: (m) => console.log(m),
});
console.log(`\npool done: ${cands.length} candidates in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// 2 ── per-paragraph stats + assembly
const paraStats = {};
for (const paraIdx of Object.keys(plan.targets)) {
  paraStats[paraIdx] = cands.map((c) => {
    const text = c.paras?.[paraIdx];
    if (!text) return null;
    return { candId: c.id, cv: docCv(text), damage: 0 };
  }).filter(Boolean);
}
const xo = assembleCrossover({
  cands, paraStats, cvBand: [0.42, 0.65],
  targetCv: 0.42, lengthPenalty: 1.5,
  docWords: original.split(/\s+/).length,
  engineBias: { routea: 0.05 },
  lengthConverge: { maxWords: Math.round(original.split(/\s+/).length * 1.12), minCv: 0.42 },
  log: (m) => console.log(m),
});
const assembled = Object.keys(plan.targets).map((k) => xo.paras[k]).filter(Boolean).join('\n\n');
console.log(`\nassembled from: ${JSON.stringify(xo.provenance)}`);
console.log(`assembled CV ${docCv(assembled).toFixed(3)}, ${assembled.split(/\s+/).length} words`);

// 3 ── deterministic repair
const inPath = path.join(OUTDIR, '_integ10_in.txt');
const outPath = path.join(OUTDIR, '_integ10_out.txt');
fs.writeFileSync(inPath, assembled, 'utf8');
const fix = spawnSync('python', [
  'E:/download/naturalizer-workflow/pipeline/l2_fix.py', 'fix', inPath, outPath, 'en-GB',
], { encoding: 'utf8', timeout: 120000 });
if (fix.status !== 0) {
  console.error('l2_fix failed:', fix.stderr?.slice(0, 300));
} else {
  try {
    const j = JSON.parse(fix.stdout);
    console.log(`\nrepair: ${j.rules_applied.length} rules, `
      + `hard errors ${j.before.hard_errors} -> ${j.after.hard_errors}`);
    for (const r of j.rules_applied) console.log(`  ${r.rule} x${r.count}`);
  } catch { console.log('\nrepair output:', fix.stdout.slice(0, 200)); }
}
const repaired = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : assembled;

// 4 ── dual-axis acceptance
const qBefore = qualityAxis(assembled, original, { lang: 'en' });
const qAfter = qualityAxis(repaired, original, { lang: 'en' });
const vAfter = qualityVerdict(qAfter, { maxLengthRatio: 1.12, allowContractions: false });
const origCv = docCv(original);
const finalCv = docCv(repaired);

console.log('\n=== dual-axis ===');
console.log(`score axis : CV ${origCv.toFixed(3)} -> ${finalCv.toFixed(3)} `
  + `(${finalCv >= 0.42 ? 'pass' : 'below 0.42 floor'})`);
console.log(`quality    : hard errors ${qBefore.hardErrors} -> ${qAfter.hardErrors}, `
  + `length ratio ${qAfter.lengthRatio}, contractions ${qAfter.contractionRate}`);
console.log(`verdict    : ${vAfter.pass ? 'PASS' : 'FAIL ' + vAfter.fails.join(', ')}`);

fs.writeFileSync(path.join(OUTDIR, '_integ10_final.txt'), repaired, 'utf8');
console.log(`\nwrote ${path.join(OUTDIR, '_integ10_final.txt')}`);
await unloadEngine('routea');
await unloadEngine('routeb');
