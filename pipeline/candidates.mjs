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

// 8.16: optional style guidance (style_vector.py / seed_extractor.py ->
// prompt_injector.mjs). Appended AFTER the hz instruction so every
// existing constraint (facts, numbers, quotations) still stands;
// default runs pass nothing and stay byte-identical to hz.
export function buildPrompt(draft, styleGuide = "") {
  const instr = styleGuide ? INSTR + "\n\n" + styleGuide : INSTR;
  const prompt = instr + "\n\n" + draft.trim() + SEP;
  const fp = createHash("sha256").update(buildPromptShaInput()).digest("hex").slice(0, 16);
  if (fp !== FINGERPRINT) throw new Error(`hz prompt fingerprint drifted: ${fp} != ${FINGERPRINT}`);
  return prompt;
}
// The fingerprint is over the prompt of the literal text "X", mirroring hz.
function buildPromptShaInput() {
  return INSTR + "\n\n" + "X" + SEP;
}

// ── app API ─────────────────────────────────────────────────────────────────
export const APP_URL = process.env.HZ_APP_URL || 'http://127.0.0.1:47615';
export const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

// ── 10.0 parallel engine pool ───────────────────────────────────────────────
// Two fine-tuned engines join the stock hz model. Measured behaviour (v11):
//   routeb (humanizer-12b continued) drives ai_mk 0.45→0.16, CV 0.28→0.41
//   routea (Qwen3.5-9B) matches the student target text (dist -0.045)
// They are complementary but NON-ADDITIVE: chaining is useless because each
// engine returns its input unchanged once it already reads human
// (measured echo lev 0.00–0.085). Run them in parallel, pick per paragraph.
// Load one model at a time: one switch per document, never per unit.
export const ENGINES = {
  hz: {
    kind: 'app', url: APP_URL, format: 'hz',
    enabled: process.env.DISABLE_HZ !== '1',
  },
  routeb: {
    kind: 'ollama', url: OLLAMA_URL, format: 'hz', think: false,
    model: process.env.ROUTE_B_MODEL || 'routeb-humanizer12b',
    enabled: process.env.DISABLE_ROUTE_B !== '1',
  },
  routea: {
    kind: 'ollama', url: OLLAMA_URL, format: 'student', think: false,
    model: process.env.ROUTE_A_MODEL || 'routea-qwen35-9b',
    enabled: process.env.DISABLE_ROUTE_A !== '1',
  },
};

// route A was trained with this instruction, not hz's INSTR. Feeding it hz's
// INSTR puts it out of distribution (it learned this exact string).
const STUDENT_TPL = "Rewrite the following paragraph to sound like a genuine university student writing an academic essay "
  + "— natural, slightly imperfect, with the rhythm and word choices of a real L2 learner. Keep the same content.\n\n";

export function engineNames() {
  return Object.keys(ENGINES).filter((n) => ENGINES[n].enabled !== false);
}

export function engineInfo(name) {
  const e = ENGINES[name];
  if (!e) throw new Error(`unknown engine: ${name}`);
  return e;
}

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

