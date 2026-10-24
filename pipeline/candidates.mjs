#!/usr/bin/env node
// candidates.mjs — Workflow 6.0 candidate generation, offline scoring, selection.
//
// Talks to the Humanizer app's own completion endpoint (/api/completion) with
// hz's byte-exact prompt, so candidates come from exactly the model hz uses —
// but with per-call sampling control and K independent samples.
//
// Exposed:
//   buildPrompt(text)                byte-exact hz prompt (+fingerprint check)
//   completeUnit({text, sampling})   one model call, n_predict from hz's rule
//   validateUnit(before, after, lang)
//   generateCandidate({plan, sampling, retries})   → {ok, unitTexts, paras, failures}
//   candidateStats({originalProse, prose, lang})   → coverage/sentence/copy features
//   scoreFiles(paths)                → detector_bridge JSON (one python process)
//   rankCandidates(cands)            → hard filters + weighted AI-risk ordering

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

import { factNumbers, citationsIn } from '../polish/src/checks.mjs';
import { detectLang, splitSentences, wordCount, tokenSet, jaccard } from '../polish/src/text.mjs';
import { gramScores as daemonGramScores, nliPairs as daemonNliPairs, scoreFiles as daemonScoreFiles, scoreTexts as daemonScoreTexts, closeDetector } from './detector_client.mjs';

// ── hz prompt, byte for byte (humanizer/hz.py) ─────────────────────────────
const INSTR = "Rewrite the text below so it reads like a person wrote it, not a language model.\n"
  + "\n"
  + "Reorganize it as you see fit. Vary sentence length on purpose. Cut hedging,\n"
  + "throat-clearing, and any sentence that only announces what comes next.\n"
  + "Prefer the concrete word over the abstract one. It is fine to sound uneven.\n"
  + "\n"
  + "Every fact, number, unit, date, name and quotation must survive unchanged.";
const SEP = "\n\n### Rewritten:\n\n";
const FINGERPRINT = 'cc51d66b4c593fbe';

export function buildPrompt(draft) {
  const prompt = INSTR + "\n\n" + draft.trim() + SEP;
  const fp = createHash('sha256').update(buildPromptShaInput()).digest('hex').slice(0, 16);
  if (fp !== FINGERPRINT) throw new Error(`hz prompt fingerprint drifted: ${fp} != ${FINGERPRINT}`);
  return prompt;
}
// The fingerprint is over the prompt of the literal text "X", mirroring hz.
function buildPromptShaInput() {
  return INSTR + "\n\n" + "X" + SEP;
}

// ── app API ─────────────────────────────────────────────────────────────────
export const APP_URL = process.env.HZ_APP_URL || 'http://127.0.0.1:47615';

