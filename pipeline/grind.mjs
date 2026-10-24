// grind.mjs — 7.5 prototype → 8.0 library: targeted paragraph regeneration.
// Scores each paragraph with tmr (p_ai_gen), rewrites the worst paragraphs
// through hz (number-cloaked) repeatedly, keeps a paragraph only if its
// per-paragraph score improves. Per-paragraph scores are inflated vs
// whole-text (short-text regime); the whole-text score is the acceptance
// metric, measured by the caller after grinding.
// Guards per regen: validateUnit (numbers/citations/length) + NLI
// contradiction vs the original paragraph (same gate as v6 selection).
//
// Library:  grindParas({ origParas, paras, lang, rounds, worst, gain, gate, temps, log })
// CLI:      node grind.mjs <workDir-with-original.prose.txt> <in.prose.txt> <out.prose.txt> <lang> [rounds] [gain]
import fs from 'node:fs';
import path from 'node:path';
import { completeUnit, validateUnit, cloakNumbers, nliPairs, grammarScores } from './candidates.mjs';
import { splitSentences } from '../polish/src/text.mjs';
import { scoreTexts, closeDetector } from './detector_client.mjs';

const DEFAULT_TEMPS = [1.0, 1.15, 0.9, 1.05];

export async function grindParas({
  origParas, paras, lang = 'en',
  rounds = 3, worst = 3, gain = 0.02, gate = 0.08, gramCheck = 0.5,
  temps = DEFAULT_TEMPS, log = () => {},
}) {
  const stats = { roundsRun: 0, attempts: 0, accepted: 0, noGain: 0, rejected: 0, failed: 0, paraDeltas: {} };
  const out = [...paras];
  const paraScores = async (ps) => (await scoreTexts(ps)).map((s) => s.p_ai_gen ?? 1);

  for (let r = 1; r <= rounds; r++) {
    stats.roundsRun = r;
    const scores = await paraScores(out);
    const order = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
    // headings/tiny lines can't be ground — never let them occupy worst slots
    const grindable = order.filter((x) => out[x.i].split(/\s+/).length >= 20);
    const targets = grindable.slice(0, worst).filter((x) => x.s > gate);
    if (!targets.length) { log(`round ${r}: all paragraphs ≤${gate}, done`); break; }
    log(`round ${r}: worst = ${targets.map((w) => `p${w.i + 1}(${w.s.toFixed(2)})`).join(' ')}`);
    let acceptedAny = false;
    for (const w of targets) {
      const p = out[w.i];
      let improved = false;
      for (let attempt = 0; attempt < temps.length && !improved; attempt++) {
        stats.attempts++;
        try {
          const { cloaked, restore } = cloakNumbers(p);
          const candidate = restore(await completeUnit({ text: cloaked, sampling: { temperature: temps[attempt], topP: 0.95 } }));
          const v = validateUnit(p, candidate, lang);
          if (!v.ok) { stats.rejected++; log(`  p${w.i + 1}: attempt ${attempt + 1} rejected (${v.reason})`); continue; }
          if (origParas[w.i]) {
            const [pair] = await nliPairs([[origParas[w.i], candidate]]);
            if (pair && pair.contradict > 0.5) { stats.rejected++; log(`  p${w.i + 1}: attempt ${attempt + 1} NLI reject (${pair.contradict.toFixed(2)})`); continue; }
          }
          // 8.0.1: per-sentence CoLA gate — a regen that reads ungrammatical
          // used to poison the whole grind (post-check then reverted every
          // gain). Reject the sentence here and keep the good paragraphs.
          if (gramCheck > 0) {
            const sents = splitSentences(candidate, lang).map((s) => s.text);
            if (sents.length) {
              const grams = await grammarScores(sents);
              const bad = grams.filter((g) => g < gramCheck).length;
              if (bad > 0) { stats.rejected++; log(`  p${w.i + 1}: attempt ${attempt + 1} ungrammatical (${bad}/${sents.length} sentences < ${gramCheck})`); continue; }
            }
          }
          const [sc] = await scoreTexts([candidate]);
          const s2 = sc?.p_ai_gen ?? 1;
          if (s2 < w.s - gain) {
            log(`  p${w.i + 1}: ${w.s.toFixed(3)} -> ${s2.toFixed(3)} ✓`);
            out[w.i] = candidate;
            improved = true; acceptedAny = true; stats.accepted++;
            stats.paraDeltas[w.i] = { before: Number(w.s.toFixed(3)), after: Number(s2.toFixed(3)) };
          } else {
            stats.noGain++;
            log(`  p${w.i + 1}: attempt ${attempt + 1} no gain (${s2.toFixed(3)})`);
          }
        } catch (e) {
          stats.failed++;
          log(`  p${w.i + 1} failed: ${e.message.slice(0, 80)}`);
        }
      }
    }
    if (!acceptedAny) { log(`round ${r}: no paragraph improved, stopping early`); break; }
  }
  const finalScores = await paraScores(out);
  stats.finalParaMean = Number((finalScores.reduce((a, b) => a + b, 0) / Math.max(1, finalScores.length)).toFixed(3));
  return { paras: out, stats };
}