async function ollamaGenerate(cfg, prompt, nPredict, opts, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const body = {
      model: cfg.model,
      prompt,
      raw: true,
      stream: false,
      options: {
        num_predict: nPredict,
        num_ctx: Number(process.env.OLLAMA_NUM_CTX || 8192),
        temperature: opts.temperature,
        top_p: opts.top_p,
        top_k: opts.top_k ?? 0,
        min_p: opts.min_p ?? 0,
        repeat_penalty: opts.repeat_penalty ?? 1.0,
      },
    };
    if (cfg.think === false) body.think = false;
    const res = await fetch(cfg.url + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${String(await res.text()).slice(0, 200)}`);
    const d = await res.json();
    if (d.error) throw new Error(`ollama: ${String(d.error).slice(0, 160)}`);
    return d;
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

export async function completeUnit({ text, sampling = {}, timeoutMs = 600000, instruction = '', styleGuide = '', engine = 'hz' }) {
  const cfg = engineInfo(engine);
  const tokens = await countTokens(text);
  // 7.6 word-budget mode: same hz rewrite instruction plus an explicit length
  // directive. Deliberately outside the byte-exact fingerprint contract —
  // this is our own extension, never claims to be hz's prompt.
  // 8.16: style guidance rides along in either mode.
  // 10.0: route A has its own instruction; style guidance is not applied to it
  // (its prompt must match the string it was tuned on).
  const prompt = cfg.format === 'student'
    ? STUDENT_TPL + text.trim()
    : (instruction
        ? `${INSTR}\n\n${instruction}${styleGuide ? `\n\n${styleGuide}` : ''}\n\n${text.trim()}${SEP}`
        : buildPrompt(text, engine === 'hz' ? styleGuide : ''));
  const nPredict = instruction
    ? Math.min(2048, Math.max(128, Math.round(tokens * 1.6)))
    : nPredictFor(tokens);
  const opts = {
    temperature: sampling.temperature ?? 1.0,
    top_p: sampling.topP ?? 0.95,
    top_k: 0,
    min_p: 0,
    repeat_penalty: 1.0,
  };
  let raw;
  if (cfg.kind === 'app') {
    const d = await appPost('/api/completion',
      { prompt, n_predict: nPredict, ...opts }, timeoutMs);
    raw = d.content;
  } else {
    const d = await ollamaGenerate(cfg, prompt, nPredict, opts, timeoutMs);
    raw = d.response;
  }
  const out = String(raw || '').replace(/\s*\n\s*/g, ' ').trim();
  if (!out) throw new Error(`empty completion (${engine})`);
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
export async function generateCandidate({ plan, sampling = {}, retries = 2, lang = 'en', log = () => {}, styleGuide = '', engine = 'hz' }) {
  const unitTexts = {};
  const failures = [];
  for (const [paraIdx, target] of Object.entries(plan.targets)) {
    for (const unit of target.units) {
      let ok = false, last = '';
      for (let attempt = 0; attempt <= retries && !ok; attempt++) {
        try {
          // Last try runs cold: a final deterministic pass against the
          // rambling/length-explosion failure mode that kills coverage.
          const isLast = attempt === retries;
          const sampling2 = isLast ? { temperature: 0.7, topP: 0.9 } : sampling;
          const { cloaked, restore } = cloakNumbers(unit.text);
          const outRaw = await completeUnit({ text: cloaked, sampling: sampling2, styleGuide, engine });
          const out = restore(outRaw);
          const v = validateUnit(unit.text, out, lang);
          if (v.ok) {
            unitTexts[unit.id] = out;
            ok = true;
            break;
          }
          last = v.reason;
          log(`  unit ${unit.id} attempt ${attempt + 1} rejected (${v.reason})${isLast ? ' [cold]' : ''}`);
        } catch (e) {
          last = e.message;
          log(`  unit ${unit.id} attempt ${attempt + 1} failed: ${e.message}`);
        }
      }
      if (!ok) failures.push({ unit: unit.id, para: paraIdx, reason: last, engine });
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

// ── 10.0 parallel pool ──────────────────────────────────────────────────────
// Presets follow WORKFLOW-10.0 §3.1. route B carries the anti-AI load, route A
// carries target-text fidelity; the mix shifts with the detected register.
export const POOL_PRESETS = {
  alpha: {
    routeb: [{ temperature: 0.90 }, { temperature: 1.00 }, { temperature: 1.05 }],
    routea: [{ temperature: 0.90 }, { temperature: 1.00 }],
  },
  beta: {
    routeb: [{ temperature: 0.90 }, { temperature: 1.00 }, { temperature: 1.05 }],
    routea: [{ temperature: 0.95 }],
  },
  gamma: {
    routeb: [{ temperature: 0.95 }, { temperature: 1.05 }],
    routea: [{ temperature: 0.85 }, { temperature: 0.95 }, { temperature: 1.05 }],
  },
};

// Release a model so the next engine has room. Ollama keeps weights for 5 min
// by default; route B alone is 8.9 GB on a 16 GB card.
export async function unloadEngine(name) {
  const cfg = ENGINES[name];
  if (!cfg || cfg.kind !== 'ollama') return false;
  try {
    await fetch(cfg.url + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, keep_alive: 0 }),
    });
    return true;
  } catch {
    return false;
  }
}

// Run the whole plan through one engine, then the next. One model switch per
// document — switching per unit would thrash VRAM and add minutes.
export async function generatePool({ plan, preset = 'gamma', retries = 2, lang = 'en',
                                     log = () => {}, styleGuide = '', engines = null }) {
  const spec = POOL_PRESETS[preset];
  if (!spec) throw new Error(`unknown pool preset: ${preset}`);

  const order = (engines || Object.keys(spec)).filter((e) => spec[e] && ENGINES[e]?.enabled);
  if (!order.length) throw new Error('no enabled engine in pool');

  const out = [];
  let n = 0;
  let current = null;

  for (const engine of order) {
    if (current && current !== engine) await unloadEngine(current);
    current = engine;
    const runs = spec[engine];
    log(`[pool] engine=${engine} model=${ENGINES[engine].model || 'app'} candidates=${runs.length}`);

    for (const sampling of runs) {
      const t0 = Date.now();
      const c = await generateCandidate({ plan, sampling, retries, lang, log, styleGuide, engine });
      out.push({ id: `cand${n++}`, engine, sampling, ...c, ms: Date.now() - t0 });
      log(`[pool] ${engine} t=${sampling.temperature} coverage=${(c.coverage * 100).toFixed(0)}% `
        + `fails=${c.failures.length} ${(Date.now() - t0) / 1000}s`);
    }
  }
  return out;
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
    : { burst: 0.3, damage: 0.3, gen: 0.25, edit: 0.05, plx: 0.05, copy: 0.05, ...weights };
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
    // 8.1: raw, interpretable damage scale (0 = clean, 1 = hard limit). Min-max
    // norm buried 0.040-damage gen-stars against a 0.045 outlier.
    const dmg = eligible.map((c) => Math.min(1, (c.grammarDamage ?? 0) / (f.maxGrammarDamage || 0.08)));
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
      // 8.0.1: use the raw band distance, not min-max normalized. The old
      // normalization turned a 3% band miss (CV 0.436 vs floor 0.45) into a
      // full penalty and buried a gen-0.028 candidate — the final5.0 profile
      // (0.414/0.046) that actually passed <20%.
      burst = burstPen;
      frag = eligible.map((c) => Math.max(0, (c.stats.sentenceInflation ?? 1) - 1));
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
// ── 10.0: document-level CV helper ──────────────────────────────────────────
// Population standard deviation, matching style_vector.py / v6.mjs (divide by N,
// not N-1). Getting this wrong shifts CV by ~11% at n=5 and can silently move a
// candidate out of the safety band.
export function docCv(text) {
  const lens = String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => (s.match(/[A-Za-z']+/g) || []).length)
    .filter((n) => n > 0);
  if (lens.length < 2) return 0;
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  if (!mean) return 0;
  const varr = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
  return Math.sqrt(varr) / mean;
}

export function assembleCrossover({ cands, paraStats, cvBand = [0.45, 0.65], log = () => {},
                                   targetCv = null, lengthPenalty = 0, docWords = null,
                                   engineBias = {} }) {
  const paras = {};
  const provenance = {};
  const ranked = [...cands].sort((a, b) => (a.risk ?? 9) - (b.risk ?? 9));
  const [bLo, bHi] = cvBand;
  const bandDist = (cv) => (cv <= 0 ? 1 : cv < bLo ? (bLo - cv) / bLo : cv > bHi ? (cv - bHi) / bHi : 0);
  const nParas = Object.keys(paraStats).length || 1;
  const paraTargetWords = docWords ? docWords / nParas : null;

  // 10.0: paragraph cost = damage + band distance + optional length + engine bias
  const cost = (o) => {
    let c = o.damage + o.bandDist + o.stick * 0.001;
    if (lengthPenalty > 0 && paraTargetWords) {
      const ratio = wordCount(o.text) / paraTargetWords;
      c += lengthPenalty * Math.max(0, ratio - 1.12);
    }
    const bias = engineBias[o.engine];
    if (typeof bias === 'number') c += bias;
    return c;
  };

  for (const paraIdx of Object.keys(paraStats)) {
    const options = [];
    for (const c of cands) {
      const st = paraStats[paraIdx].find((x) => x.candId === c.id);
      if (!st || !(c.paras && c.paras[paraIdx])) continue;
      options.push({
        candId: c.id,
        engine: c.engine || 'hz',
        text: c.paras[paraIdx],
        damage: st.damage,
        bandDist: bandDist(st.cv),
        paraCv: st.cv,
        stick: ranked.findIndex((r) => r.id === c.id),
      });
    }
    if (!options.length) continue;
    options.sort((a, b) => (cost(a) - cost(b)) || (a.stick - b.stick));
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

  // 10.0: after per-paragraph selection, lift the document CV toward targetCv.
  // Measured on the S4 document: per-paragraph picks alone reached CV 0.465,
  // which is already enough for the new engine family (Turnitin <20%), but a
  // document that lands lower benefits from swapping in burstier paragraphs.
  if (targetCv) {
    const joined = () => Object.keys(paraStats).map((k) => paras[k] || '').join(' ');
    let cur = docCv(joined());
    let swaps = 0;
    if (cur < targetCv) {
      const order = Object.keys(paraStats).sort((a, b) => (docCv(paras[a] || '') - docCv(paras[b] || '')));
      for (const paraIdx of order) {
        if (cur >= targetCv) break;
        const alts = [];
        for (const c of cands) {
          const st = paraStats[paraIdx]?.find((x) => x.candId === c.id);
          if (!st || !(c.paras && c.paras[paraIdx])) continue;
          if (c.paras[paraIdx] === paras[paraIdx]) continue;
          alts.push({ candId: c.id, text: c.paras[paraIdx], damage: st.damage, paraCv: st.cv });
        }
        alts.sort((a, b) => b.paraCv - a.paraCv);
        for (const alt of alts) {
          if (alt.damage > 0.05) break;         // never buy CV with broken grammar
          const prev = paras[paraIdx];
          const prevProv = provenance[paraIdx];
          paras[paraIdx] = alt.text;
          provenance[paraIdx] = alt.candId;
          const next = docCv(joined());
          if (next > cur) {
            cur = next;
            swaps++;
            if (next >= targetCv) break;
          } else {
            paras[paraIdx] = prev;
            provenance[paraIdx] = prevProv;
          }
        }
      }
      log(`[crossover] CV lift: target=${targetCv} final=${cur.toFixed(3)} swaps=${swaps}`);
    }
  }

  return { paras, provenance };
}

// ── 10.0: quality axis ──────────────────────────────────────────────────────
// The S4 acceptance test passed the score axis (<20% AI / 6% similarity /
// 0 flags) while shipping 11 reader-visible grammar errors. Score alone is not
// acceptance, so every delivery now reports both axes.
//
// Hard errors here mirror l2_fix.py grammar_damage(): a sentence with no
// terminal punctuation, or (6+ words) no finite-verb-like token.
// Sentences under 6 words are usually citations ("Li et al. (2015)") and are
// exempt from the verb check.
const FINITE_RE = /\b(am|is|are|was|were|be|been|being|has|have|had|do|does|did|can|could|will|would|shall|should|may|might|must|\w+ed|\w+s)\b/i;
// Only pronoun/auxiliary contractions count. Possessives ("today's",
// "consumer's") share the apostrophe-s shape and must not inflate the rate.
const CONTRACTION_RE = new RegExp([
  String.raw`\b(?:it|that|there|what|who|here|let|he|she|this|these|those)'s\b`,
  String.raw`\b(?:do|does|did|is|are|was|were|ca|wo|would|should|must|have|has|had|could)n't\b`,
  String.raw`\b(?:i|you|we|they|he|she|it|that|who|what|there)'re\b`,
  String.raw`\b(?:i|you|we|they|he|she|it)'ll\b`,
  String.raw`\b(?:i|you|we|they|he|she|it|that|who|there)'ve\b`,
  String.raw`\b(?:i|you|we|they|he|she|it)'d\b`,
  String.raw`\bcan't\b`,
].join('|'), 'gi');