async function appPost(pathname, body, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(APP_URL + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Humanizer': '1' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`app HTTP ${res.status}: ${String(await res.text()).slice(0, 200)}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function countTokens(text) {
  try {
    const d = await appPost('/api/tokenize', { content: text, add_special: false }, 30000);
    if (d && Array.isArray(d.tokens)) return d.tokens.length;
  } catch { /* fall through to word estimate */ }
  return Math.max(1, Math.round(text.split(/\s+/).length * 1.4));
}

// hz rule: n_predict = clamp(draft tokens × 2.5, 256, 2048)
function nPredictFor(tokens) {
  return Math.min(2048, Math.max(256, Math.round(tokens * 2.5)));
}

// ── 7.4: number cloaking — hz cannot drop what it never sees ───────────────
// Calibration across 4 doc types: data-heavy units (stats, years, percentages)
// were the common failure wall ("drops number N" → unit reverts to AI text).
// Cloak every numeric token with a unique placeholder, let hz rewrite around
// it, restore afterwards. Probe: 5/5 placeholders survive, citations intact.
const CLOAK_RE = /\b\d[\d.,]*\b/g;
// word-number chains worth pinning: "twenty percent", "sixty-two", "two hundred"
// — single bare numbers ("one can argue") stay untouched.
const _W = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|twentieth|twenty-first|twenty-second|twenty-third';
const CLOAK_WORD_RE = new RegExp(`\\b(?:${_W})(?:[- ](?:${_W}))(?: percent| per cent)?\\b|(?:${_W}) percent`, 'gi');

export function cloakNumbers(text) {
  const pairs = [];
  const put = (m) => {
    const tok = `ZXQ${pairs.length}K`;
    pairs.push([tok, m]);
    return tok;
  };
  // digits first, then word-number chains on the digit-cloaked text
  let cloaked = text.replace(CLOAK_RE, put);
  cloaked = cloaked.replace(CLOAK_WORD_RE, put);
  return {
    cloaked,
    restore: (t) => {
      let out = t;
      for (const [tok, orig] of pairs) out = out.split(tok).join(orig);
      return out;
    },
  };
}

export async function completeUnit({ text, sampling = {}, timeoutMs = 600000 }) {
  const tokens = await countTokens(text);
  const body = {
    prompt: buildPrompt(text),
    n_predict: nPredictFor(tokens),
    temperature: sampling.temperature ?? 1.0,
    top_p: sampling.topP ?? 0.95,
    top_k: 0,
    min_p: 0,
    repeat_penalty: 1.0,
  };
  const d = await appPost('/api/completion', body, timeoutMs);
  const out = String(d.content || '').replace(/\s*\n\s*/g, ' ').trim();
  if (!out) throw new Error('empty completion');
  return out;
}

// ── per-unit validation (deterministic, mirrors hz's own checks) ───────────
export function validateUnit(before, after, lang = 'en') {
  if (!after) return { ok: false, reason: 'empty' };
  if (before.trim() === after.trim()) return { ok: false, reason: 'returned the original' };
  if (/\bZXQ\d+K\b/.test(after)) return { ok: false, reason: 'garbled number token' };
  for (const n of factNumbers(before)) {
    if (!factNumbers(after).includes(n)) return { ok: false, reason: `drops number ${n}` };
  }
  for (const c of citationsIn(before)) {
    if (!citationsIn(after).includes(c)) return { ok: false, reason: `drops citation ${c}` };
  }
  const ratio = wordCount(after, lang) / Math.max(1, wordCount(before, lang));
  if (ratio < 0.4 || ratio > 2.5) return { ok: false, reason: `length ratio ${ratio.toFixed(2)}` };
  const sIn = splitSentences(before, lang).length;
  const sOutSents = splitSentences(after, lang);
  const sOut = sOutSents.length;
  if (sOut > Math.max(6, sIn * 3 + 3)) return { ok: false, reason: `sentence count ${sIn}->${sOut}` };
  // hz's "rewrite says the same thing twice": near-duplicate sentences in the output.
  const keys = sOutSents.map((s) => s.text.toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (keys[i].length >= 20 && keys[i] === keys[j]) return { ok: false, reason: 'repeats a sentence' };
      if (keys[i].length >= 40 && keys[j].length >= 40
        && (keys[i].includes(keys[j]) || keys[j].includes(keys[i]))) {
        return { ok: false, reason: 'repeats a sentence (contained)' };
      }
    }
  }
  return { ok: true, reason: '' };
}

// ── candidate generation over a plan ────────────────────────────────────────
// plan = docx_bridge.py `plan` output. Returns per-unit rewrites for every
// target paragraph; a unit that never validates after `retries` marks the
// candidate as broken (coverage < 1) instead of silently dropping prose.
export async function generateCandidate({ plan, sampling = {}, retries = 2, lang = 'en', log = () => {} }) {
  const unitTexts = {};
  const failures = [];
  for (const [paraIdx, target] of Object.entries(plan.targets)) {
    for (const unit of target.units) {
      let ok = false, last = '';
      for (let attempt = 0; attempt <= retries && !ok; attempt++) {
        try {
          const { cloaked, restore } = cloakNumbers(unit.text);
          const outRaw = await completeUnit({ text: cloaked, sampling });
          const out = restore(outRaw);
          const v = validateUnit(unit.text, out, lang);
          if (v.ok) {
            unitTexts[unit.id] = out;
            ok = true;
            break;
          }
          last = v.reason;
          log(`  unit ${unit.id} attempt ${attempt + 1} rejected (${v.reason})`);
        } catch (e) {
          last = e.message;
          log(`  unit ${unit.id} attempt ${attempt + 1} failed: ${e.message}`);
        }
      }
      if (!ok) failures.push({ unit: unit.id, para: paraIdx, reason: last });
    }
  }
  const paras = {};
  for (const [paraIdx, target] of Object.entries(plan.targets)) {
    const parts = target.units.map((u) => unitTexts[u.id]).filter(Boolean);
    if (parts.length === target.units.length) {
      paras[paraIdx] = parts.join(target.joiner || ' ');
    }
  }
  const coverage = Object.keys(plan.targets).length
    ? Object.keys(paras).length / Object.keys(plan.targets).length
    : 0;
  return { unitTexts, paras, failures, coverage };
}

