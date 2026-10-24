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
import { splitSentences, tokenSet, jaccard, wordCount } from '../polish/src/text.mjs';
import { scoreTexts, closeDetector } from './detector_client.mjs';

const DEFAULT_TEMPS = [1.0, 1.15, 0.9, 1.05];

// ── 8.4: sentence-mode fallback ─────────────────────────────────────────────
// Paragraph regen of hyper-LM prose at grind temps frequently shatters
// grammar (12/28 broken sentences). Sentence mode walks the paragraph one
// sentence at a time: regen the most AI-flavored (highest per-sentence tmr)
// sentences individually, accept only strict improvements, verify the whole
// paragraph against the original once at the end.
const ACADEMIC_SENT_INSTR = 'Rewrite this sentence in an academic register: no contractions, no second person, no rhetorical questions, no sentence fragments, no spoken fillers. Keep the original meaning and all facts exactly.';

// 8.6: register & structure guards — QA on the 0.649 assault text caught
// colloquial openers ("So I guess", "Oh, and"), second person, "E.g./etc.",
// fragments ("As an example, e-commerce.") and thesis duplicates. All are
// deterministic rejects measured against the sentence being rewritten.
function styleGuard(before, cand, restSents, lang = 'en') {
  const c = String(cand).trim();
  if (/^(so|oh|well|and|but|also|maybe|perhaps|then|now)[, ]/i.test(c)) return 'colloquial opener';
  if (/\b(you|your)\b/i.test(c) && !/\b(you|your)\b/i.test(before)) return 'second person';
  if (/\b(e\.g\.|i\.e\.|etc\.|i guess|i think)\b/i.test(c) && !/\b(e\.g\.|i\.e\.|etc\.)\b/i.test(before)) return 'informal marker';
  if (/\?\s*$/.test(c) && !before.includes('?')) return 'rhetorical question';
  if (!/[.!?]["']?\s*$/.test(c)) return 'no terminal punctuation';
  const newSents = splitSentences(c, lang).map((s) => s.text);
  if (newSents.some((s) => s.trim().split(/\s+/).filter(Boolean).length < 4)) return 'fragment';
  for (const cs of newSents) {
    for (const r of restSents) {
      const A = tokenSet(cs, lang);
      const B = tokenSet(r, lang);
      if (A.size < 5 || B.size < 5) continue;
      let shared = 0;
      for (const w of A) if (B.has(w)) shared++;
      if (shared / Math.min(A.size, B.size) >= 0.75) return 'duplicate of a neighbour';
    }
  }
  return null;
}

async function sentenceModeRegen({ paras, idx, origParas, lang = 'en', maxSents = 5, log = () => {} }) {
  const backup = paras[idx];
  const sents = splitSentences(paras[idx], lang);
  if (sents.length < 3) return false;
  const origSents = origParas[idx] ? splitSentences(origParas[idx], lang).map((s) => s.text) : [];
  const grams = await grammarScores(sents.map((s) => s.text));
  const tmrs = await scoreTexts(sents.map((s) => s.text));
  const targets = sents
    .map((s, i) => ({ s, i, gram: grams[i], tmr: tmrs[i]?.p_ai_gen ?? 1 }))
    .filter((x) => wordCount(x.s.text, lang) >= 8)
    .sort((a, b) => b.tmr - a.tmr)
    .slice(0, maxSents);
  let changed = 0;
  for (const t of [...targets].sort((a, b) => b.s.start - a.s.start)) {
    // 8.6: map to the original sentence for per-sentence meaning-drift NLI —
    // paragraph-level NLI is diluted on long paragraphs and missed drifts.
    let origSent = null, bestSim = 0;
    for (const os of origSents) {
      const sim = jaccard(tokenSet(t.s.text, lang), tokenSet(os, lang));
      if (sim > bestSim) { bestSim = sim; origSent = os; }
    }
    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      try {
        const { cloaked, restore } = cloakNumbers(t.s.text);
        const cand = restore(await completeUnit({ text: cloaked, sampling: { temperature: 0.9, topP: 0.95 }, instruction: ACADEMIC_SENT_INSTR }));
        const v = validateUnit(t.s.text, cand, lang);
        if (!v.ok) { log(`    s${t.i + 1} rejected (${v.reason})`); continue; }
        const guard = styleGuard(t.s.text, cand, sents.filter((x) => x.start !== t.s.start).map((x) => x.text), lang);
        if (guard) { log(`    s${t.i + 1} rejected (${guard})`); continue; }
        const candSents = splitSentences(cand, lang).map((s) => s.text);
        const cgrams = await grammarScores(candSents);
        if (cgrams.some((g) => g < 0.75)) { log(`    s${t.i + 1} ungrammatical`); continue; }
        if (origSent && bestSim >= 0.15) {
          const [pair] = await nliPairs([[origSent, cand]]);
          if (pair && pair.contradict > 0.5) { log(`    s${t.i + 1} NLI reject (meaning drift)`); continue; }
        }
        const [ct] = await scoreTexts([cand]);
        if ((ct?.p_ai_gen ?? 1) >= t.tmr - 0.02) { log(`    s${t.i + 1}: tmr ${t.tmr.toFixed(2)} → ${(ct?.p_ai_gen ?? 1).toFixed(2)}, no gain`); continue; }
        paras[idx] = paras[idx].slice(0, t.s.start) + cand + paras[idx].slice(t.s.end);
        changed++;
        log(`    s${t.i + 1}: tmr ${t.tmr.toFixed(2)} → ${(ct?.p_ai_gen ?? 1).toFixed(2)} ✓`);
        done = true;
      } catch (e) {
        log(`    s${t.i + 1} failed: ${e.message.slice(0, 80)}`);
      }
    }
  }
  if (!changed) return false;
  if (origParas[idx]) {
    const [pair] = await nliPairs([[origParas[idx], paras[idx]]]);
    if (pair && pair.contradict > 0.5) {
      paras[idx] = backup;
      log(`    sentence mode: NLI reject, paragraph reverted`);
      return false;
    }
  }
  log(`    sentence mode: ${changed} 句改善`);
  return true;
}

export async function grindParas({
  origParas, paras, lang = 'en',
  rounds = 3, worst = 3, gain = 0.02, gate = 0.08, gramCheck = 0.5, dryStop = 1, extreme = false,
  temps = DEFAULT_TEMPS, log = () => {},
}) {
  const stats = { roundsRun: 0, attempts: 0, accepted: 0, noGain: 0, rejected: 0, failed: 0, paraDeltas: {}, dryRounds: 0, totalGain: 0, weakRounds: 0 };
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
    let roundGain = 0;
    for (const w of targets) {
      const p = out[w.i];
      let improved = false;
      let sawUngrammatical = false;
      // 8.7: extreme docs — paragraph regen at grind temps shatters ~always
      // (run84/run2 data), each failed attempt burns ~45s. One attempt only,
      // then straight to sentence mode.
      const attemptsN = extreme ? 1 : temps.length;
      for (let attempt = 0; attempt < attemptsN && !improved; attempt++) {
        stats.attempts++;
        try {
          const { cloaked, restore } = cloakNumbers(p);
          const candidate = restore(await completeUnit({ text: cloaked, sampling: { temperature: temps[attempt % temps.length], topP: 0.95 } }));
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
              if (bad > 0) { stats.rejected++; sawUngrammatical = true; log(`  p${w.i + 1}: attempt ${attempt + 1} ungrammatical (${bad}/${sents.length} sentences < ${gramCheck})`); continue; }
            }
          }
          const [sc] = await scoreTexts([candidate]);
          const s2 = sc?.p_ai_gen ?? 1;
          if (s2 < w.s - gain) {
            log(`  p${w.i + 1}: ${w.s.toFixed(3)} -> ${s2.toFixed(3)} ✓`);
            out[w.i] = candidate;
            improved = true; acceptedAny = true; stats.accepted++;
            roundGain += w.s - s2;
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
      // 8.4: paragraph regen keeps shattering → drop to per-sentence attacks
      if (!improved && sawUngrammatical) {
        log(`  p${w.i + 1}: paragraph regen shatters, trying sentence mode`);
        const before = await scoreTexts([out[w.i]]);
        if (await sentenceModeRegen({ paras: out, idx: w.i, origParas, lang, log })) {
          improved = true; acceptedAny = true; stats.accepted++;
          const [sc] = await scoreTexts([out[w.i]]);
          const after = sc?.p_ai_gen ?? 1;
          roundGain += Math.max(0, (before[0]?.p_ai_gen ?? 1) - after);
          stats.paraDeltas[w.i] = { before: Number(w.s.toFixed(3)), after: Number(after.toFixed(3)) };
        }
      }
    }
    stats.totalGain += roundGain;
    // 8.7: convergence stop — two consecutive low-gain rounds mean the rest
    // is stubborn register wall; more rounds burn runtime without results.
    if (roundGain < 0.02) {
      stats.weakRounds++;
      log(`  round ${r}: total gain ${roundGain.toFixed(3)} (${stats.weakRounds}/2 weak)`);
      if (stats.weakRounds >= 2) { log('  收斂：連續兩輪增益不足，停止研磨'); break; }
    } else stats.weakRounds = 0;
    if (!acceptedAny) {
      stats.dryRounds++;
      log(`round ${r}: no paragraph improved (${stats.dryRounds}/${dryStop} dry)`);
      if (stats.dryRounds >= dryStop) break;
    } else stats.dryRounds = 0;
  }
  const finalScores = await paraScores(out);
  stats.finalParaMean = Number((finalScores.reduce((a, b) => a + b, 0) / Math.max(1, finalScores.length)).toFixed(3));
  return { paras: out, stats };
}

// ── 8.1/8.2: NLI rescue ─────────────────────────────────────────────────────
// A candidate with contradicting or content-losing paragraphs used to be
// skipped whole. Here only the offending paragraphs are regenerated (guards:
// validateUnit + per-sentence CoLA + NLI vs the original paragraph) and the
// caller re-verifies the whole candidate afterwards.
// badIdx entries: paragraph indices. Acceptance: contradict ≤ maxContradict;
// when minEntail > 0 also entail ≥ minEntail (content-loss rescue).
export async function rescueContradictions({
  origParas, paras, badIdx, lang = 'en',
  tries = 3, gramCheck = 0.5, maxContradict = 0.5, minEntail = 0,
  temps = DEFAULT_TEMPS, log = () => {},
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
          const badC = pair && pair.contradict > maxContradict;
          const badE = minEntail > 0 && pair && (pair.entail ?? 1) < minEntail;
          if (badC || badE) { log(`  rescue p${i + 1} attempt ${t + 1} still fails NLI (contradict ${(pair?.contradict ?? 0).toFixed(2)}, entail ${(pair?.entail ?? 0).toFixed(2)})`); continue; }
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

// ── 8.2: similarity polish ──────────────────────────────────────────────────
// Similarity (查重) is stock-phrase overlap: predictable wording matches the
// web's. Calibration: the ppl-30.5 delivery scored 13% similarity, the
// ppl-24.9 one 22%. Here the LEAST surprising sentences (lowest per-sentence
// ppl = most stock) are regenerated to raise their unpredictability, behind
// the usual guards. Facts/citations are left alone; acceptance per sentence
// is "new ppl strictly higher"; the caller verifies the whole text stays in
// the delivery band afterwards.
export async function similarityPolish({
  origParas, paras, lang = 'en',
  worst = 3, tries = 2, minWords = 10, gramCheck = 0.5,
  temps = DEFAULT_TEMPS, log = () => {},
}) {
  const ss = splitSentences;
  const out = [...paras];
  const sentPpl = async (s) => (await scoreTexts([s]))[0]?.perplexity ?? null;
  const flat = [];
  out.forEach((p, pi) => {
    ss(p, lang).forEach((s, si) => {
      if (wordCountOk(s.text, lang, minWords) && !s.text.includes('(')) flat.push({ pi, si, text: s.text });
    });
  });
  for (const f of flat) f.ppl = await sentPpl(f.text);
  const targets = flat.filter((f) => f.ppl != null).sort((a, b) => a.ppl - b.ppl).slice(0, worst);
  if (!targets.length) { log('similarity: no eligible stock sentences'); return { paras: out, stats: { attempts: 0, accepted: 0, moves: [] } }; }
  log(`similarity: stock sentences = ${targets.map((t) => `p${t.pi + 1}s${t.si + 1}(${t.ppl.toFixed(0)})`).join(' ')}`);
  const stats = { attempts: 0, accepted: 0, moves: [] };
  for (const t of targets) {
    let done = false;
    for (let attempt = 0; attempt < tries && !done; attempt++) {
      stats.attempts++;
      try {
        const { cloaked, restore } = cloakNumbers(t.text);
        const candidate = restore(await completeUnit({ text: cloaked, sampling: { temperature: temps[attempt % temps.length], topP: 0.95 } }));
        const v = validateUnit(t.text, candidate, lang);
        if (!v.ok) { log(`  p${t.pi + 1}s${t.si + 1}: rejected (${v.reason})`); continue; }
        if (gramCheck > 0) {
          const sents = ss(candidate, lang).map((s) => s.text);
          const grams = await grammarScores(sents);
          if (grams.some((g) => g < gramCheck)) { log(`  p${t.pi + 1}s${t.si + 1}: ungrammatical`); continue; }
        }
        if (origParas[t.pi]) {
          const [pair] = await nliPairs([[origParas[t.pi], replaceSentence(out[t.pi], t.si, candidate, lang)]]);
          if (pair && pair.contradict > 0.5) { log(`  p${t.pi + 1}s${t.si + 1}: NLI reject`); continue; }
        }
        const newPpl = await sentPpl(candidate);
        if (newPpl == null || newPpl <= t.ppl) { log(`  p${t.pi + 1}s${t.si + 1}: ppl ${(t.ppl).toFixed(0)} → ${(newPpl ?? 0).toFixed(0)}, no gain`); continue; }
        out[t.pi] = replaceSentence(out[t.pi], t.si, candidate, lang);
        stats.accepted++;
        stats.moves.push({ para: t.pi, sent: t.si, pplBefore: Number(t.ppl.toFixed(0)), pplAfter: Number(newPpl.toFixed(0)) });
        log(`  p${t.pi + 1}s${t.si + 1}: ppl ${t.ppl.toFixed(0)} → ${newPpl.toFixed(0)} ✓`);
        done = true;
      } catch (e) {
        log(`  p${t.pi + 1}s${t.si + 1} failed: ${e.message.slice(0, 80)}`);
      }
    }
  }
  return { paras: out, stats };
}

function wordCountOk(text, lang, min) {
  const n = String(text).trim().split(/\s+/).filter(Boolean).length;
  return n >= min;
}

function replaceSentence(para, si, replacement, lang) {
  const sents = splitSentences(para, lang);
  const s = sents[si];
  if (!s) return para;
  return para.slice(0, s.start) + replacement + para.slice(s.end);
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