// ── 8.1: NLI rescue ─────────────────────────────────────────────────────────
// A candidate with one contradicting paragraph used to be skipped whole. Here
// only the offending paragraphs are regenerated (same guards as grind:
// validateUnit + per-sentence CoLA + NLI vs the original paragraph) and the
// caller re-verifies the whole candidate afterwards.
export async function rescueContradictions({
  origParas, paras, badIdx, lang = 'en',
  tries = 3, gramCheck = 0.5, temps = DEFAULT_TEMPS, log = () => {},
}) {
  const out = [...paras];
  const fixed = {};
  for (const i of badIdx) {
    if (!out[i]) continue;
    let done = false;
    for (let t = 0; t < tries && !done; t++) {
      try {
        const { cloaked, restore } = cloakNumbers(out[i]);
        const candidate = restore(await completeUnit({ text: cloaked, sampling: { temperature: temps[t % temps.length], topP: 0.95 } }));
        const v = validateUnit(out[i], candidate, lang);
        if (!v.ok) { log(`  rescue p${i + 1} attempt ${t + 1} rejected (${v.reason})`); continue; }
        if (gramCheck > 0) {
          const sents = splitSentences(candidate, lang).map((s) => s.text);
          if (sents.length) {
            const grams = await grammarScores(sents);
            const bad = grams.filter((g) => g < gramCheck).length;
            if (bad > 0) { log(`  rescue p${i + 1} attempt ${t + 1} ungrammatical (${bad}/${sents.length})`); continue; }
          }
        }
        if (origParas[i]) {
          const [pair] = await nliPairs([[origParas[i], candidate]]);
          if (pair && pair.contradict > 0.5) { log(`  rescue p${i + 1} attempt ${t + 1} still contradicts (${pair.contradict.toFixed(2)})`); continue; }
        }
        out[i] = candidate;
        fixed[i] = true;
        done = true;
        log(`  rescue p${i + 1}: ✓`);
      } catch (e) {
        log(`  rescue p${i + 1} attempt ${t + 1} failed: ${e.message.slice(0, 80)}`);
      }
    }
  }
  return { paras: out, fixed };
}

// ── CLI wrapper (standalone use; v6.mjs calls grindParas directly) ─────────
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [WORK, IN, OUT, LANG = 'en', ROUNDS = '3', GAIN = '0.02'] = process.argv.slice(2);
  if (!WORK || !IN || !OUT) {
    console.error('usage: node grind.mjs <workDir-with-original.prose.txt> <in.prose.txt> <out.prose.txt> <lang> [rounds] [gain]');
    process.exit(1);
  }
  const originalProse = fs.readFileSync(path.join(WORK, 'original.prose.txt'), 'utf8');
  const origParas = originalProse.split(/\n\s*\n/).filter((p) => p.trim());
  const paras = fs.readFileSync(IN, 'utf8').split(/\n\s*\n/).filter((p) => p.trim());
  const { paras: out, stats } = await grindParas({
    origParas, paras, lang: LANG, rounds: parseInt(ROUNDS, 10), gain: parseFloat(GAIN),
    log: (m) => console.log(m),
  });
  console.log('final paragraph mean:', stats.finalParaMean);
  console.log(`attempts: ${stats.attempts} = accepted ${stats.accepted} + no-gain ${stats.noGain} + rejected ${stats.rejected}${stats.failed ? ` + failed ${stats.failed}` : ''}`);
  fs.writeFileSync(OUT, out.join('\n\n') + '\n', 'utf8');
  console.log('-> ' + OUT);
  await closeDetector();
  process.exit(0);
}