export function qualityAxis(prose, originalProse, { lang = 'en' } = {}) {
  // splitSentences() returns [{text,start,end}], not strings.
  const sents = splitSentences(prose, lang)
    .map((s) => (typeof s === 'string' ? s : s.text))
    .map((s) => String(s).trim())
    .filter(Boolean);
  const noTerminal = sents.filter((s) => !/[.!?]["')\]]?$/.test(s)).length;
  const noFiniteVerb = sents.filter(
    (s) => s.split(/\s+/).length >= 6 && !FINITE_RE.test(s)).length;
  const words = wordCount(prose);
  const origWords = wordCount(originalProse) || 1;
  const contractions = (prose.match(CONTRACTION_RE) || []).length;
  return {
    sentences: sents.length,
    hardErrors: noTerminal + noFiniteVerb,
    noTerminal,
    noFiniteVerb,
    words,
    origWords,
    lengthRatio: Number((words / origWords).toFixed(3)),
    contractionRate: Number((words ? contractions * 100 / words : 0).toFixed(2)),
  };
}

// Pass/fail for the quality axis. Thresholds are deliberately loose on length
// (clients accept ±12%) and strict on grammar (a reader-visible error is a
// refund risk, a long sentence is not).
export function qualityVerdict(q, { maxLengthRatio = 1.12, maxContractions = 0.2,
                                    allowContractions = false } = {}) {
  const fails = [];
  if (q.hardErrors > 0) fails.push(`grammar:${q.hardErrors}`);
  if (q.lengthRatio > maxLengthRatio) fails.push(`length:${q.lengthRatio}`);
  if (!allowContractions && q.contractionRate > maxContractions) {
    fails.push(`contractions:${q.contractionRate}`);
  }
  return { pass: fails.length === 0, fails };
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
    // 8.2: nested parens around a citation — "(for the benefit of all, even
    // if ... (Bandy et al., 2020))." → "for the benefit of all, even if ...
    // (Bandy et al., 2020)."
    t = t.replace(/\(([^()]{25,}?)\s*\(([^()]{0,90}?\d{4}[^()]*?)\)\s*\)\s*\./g, '$1 ($2).');
    // 8.13: citation as sentence subject split by the period rule —
    t = t.replace(/\((\d{4})\)\.\s+([A-Z][a-z]+ed)\b/g, (m, y, v) => `(${y}) ${v.charAt(0).toLowerCase()}${v.slice(1)}`);
    t = t.replace(/\((\d{4})\)\.\s+([A-Z][a-z]+ed)\b/g, (m, y, v) => `(${y}) ${v.charAt(0).toLowerCase()}${v.slice(1)}`);
    // 8.13: ")., " period-comma artifact
    t = t.replace(/\)\.\s*,\s*/g, '), ');
    // 8.13: hz-invented paragraph heading glue ("Conclusion To sum up, ...")
    t = t.replace(/^(Conclusion|Introduction|Background|Methods|Results|Discussion|Analysis|Overview)\s+(?=[A-Z])/gm, '');
    // space before punctuation
    t = t.replace(/ +([.,;])/g, '$1');
  }
  return t.trim();
}

