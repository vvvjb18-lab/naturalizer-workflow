// grind.mjs — 7.5 prototype: targeted paragraph regeneration.
// Takes a candidate's prose, scores each paragraph with tmr (p_ai_gen),
// rewrites the worst paragraphs through hz (number-cloaked) repeatedly,
// keeps a paragraph only if its per-paragraph score improves. Per-paragraph
// scores are inflated vs whole-text (short-text regime); the whole-text
// score is the acceptance metric, measured separately after grinding.
// Guards per regen: validateUnit (numbers/citations/length) + NLI
// contradiction vs the original paragraph (same gate as v6 selection).
// Usage: node grind.mjs <workDir-with-original.prose.txt> <in.prose.txt> <out.prose.txt> <lang> [rounds] [gain]
import fs from 'node:fs';
import path from 'node:path';
import { completeUnit, validateUnit, cloakNumbers, nliPairs } from './candidates.mjs';
import { scoreTexts, closeDetector } from './detector_client.mjs';

const [WORK, IN, OUT, LANG = 'en', ROUNDS = '3', GAIN = '0.02'] = process.argv.slice(2);
const rounds = parseInt(ROUNDS, 10);
const gain = parseFloat(GAIN);
const temps = [1.0, 1.1, 0.95];
const originalProse = fs.readFileSync(path.join(WORK, 'original.prose.txt'), 'utf8');
const origParas = originalProse.split(/\n\s*\n/).filter((p) => p.trim());

let paras = fs.readFileSync(IN, 'utf8').split(/\n\s*\n/).filter((p) => p.trim());

async function paraScores(ps) {
  const scores = await scoreTexts(ps);
  return scores.map((s) => s.p_ai_gen ?? 1);
}

for (let r = 1; r <= rounds; r++) {
  const scores = await paraScores(paras);
  const order = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
  // headings/tiny lines can't be ground — never let them occupy worst-3 slots
  const grindable = order.filter((x) => paras[x.i].split(/\s+/).length >= 20);
  const worst = grindable.slice(0, 3).filter((x) => x.s > 0.08);
  if (!worst.length) { console.log(`round ${r}: all paragraphs ≤0.08, done`); break; }
  console.log(`round ${r}: worst = ${worst.map((w) => `p${w.i + 1}(${w.s.toFixed(2)})`).join(' ')}`);
  for (const w of worst) {
    const p = paras[w.i];
    let improved = false;
    for (let attempt = 0; attempt < temps.length && !improved; attempt++) {
      try {
        const { cloaked, restore } = cloakNumbers(p);
        let out = restore(await completeUnit({ text: cloaked, sampling: { temperature: temps[attempt], topP: 0.95 } }));
        if (!validateUnit(p, out, LANG).ok) { console.log(`  p${w.i + 1}: attempt ${attempt + 1} failed validation`); continue; }
        if (origParas[w.i]) {
          const [pair] = await nliPairs([[origParas[w.i], out]]);
          if (pair && pair.contradict > 0.5) { console.log(`  p${w.i + 1}: attempt ${attempt + 1} NLI reject (${pair.contradict.toFixed(2)})`); continue; }
        }
        const [sc] = await scoreTexts([out]);
        if ((sc?.p_ai_gen ?? 1) < w.s - gain) {
          console.log(`  p${w.i + 1}: ${w.s.toFixed(3)} -> ${(sc.p_ai_gen).toFixed(3)} ✓`);
          paras[w.i] = out;
          improved = true;
        } else {
          console.log(`  p${w.i + 1}: attempt ${attempt + 1} no gain (${(sc?.p_ai_gen ?? 1).toFixed(3)})`);
        }
      } catch (e) {
        console.log(`  p${w.i + 1} failed: ${e.message.slice(0, 80)}`);
      }
    }
  }
}

const final = await paraScores(paras);
const mean = final.reduce((a, b) => a + b, 0) / final.length;
console.log('final paragraph scores:', final.map((s) => s.toFixed(2)).join(' '), `mean=${mean.toFixed(3)}`);
fs.writeFileSync(OUT, paras.join('\n\n') + '\n', 'utf8');
console.log('-> ' + OUT);
await closeDetector();
process.exit(0);