// ── structural features for ranking ─────────────────────────────────────────
function ngrams(tokens, n) {
  const s = new Set();
  for (let i = 0; i + n <= tokens.length; i++) s.add(tokens.slice(i, i + n).join(' '));
  return s;
}

export function candidateStats({ originalProse, prose, lang }) {
  const before = splitSentences(originalProse, lang);
  const after = splitSentences(prose, lang);
  const shortAfter = after.filter((s) => wordCount(s.text, lang) <= 4).length;
  const lens = after.map((s) => wordCount(s.text, lang));
  const mean = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
  const varr = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, lens.length);
  const cv = mean > 0 ? Math.sqrt(varr) / mean : 0;
  const origLens = before.map((s) => wordCount(s.text, lang));
  const oMean = origLens.reduce((a, b) => a + b, 0) / Math.max(1, origLens.length);
  const oVar = origLens.reduce((a, b) => a + (b - oMean) ** 2, 0) / Math.max(1, origLens.length);
  const origCv = oMean > 0 ? Math.sqrt(oVar) / oMean : 0;
  const origTokens = originalProse.toLowerCase().match(/[a-z']+|\d+/g) || [];
  const newTokens = prose.toLowerCase().match(/[a-z']+|\d+/g) || [];
  const orig5 = ngrams(origTokens, 5);
  let hit = 0, total = 0;
  for (let i = 0; i + 5 <= newTokens.length; i++) {
    total++;
    if (orig5.has(newTokens.slice(i, i + 5).join(' '))) hit++;
  }
  return {
    sentencesBefore: before.length,
    sentencesAfter: after.length,
    sentenceInflation: before.length ? after.length / before.length : 0,
    shortSentenceDensity: after.length ? shortAfter / after.length : 0,
    cv,
    origCv,
    // < 1 means the candidate is SMOOTHER than the AI draft — calibration says
    // Turnitin flags those (final6.0: ratio 0.99 → 56%).
    cvRatio: origCv > 0 ? cv / origCv : 0,
    copyRate: total ? hit / total : 0,
    words: wordCount(prose, lang),
  };
}

// ── offline scoring via the persistent detector daemon (7.0) ───────────────
// All three helpers are async and share one warm python process; see
// detector_client.mjs. Kept as exports so older call sites keep working.
export const grammarScores = daemonGramScores;
export const nliPairs = daemonNliPairs;
export const scoreFiles = daemonScoreFiles;
export const scoreTexts = daemonScoreTexts;
export { closeDetector };

// ── document type: flowing essay vs form/template (plan, outline, lab sheet) ──
// Calibration: on form documents every sentence metric is masked by the
// template structure, and the only 0% recipe (A1 plan V2) was "hz + almost no
// touch". So form documents skip the CV band and the polish layer entirely.
const FORM_LABEL_RE = /(complete sentence|bullet point|topic sentence|thesis statement|hook statement|background information|body paragraph|complete apa|screenshot of the source|year of publication|full name of author|hyperlink\/doi|student name|class:|academic essay title)/i;

export function detectDocType(plan) {
  const paras = (plan.paragraphs || []).map((p) => (p || '').trim()).filter(Boolean);
  const labeled = paras.filter((p) => FORM_LABEL_RE.test(p)).length;
  const formScore = paras.length ? labeled / paras.length : 0;
  return { form: formScore >= 0.15, formScore, labeled, paragraphs: paras.length };
}

// Containment-style near-duplicate: most of the sentence's content words
// already appear in another sentence → the surgery would create a repeat.
function nearDup(a, b, lang) {
  const A = tokenSet(a, lang);
  const B = tokenSet(b, lang);
  if (A.size < 5 || B.size < 5) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size) >= 0.8;
}

// ── grammar surgery: fix damaged sentences by regenerating the ORIGINAL ─────
// sentence with hz (local, no API → no AI-edit signal), keeping the bursty
// rhythm of the rest of the paragraph intact.
export async function surgicalRepair({
  paras, originalsByPara, lang = 'en',
  cfg = {}, completer, scorer = grammarScores, log = () => {},
}) {
  const threshold = cfg.grammarThreshold ?? 0.5;
  const maxSurgeries = cfg.maxSurgeries ?? 8;
  const tries = cfg.surgeryTries ?? 3;
  const complete = completer || ((args) => completeUnit(args));
  const out = { paras: { ...paras }, surgeries: [], residualDamaged: 0 };
  let budget = maxSurgeries;

  for (const [paraIdx, text] of Object.entries(paras)) {
    const original = originalsByPara[paraIdx] || '';
    const originalSents = splitSentences(original, lang);
    let damaged = [];
    const sents = splitSentences(text, lang);
    if (sents.length) {
      const scores = await scorer(sents.map((s) => s.text));
      damaged = sents
        .map((s, i) => ({ sent: s, p: scores[i] }))
        .filter((d) => d.p < threshold)
        .sort((a, b) => b.sent.start - a.sent.start);   // right-to-left keeps offsets valid
    }
    let newText = text;
    for (const d of damaged) {
      if (budget <= 0) { out.residualDamaged++; continue; }
      // find the original sentence this damaged one came from
      let best = null, bestSim = 0;
      for (const os of originalSents) {
        const sim = jaccard(tokenSet(d.sent.text, lang), tokenSet(os.text, lang));
        if (sim > bestSim) { bestSim = sim; best = os; }
      }
      if (!best || bestSim < 0.15) { out.residualDamaged++; continue; }
      let fixed = null;
      for (let attempt = 1; attempt <= tries && !fixed; attempt++) {
        let cand;
        try {
          const { cloaked, restore } = cloakNumbers(best.text);
          cand = restore(await complete({ text: cloaked, sampling: {} }));
        } catch (e) {
          log(`  surgery p${paraIdx} attempt ${attempt} failed: ${e.message}`);
          continue;
        }
        const v = validateUnit(best.text, cand, lang);
        if (!v.ok) { log(`  surgery p${paraIdx} attempt ${attempt} rejected (${v.reason})`); continue; }
        const candSents = splitSentences(cand, lang);
        const candScores = await scorer(candSents.map((s) => s.text));
        if (candScores.some((p) => p < threshold)) {
          log(`  surgery p${paraIdx} attempt ${attempt} still ungrammatical`);
          continue;
        }
        // 6.1 lesson: surgery/patch junctions created repeated sentences
        // (P1 duplicate, duplicated T-section). Reject a fix that would
        // restate something already in the paragraph.
        const rest = sents.filter((x) => x !== d.sent).map((x) => x.text);
        if (candSents.some((cs) => rest.some((r) => nearDup(cs.text, r, lang)))) {
          log(`  surgery p${paraIdx} attempt ${attempt} rejected (would duplicate a sentence)`);
          continue;
        }
        fixed = cand;
      }
      if (fixed) {
        newText = newText.slice(0, d.sent.start) + fixed + newText.slice(d.sent.end);
        out.surgeries.push({ para: paraIdx, before: d.sent.text, after: fixed });
        budget--;
      } else {
        out.residualDamaged++;
      }
    }
    out.paras[paraIdx] = newText;
  }
  return out;
}

// ── selection ────────────────────────────────────────────────────────────────
// Calibration (pipeline/v6-test/calibration.json, 6 real Turnitin points):
//   passers  CV 0.414 (final5.0) / 0.644 (final3.0)
//   failures CV 0.390 (final6.0, 56% — smoother than the AI draft at 0.393),
//            plus coverage holes (final2.0) and AI-revision delta (final5.1).
// So burstiness is the primary rank feature and a candidate may never be
// smoother than the original draft. Sentence inflation is no longer a hard
// filter — the bursty style is exactly what Turnitin tolerates; its grammar
// damage is handled by unit validation and the polish layer.
export function rankCandidates(cands, { weights = {}, filters = {} } = {}) {
  const formMode = !!filters.formMode;
  const w = formMode
    ? { damage: 0.7, gen: 0.15, copy: 0.15, ...weights }
    : { burst: 0.55, damage: 0.3, gen: 0.05, edit: 0.05, plx: 0.05, ...weights };
  const f = {
    minCoverage: 1,
    minCvRatio: 1.1,          // essays: never deliver smoother than the AI draft
    cvBand: [0.45, 0.65],     // essays: the passing zone observed at Turnitin
    maxGrammarDamage: 0.08,   // post-surgery fraction of ungrammatical sentences
    minGrammarDamage: 0,      // ideal mode keeps a floor of visible roughness
    maxShortSentenceDensity: 0.45,
    maxCopyRate: 0.6,
    ...filters,
  };

  const eligible = cands.filter((c) => {
    if ((c.stats?.coverage ?? c.coverage ?? 0) < f.minCoverage) return false;
    if ((c.grammarDamage ?? 0) > f.maxGrammarDamage) return false;
    if ((c.grammarDamage ?? 0) < f.minGrammarDamage) return false;
    if (!formMode) {
      if ((c.stats.cvRatio || 0) > 0 && c.stats.cvRatio < f.minCvRatio) return false;
      if (c.stats.cv > 0 && c.stats.cv < f.cvBand[0] * 0.9) return false;
    }
    if (!formMode && c.stats.shortSentenceDensity > f.maxShortSentenceDensity) return false;
    if (c.stats.copyRate > f.maxCopyRate) return false;
    return Number.isFinite(c.score?.p_ai_gen);
  });

  const norm = (xs) => {
    const lo = Math.min(...xs), hi = Math.max(...xs);
    return xs.map((x) => (hi - lo < 1e-9 ? 0 : (x - lo) / (hi - lo)));
  };
  if (eligible.length) {
    const gen = norm(eligible.map((c) => c.score.p_ai_gen ?? 0));
    const edit = norm(eligible.map((c) => c.score.p_ai_edit ?? 0));
    const plx = norm(eligible.map((c) => c.score.perplexity ?? 0));
    const dmg = norm(eligible.map((c) => c.grammarDamage ?? 0));
    const copy = norm(eligible.map((c) => c.stats.copyRate));
    let burst = null, frag = null;
    if (!formMode) {
      const [bLo, bHi] = f.cvBand;
      const burstPen = eligible.map((c) => {
        if (c.stats.cv <= 0) return 1;
        if (c.stats.cv < bLo) return (bLo - c.stats.cv) / bLo;
        if (c.stats.cv > bHi) return (c.stats.cv - bHi) / bHi;
        return 0;
      });
      burst = norm(burstPen);
      frag = norm(eligible.map((c) => c.stats.sentenceInflation));
    }
    eligible.forEach((c, i) => {
      c.risk = w.damage * dmg[i]
        + (w.gen ?? 0) * gen[i]
        + (w.edit ?? 0) * edit[i]
        + (w.plx ?? 0) * (1 - plx[i])
        + (w.copy ?? 0) * copy[i]
        + (formMode ? 0
          : (w.burst ?? 0) * (burst ? burst[i] : 0)
            + (w.frag ?? 0) * (frag ? frag[i] : 0));
    });
  }
  eligible.sort((a, b) => a.risk - b.risk);
  return { eligible, rejected: cands.filter((c) => !eligible.includes(c)) };
}

// ── 7.0: paragraph-level crossover ─────────────────────────────────────────
// Instead of picking one whole candidate, pick the best paragraph of each
// position across all candidates: 6 candidates × 5 paragraphs ≈ 6⁵ effective
// combinations. Per-paragraph choice = lowest damage → CV-band distance →
// stickiness (prefer the globally best candidate on near-ties so the essay
// keeps one voice).
export function assembleCrossover({ cands, paraStats, cvBand = [0.45, 0.65], log = () => {} }) {
  const paras = {};
  const provenance = {};
  const ranked = [...cands].sort((a, b) => (a.risk ?? 9) - (b.risk ?? 9));
  const [bLo, bHi] = cvBand;
  const bandDist = (cv) => (cv <= 0 ? 1 : cv < bLo ? (bLo - cv) / bLo : cv > bHi ? (cv - bHi) / bHi : 0);

  for (const paraIdx of Object.keys(paraStats)) {
    const options = [];
    for (const c of cands) {
      const st = paraStats[paraIdx].find((x) => x.candId === c.id);
      if (!st || !(c.paras && c.paras[paraIdx])) continue;
      options.push({
        candId: c.id,
        text: c.paras[paraIdx],
        damage: st.damage,
        bandDist: bandDist(st.cv),
        stick: ranked.findIndex((r) => r.id === c.id),
      });
    }
    if (!options.length) continue;
    options.sort((a, b) => (a.damage - b.damage) || (a.bandDist - b.bandDist) || (a.stick - b.stick));
    let pick = options[0];
    // stickiness: if the globally best candidate's paragraph is essentially as
    // good (damage within 0.02, band distance within 0.05), keep one voice.
    const bestCandOption = options.find((o) => o.candId === ranked[0]?.id);
    if (bestCandOption && bestCandOption !== pick
      && bestCandOption.damage <= pick.damage + 0.02
      && bestCandOption.bandDist <= pick.bandDist + 0.05) {
      pick = bestCandOption;
    }
    paras[paraIdx] = pick.text;
    provenance[paraIdx] = pick.candId;
  }
  return { paras, provenance };
}

// ── 7.1: mechanical polish ──────────────────────────────────────────────────
// Deterministic fixes for the punctuation/quote classes CoLA cannot see
// (user QA on 7.0: citation period placement, missing period before 'T'
// labels, mixed curly/straight quotes). Applied to every delivered paragraph.
export function mechanicalPolish(text, lang = 'en') {
  let t = String(text);
  if (lang !== 'zh') {
    // one quote style: straight
    t = t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
    // "word. (Citation, 1971)." → "word (Citation, 1971)."
    t = t.replace(/([a-zA-Z])\.\s*\(([^()]{0,80}?\d{4}[^()]*?)\)\.?/g, '$1 ($2).');
    // citation paren directly followed by a SMART label with no period: "(Hanna et al., 2010) 'T'" → ").  'T'"
    t = t.replace(/(\([^()]{0,80}?\d{4}[^()]*?\))\s+(?='[A-Z]'|\\"[A-Z]\")/g, '$1. ');
    // stray double period after a closing citation
    t = t.replace(/\)\.\./g, ').');
    // space before punctuation
    t = t.replace(/ +([.,;])/g, '$1');
  }
  return t.trim();
}

// ── 7.0: adaptive early stop ────────────────────────────────────────────────
// After the first batch of candidates: if one already sits in the deliverable
// zone, skip generating the rest. balanced wants zero damage; ideal keeps a
// roughness band (calibration: only damage 0.086–0.245 texts passed <20).
export function shouldStopEarly(cands, { formMode = false, target = 'balanced', cvBand = [0.45, 0.65] } = {}) {
  const [bLo, bHi] = cvBand;
  return cands.some((c) => {
    if ((c.stats?.coverage ?? 0) < 1) return false;
    const dmg = c.grammarDamagePre ?? 0;
    if (formMode) return dmg <= 0.05;
    const cv = c.stats?.cv ?? 0;
    if (cv < bLo || cv > bHi) return false;
    return target === 'ideal' ? (dmg >= 0.03 && dmg <= 0.2) : dmg <= 0.08;
  });
}