// ── 8.2: citation/reference year consistency ───────────────────────────────
// The pipeline guarantees citations survive verbatim — including when the
// DRAFT itself has an in-text year that disagrees with the reference list
// (E2: in-text Colchero et al., 2016 vs references (2017)). This check flags
// the mismatch and, when the reference list offers exactly one year for that
// author, safely aligns the in-text citation to it (references are the
// authority; the replacement touches only the citation paren).
export function citationConsistency({ paragraphs, prose, lang = 'en', fix = false }) {
  const citeRe = /\(((?:[A-Z][A-Za-z'’-]+(?:\s+(?:et al\.|and|&|,,,|,))?[^()]{0,80}?),?\s*(\d{4})[a-z]?)\)/g;
  const inText = [];
  let m;
  while ((m = citeRe.exec(String(prose))) !== null) {
    const surname = m[1].split(/,|\bet al\b/)[0].trim().split(/\s+/)[0];
    inText.push({ full: m[0], surname, year: m[2], index: m.index });
  }
  // reference entries: paragraphs after a References-style heading
  let inRefs = false;
  const refYears = {};
  for (const raw of paragraphs || []) {
    const p = String(raw || '').trim();
    if (!p) continue;
    if (!inRefs && REF_HEAD_RE.test(p)) { inRefs = true; continue; }
    if (!inRefs) continue;
    const years = p.match(/\b(?:19|20)\d{2}\b/g) || [];
    const surname = (p.split(/[(,]/)[0] || '').trim().split(/\s+/)[0];
    if (surname && years.length) refYears[surname.toLowerCase()] = [...new Set([...(refYears[surname.toLowerCase()] || []), ...years])];
  }
  const mismatches = [];
  let fixedProse = String(prose);
  const fixes = [];
  for (const c of inText) {
    const years = refYears[c.surname.toLowerCase()];
    if (!years || !years.length || years.includes(c.year)) continue;
    if (years.length === 1 && fix) {
      const replacement = c.full.replace(c.year, years[0]);
      fixedProse = fixedProse.split(c.full).join(replacement);
      fixes.push({ from: c.full, to: replacement, refYears: years });
      mismatches.push({ inText: c.full, refYears: years, fixed: true });
    } else {
      mismatches.push({ inText: c.full, refYears: years, fixed: false });
    }
  }
  return { checked: inText.length, references: Object.keys(refYears).length, mismatches, prose: fixedProse, fixes };
}

// ── 8.0: adaptive early stop ────────────────────────────────────────────────
// After the first batch of candidates: if one already sits in the deliverable
// zone, skip generating the rest. balanced wants zero damage; ideal keeps a
// roughness band (calibration: only damage 0.086–0.245 texts passed <20).
// 8.1: gen ≤ genGate is part of "deliverable" — CV/damage alone stop the
// sampling on rhythmically-fine, statistically-awful candidates (run8: three
// 0.5-0.8 candidates early-stopped while stars sat at #3-4).
export function shouldStopEarly(cands, { formMode = false, target = 'balanced', cvBand = [0.45, 0.65], genGate = 0.10 } = {}) {
  const [bLo, bHi] = cvBand;
  return cands.some((c) => {
    if ((c.stats?.coverage ?? 0) < 1) return false;
    if ((c.score?.p_ai_gen ?? 1) > genGate) return false;
    const dmg = c.grammarDamagePre ?? 0;
    if (formMode) return dmg <= 0.05;
    const cv = c.stats?.cv ?? 0;
    if (cv < bLo || cv > bHi) return false;
    return target === 'ideal' ? (dmg >= 0.03 && dmg <= 0.2) : dmg <= 0.08;
  });
}

// ── 8.3: burstiness rebuild for flat document families ──────────────────────
// The CV band (0.45–0.65) is calibrated on E2-family essays (origCv ≈ 0.37).
// Documents whose original CV sits at ~0.27 produce candidates at 0.29–0.36 —
// every one culled by the band floor, and the pipeline died. Here the
// flattest paragraphs are regenerated with an explicit sentence-length-
// variance instruction; acceptance per paragraph: CV rises ≥10%, validateUnit
// + NLI hold.
export function cvOf(text, lang = 'en') {
  const lens = splitSentences(text, lang).map((s) => wordCount(s.text, lang));
  const mean = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
  const va = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, lens.length);
  return mean > 0 ? Math.sqrt(va) / mean : 0;
}

const BURST_INSTR = 'Restructure the sentences with strong length contrast: include several very short sentences (3-6 words), several medium ones (10-15 words), and at least one or two long ones (25-35 words). Cut filler words. Break overly parallel structures. Every fact, number and citation must survive unchanged.';

export async function burstifyCandidate({
  c, originalsByPara, targetIdx, lang = 'en',
  rounds = 3, worst = 4, tries = 3, cvTarget = 0.45, gramCheck = 0.5, log = () => {},
}) {
  const paras = { ...c.paras };
  const moves = [];
  for (let r = 1; r <= rounds; r++) {
    const flat = Object.entries(paras)
      .map(([i, text]) => ({ i, cv: cvOf(text, lang), n: splitSentences(text, lang).length }))
      .filter((s) => s.n >= 2 && s.cv < cvTarget)
      .sort((a, b) => a.cv - b.cv)
      .slice(0, worst);
    if (!flat.length) { log(`  round ${r}: all paragraphs ≥ cv ${cvTarget}, done`); break; }
    log(`  round ${r}: flattest = ${flat.map((f) => `p${f.i}(cv ${f.cv.toFixed(2)})`).join(' ')}`);
    let improved = false;
    for (const t of flat) {
      let done = false;
      for (let attempt = 0; attempt < tries && !done; attempt++) {
        try {
          const { cloaked, restore } = cloakNumbers(paras[t.i]);
          const out = restore(await completeUnit({ text: cloaked, sampling: { temperature: [0.95, 1.05, 1.1][attempt % 3], topP: 0.95 }, instruction: BURST_INSTR }));
          const v = validateUnit(originalsByPara[t.i] || paras[t.i], out, lang);
          if (!v.ok) { log(`    p${t.i} rejected (${v.reason})`); continue; }
          const outSents = splitSentences(out, lang).map((s) => s.text);
          if (outSents.length) {
            const grams = await grammarScores(outSents);
            const bad = grams.filter((g) => g < gramCheck).length;
            if (bad > 0) { log(`    p${t.i} ungrammatical (${bad}/${outSents.length})`); continue; }
          }
          const [pair] = await nliPairs([[originalsByPara[t.i] || '', out]]);
          if (pair && pair.contradict > 0.5) { log(`    p${t.i} NLI reject`); continue; }
          const newCv = cvOf(out, lang);
          if (newCv < Math.max(0.1, Math.min(cvTarget, t.cv * 1.15))) { log(`    p${t.i} cv ${t.cv.toFixed(2)} → ${newCv.toFixed(2)}, no gain`); continue; }
          paras[t.i] = out;
          moves.push({ para: t.i, cvBefore: Number(t.cv.toFixed(2)), cvAfter: Number(newCv.toFixed(2)) });
          log(`    p${t.i}: cv ${t.cv.toFixed(2)} → ${newCv.toFixed(2)} ✓`);
          improved = true;
          done = true;
        } catch (e) {
          log(`    p${t.i} failed: ${e.message.slice(0, 80)}`);
        }
      }
    }
    if (!improved) break;
  }
  return { paras, moves };
}

// ── 7.6: word budget ────────────────────────────────────────────────────────
// Principle: delete before rewriting. Cutting a sentence from the untouched
// original adds zero AI-edit signal and keeps the surviving rhythm; a regen
// compression is only spent on target paragraphs still over their quota, and
// only behind validateUnit + the NLI gate. Never cuts mid-sentence, never
// deletes a sentence carrying numbers/citations, never below floorWords.
const REF_HEAD_RE = /^(references?|reference list|works cited|bibliography|參考文獻|參考資料)\s*:?\s*$/i;
export { REF_HEAD_RE };

// Every counted paragraph (empty lines and the References block excluded —
// academic word limits conventionally ignore them).
export function countedParagraphs(plan, paras) {
  const out = [];
  let inRefs = false;
  (plan.paragraphs || []).forEach((t, i) => {
    const s = String(t || '').trim();
    if (!s) return;
    if (!inRefs && REF_HEAD_RE.test(s)) { inRefs = true; return; }
    if (inRefs) return;
    out.push({ idx: String(i), original: s, text: paras[i] != null ? paras[i] : s });
  });
  return out;
}

function sacrificialSentences(text, lang) {
  const sents = splitSentences(text, lang);
  return sents
    .map((s, i) => ({
      i, text: s.text, words: wordCount(s.text, lang),
      isTopic: i === 0 || i === sents.length - 1,   // topic & wrap-up stay
      hasFact: factNumbers(s.text).length > 0 || citationsIn(s.text).length > 0,
    }))
    .filter((s) => !s.isTopic && !s.hasFact && s.words >= 6)
    .sort((a, b) => b.words - a.words);
}

function dropSentences(text, lang, drops) {
  const sents = splitSentences(text, lang);
  const kill = new Set(drops);
  return sents.filter((s, i) => !kill.has(i)).map((s) => s.text).join(' ');
}

export async function applyWordBudget({
  plan, chosenParas, originalsByPara, lang = 'en',
  budget = {}, log = () => {},
}) {
  const { maxWords, floorWords = null, maxCutRatio = 0.3, force = false } = budget;
  const doc = countedParagraphs(plan, chosenParas);
  if (!doc.length) return { ok: true, stats: { ok: true, note: 'no counted paragraphs' }, targetParas: {}, keptEdits: [] };
  if (floorWords != null && floorWords > maxWords) {
    return { ok: false, stats: { ok: false, reason: `floorWords ${floorWords} > maxWords ${maxWords}（配置矛盾）` }, targetParas: {}, keptEdits: [] };
  }
  const w = (t) => wordCount(t, lang);
  const totalNow = doc.reduce((n, p) => n + w(p.text), 0);
  const need = totalNow - maxWords;
  const stats = {
    ok: true, maxWords, floorWords, beforeWords: totalNow,
    deletedSentences: 0, deletedWords: 0, compressedParas: 0, failedCompressions: 0,
  };
  if (need <= 0) {
    stats.afterWords = totalNow;
    stats.note = `已在預算內（${totalWordsStr(totalNow, lang)} ≤ ${maxWords}），無需刪減`;
    log(stats.note);
    return { ok: true, stats, targetParas: {}, keptEdits: [] };
  }
  const cutRatio = need / totalNow;
  stats.cutRatio = Number(cutRatio.toFixed(3));
  if (cutRatio > maxCutRatio && !force) {
    stats.ok = false;
    stats.reason = `需削 ${Math.round(cutRatio * 100)}% > 上限 ${Math.round(maxCutRatio * 100)}%（--force-budget 可強制，建議人工確認內容取捨）`;
    return { ok: false, stats, targetParas: {}, keptEdits: [] };
  }

  // Round 1 — pure deletion, kept (untouched) paragraphs first: cutting there
  // carries no AI signal at all; then target paragraphs.
  const targetParas = {};
  const keptEdits = [];
  let remaining = need;
  const isTgt = (p) => (chosenParas[p.idx] != null ? 1 : 0);
  const order = [...doc].sort((a, b) => (isTgt(a) - isTgt(b)) || (w(b.text) - w(a.text)));
  for (const p of order) {
    if (remaining <= 0) break;
    const isTarget = chosenParas[p.idx] != null;
    const cur = isTarget ? chosenParas[p.idx] : p.text;
    const minParaWords = Math.max(15, Math.round(w(cur) * 0.4));  // don't hollow a paragraph out
    let canCut = w(cur) - minParaWords;
    if (canCut <= 0) continue;
    const killed = new Set();   // sentence indices (vs the round-start text) already cut
    for (const s of sacrificialSentences(cur, lang)) {
      if (remaining <= 0 || canCut - s.words < 0) break;
      killed.add(s.i);
      const next = dropSentences(cur, lang, killed);
      if (!next || w(next) <= 0) { killed.delete(s.i); break; }
      if (isTarget) targetParas[p.idx] = next;
      else {
        const idxN = Number(p.idx);
        const prev = keptEdits.findIndex((e) => e.idx === idxN);
        if (prev >= 0) keptEdits[prev] = { idx: idxN, text: next };
        else keptEdits.push({ idx: idxN, text: next });
      }
      if (chosenParas[p.idx] != null) chosenParas[p.idx] = next; else p.text = next;
      remaining -= s.words;
      stats.deletedSentences++;
      stats.deletedWords += s.words;
      canCut -= s.words;
    }
  }
  const afterDel = doc.reduce((n, p) => n + w(chosenParas[p.idx] != null ? chosenParas[p.idx] : p.text), 0);
  log(`刪除輪：刪 ${stats.deletedSentences} 句（-${stats.deletedWords} 詞）→ ${afterDel} / ${maxWords}`);

  // Round 2 — targeted regen compression on target paragraphs still over their
  // proportional quota. Kept paragraphs are never regenerated: they currently
  // carry zero rewrite signal and it must stay that way.
  if (afterDel > maxWords) {
    const totalOrig = doc.reduce((n, p) => n + w(p.original), 0);
    const over = doc
      .filter((p) => chosenParas[p.idx] != null)
      .map((p) => ({
        idx: p.idx,
        text: chosenParas[p.idx],
        quota: Math.max(30, Math.round((w(p.original) / totalOrig) * maxWords)),
      }))
      .filter((p) => w(p.text) > p.quota * 1.15)
      .sort((a, b) => (w(b.text) - b.quota) - (w(a.text) - a.quota));
    if (!over.length) log('壓縮輪：無超配額的目標段（超額來自 kept 段——請人工確認）');
    for (const p of over) {
      const cur = chosenParas[p.idx];
      const before = originalsByPara[p.idx] || cur;
      let accepted = null;
      for (let attempt = 1; attempt <= 3 && !accepted; attempt++) {
        try {
          const { cloaked, restore } = cloakNumbers(cur);
          const instruction = `Compress your rewrite to roughly ${p.quota} words. Cutting detail is fine; changing meaning is not.`;
          const out = restore(await completeUnit({ text: cloaked, sampling: { temperature: 1.0, topP: 0.95 }, instruction }));
          const v = validateUnit(before, out, lang);
          if (!v.ok) { log(`  壓縮 p${p.idx} 嘗試 ${attempt} 拒收（${v.reason}）`); continue; }
          if (w(out) > p.quota * 1.15) { log(`  壓縮 p${p.idx} 嘗試 ${attempt} 仍超配額（${w(out)} > ${p.quota}）`); continue; }
          if (lang !== 'zh') {
            const nli = await nliPairs([[before, out]]);
            if (nli[0] && nli[0].contradict > 0.5) { log(`  壓縮 p${p.idx} 嘗試 ${attempt} NLI 矛盾 ${fmt3(nli[0].contradict)}，拒收`); continue; }
          }
          accepted = out;
        } catch (e) {
          log(`  壓縮 p${p.idx} 嘗試 ${attempt} 失敗（${e.message}）`);
        }
      }
      if (accepted) {
        chosenParas[p.idx] = accepted;
        targetParas[p.idx] = accepted;
        stats.compressedParas++;
        log(`  壓縮 p${p.idx}：${w(cur)} → ${w(accepted)} 詞（配額 ${p.quota}）`);
      } else {
        stats.failedCompressions++;
      }
    }
  }

  stats.afterWords = doc.reduce((n, p) => n + w(chosenParas[p.idx] != null ? chosenParas[p.idx] : p.text), 0);
  if (stats.afterWords > maxWords) {
    stats.ok = false;
    stats.reason = `刪除＋壓縮後仍 ${stats.afterWords} > ${maxWords}（超 ${stats.afterWords - maxWords} 詞，需人工取捨）`;
    return { ok: false, stats, targetParas, keptEdits };
  }
  if (floorWords != null && stats.afterWords < floorWords) {
    stats.ok = false;
    stats.reason = `低於下限：${stats.afterWords} < ${floorWords}（刪減過頭，請放寬上限或收緊 maxCutRatio）`;
    return { ok: false, stats, targetParas, keptEdits };
  }
  log(`預算達成：${stats.beforeWords} → ${stats.afterWords} 詞（上限 ${maxWords}${floorWords != null ? `，下限 ${floorWords}` : ''}）`);
  return { ok: true, stats, targetParas, keptEdits };
}

function totalWordsStr(n, lang) { return lang === 'zh' ? `${n} 字` : `${n} words`; }
function fmt3(x) { return Number(x).toFixed(3); }

// ── 8.13: mechanical burstify — quality-preserving CV surgery ──────────────
// The model-regen restructure introduced net-new grammar errors (client QA:
// original > assault). This deterministic pass rebuilds sentence-length
// variance with ZERO model involvement: split long sentences at coordination
// boundaries, merge adjacent short ones. The original wording survives by
// construction — no new grammar errors are possible beyond splice smoothness.
export function mechanicalBurstify(text, lang = 'en') {
  if (lang !== 'en') return { text, ops: 0 };
  let ops = 0;
  const sents = splitSentences(text, 'en').map((s) => s.text);
  const pieces = [];
  for (const s of sents) {
    const w = s.trim().split(/\s+/).filter(Boolean).length;
    if (w < 24) { pieces.push(s); continue; }
    const boundaries = [...s.matchAll(/,\s+(and|but|yet|so)\s+/gi)];
    let splitDone = false;
    for (let bi = boundaries.length - 1; bi >= 0 && !splitDone; bi--) {
      const b = boundaries[bi];
      const left = s.slice(0, b.index).trim().replace(/[,;]$/, '');
      let right = s.slice(b.index + b[0].length).trim();
      if (left.split(/\s+/).length < 8 || right.split(/\s+/).length < 8) continue;
      const conj = b[1].toLowerCase();
      if (conj === 'and') right = right.charAt(0).toUpperCase() + right.slice(1);
      else if (conj === 'but') right = 'However, ' + right.charAt(0).toLowerCase() + right.slice(1);
      else if (conj === 'so') right = 'As a result, ' + right.charAt(0).toLowerCase() + right.slice(1);
      else if (conj === 'yet') right = 'Even so, ' + right.charAt(0).toLowerCase() + right.slice(1);
      pieces.push(left.replace(/[.!?]*$/, '') + '.');
      pieces.push(right);
      ops++; splitDone = true;
    }
    if (!splitDone) pieces.push(s);
  }
  const merged = [];
  for (const p of pieces) {
    const prev = merged[merged.length - 1];
    const pw = prev ? prev.trim().split(/\s+/).filter(Boolean).length : 99;
    const cw = p.trim().split(/\s+/).filter(Boolean).length;
    if (prev && pw <= 7 && cw <= 7 && /[.!?]$/.test(prev)) {
      merged[merged.length - 1] = prev.replace(/[.!?]$/, '') + '; ' + p.charAt(0).toLowerCase() + p.slice(1);
      ops++;
    } else merged.push(p);
  }
  return { text: merged.join(' '), ops };
}
