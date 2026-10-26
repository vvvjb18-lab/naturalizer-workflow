// Orchestration: deterministic audit → model audit → minimal patch repair →
// hard gates. The model never receives the instruction "rewrite this text";
// it only sees defect reports and must return exact string replacements.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  auditDeterministic, validatePatch, validateRewrite, finalGates, docMetrics,
  factNumbers, citationsIn, structureAdditions, truncation, duplicateSentences,
  countOpeners, firstWord,
} from './checks.mjs';
import {
  detectLang, chunkText, locateSpan, wordCount, normalizeForMatch, diffWords, splitSentences,
  splitParagraphs, tokenSet, jaccard, sentenceMetrics,
} from './text.mjs';
import { auditPrompt, repairPrompt, cleanupPrompt, qualityJudgePrompt } from './prompts.mjs';
import { chatJson } from './llm.mjs';

const VALID_TYPES = new Set(['grammar', 'meaning', 'register', 'fact', 'citation', 'structure', 'terminology', 'cohesion']);
const VALID_SEVERITY = new Set(['critical', 'major', 'minor']);

const AUDIT_SYSTEM = 'You are a precise academic copy-editor. You find defects only. You never rewrite for elegance. You always return one JSON object and nothing else.';
const REPAIR_SYSTEM = 'You are a surgical copy-editor. You repair only the listed defects, using minimal exact string replacements. You never rewrite text that was not listed. You always return one JSON object and nothing else.';
const CLEANUP_SYSTEM = 'You are the final academic supervisor. You either fix one remaining defect locally or rewrite the sentence in a human academic voice. You never invent content. You always return one JSON object and nothing else.';
const JUDGE_SYSTEM = 'You are a strict academic quality judge. You compare texts and return one JSON object. You never rewrite.';

function cleanQuote(q) {
  return String(q || '')
    .replace(/^[\s"'“”‘’]+/, '')
    .replace(/[\s"'“”‘’…]+$/, '')
    .trim();
}

function issueKey(s) {
  return normalizeForMatch(String(s || '').toLowerCase()).replace(/[^\p{L}\p{N}]/gu, '');
}

function chunkIndexAt(chunks, pos) {
  for (let i = 0; i < chunks.length; i++) {
    if (pos >= chunks[i].start && pos < chunks[i].end) return i;
  }
  return chunks.length - 1;
}

function draftSlice(draft, chunk, totalChars, cfg, lang) {
  if (!draft) return '';
  const hardCap = cfg.maxDraftChars ?? 12000;
  const cap = lang === 'zh' ? Math.min(hardCap, 5000) : hardCap;
  if (draft.length <= cap) return draft;
  const pad = Math.floor(draft.length * 0.15);
  const start = Math.max(0, Math.round((chunk.start / totalChars) * draft.length) - pad);
  const end = Math.min(draft.length, Math.round((chunk.end / totalChars) * draft.length) + pad);
  return draft.slice(start, end);
}

function normalizeModelIssue(raw, lang) {
  if (!raw || typeof raw !== 'object') return null;
  const type = VALID_TYPES.has(raw.type) ? raw.type : 'grammar';
  const severity = VALID_SEVERITY.has(raw.severity) ? raw.severity : 'major';
  const quote = cleanQuote(raw.quote);
  const problem = String(raw.problem || '').trim();
  const fix = String(raw.fix || '').trim();
  if (!quote || !problem) return null;
  const limit = type === 'structure' ? 120 : 40;
  if (wordCount(quote, lang) > limit) return null;
  return { type, severity, quote, problem, fix, source: 'model' };
}

function severityRank(s) {
  return s === 'critical' ? 0 : s === 'major' ? 1 : 2;
}

function dedupeIssues(issues) {
  const out = [];
  for (const i of issues) {
    const key = issueKey(i.quote);
    const twin = out.find((o) => {
      if (o.type !== i.type) return false;
      const k2 = issueKey(o.quote);
      return key && k2 && (key.includes(k2) || k2.includes(key));
    });
    if (!twin) { out.push(i); continue; }
    // Keep the more specific (longer) quote, but never let a model quote that
    // swallowed a whole paragraph overwrite the machine's precise sentence.
    const twinLen = issueKey(twin.quote).length;
    const newLen = key.length;
    const reasonable = newLen > twinLen && newLen <= Math.max(twinLen * 3, twinLen + 40);
    const higherSeverity = severityRank(i.severity) < severityRank(twin.severity);
    if (reasonable || (newLen === twinLen && i.source === 'check' && twin.source !== 'check')) {
      Object.assign(twin, i);
    } else if (higherSeverity) {
      // Keep the machine's precise quote, but do not lose a more severe model finding.
      twin.severity = i.severity;
      if (i.problem) twin.problem = i.problem;
      if (i.fix) twin.fix = i.fix;
    }
  }
  return out;
}

function locateIssue(issue, humanized, chunks, hintPos) {
  let span = locateSpan(humanized, issue.quote, hintPos);
  if (!span) {
    const trimmed = issue.quote.replace(/[.,;:!?。，；：！？]+$/, '').trim();
    if (trimmed && trimmed !== issue.quote) span = locateSpan(humanized, trimmed, hintPos);
  }
  if (!span) return { ...issue, span: null, chunkIndex: null };
  return { ...issue, span, chunkIndex: chunkIndexAt(chunks, span.start) };
}

/**
 * Runs the full pass.
 * opts: { humanized, draft, cfg, log, auditOnly }
 */
export async function runPipeline({ humanized, draft, cfg, log = () => {}, auditOnly = false }) {
  const started = Date.now();
  const lang = cfg.lang && cfg.lang !== 'auto' ? cfg.lang : detectLang(humanized);
  const chunkChars = lang === 'zh'
    ? Math.min(cfg.chunkChars ?? 6000, 3200)
    : (cfg.chunkChars ?? 6000);
  const chunks = chunkText(humanized, chunkChars);
  const totalWords = wordCount(humanized, lang);
  const errors = [];
  const openers = countOpeners(humanized, lang);

  log(`language: ${lang} · ${totalWords} words · ${chunks.length} chunk(s)`);

  const pre = auditDeterministic(draft || humanized, humanized, lang);
  let issues = [...pre.issues];

  // ── model audit ────────────────────────────────────────────────────────────
  let modelCount = 0;
  for (const chunk of chunks) {
    const slice = draftSlice(draft, chunk, humanized.length, cfg, lang);
    log(`audit ${chunk.index + 1}/${chunks.length} (${wordCount(chunk.text, lang)} words)`);
    try {
      const data = await chatJson(cfg, {
        system: AUDIT_SYSTEM,
        user: auditPrompt({
          lang,
          draftText: slice || '(not provided — audit for internal defects only)',
          chunkText: chunk.text,
          context: pre.context,
          chunkIndex: chunk.index,
          chunkCount: chunks.length,
        }),
        label: `audit ${chunk.index + 1}/${chunks.length}`,
      }, log);
      const rawIssues = Array.isArray(data?.issues) ? data.issues : [];
      for (const raw of rawIssues) {
        const n = normalizeModelIssue(raw, lang);
        if (!n) continue;
        issues.push({ ...n, chunkHint: chunk.start });
        modelCount++;
      }
      log(`  → ${rawIssues.length} issue(s) reported`);
    } catch (e) {
      errors.push(`audit chunk ${chunk.index + 1}: ${e.message}`);
      log(`  audit failed: ${e.message}`);
    }
  }

  issues = dedupeIssues(issues);

  // Locate every issue (machine and model) once, and give model issues an id.
  let seq = 0;
  issues = issues.flatMap((i) => {
    if (!i.id) i.id = `M${++seq}`;
    const located = locateIssue(i, humanized, chunks, i.chunkHint ?? 0);
    if (!located.span) {
      errors.push(`issue quote not found in text: "${String(i.quote).slice(0, 80)}"`);
      return [];
    }
    return [located];
  });

  log(`issues: ${issues.length} (${pre.issues.length} machine, ${modelCount} model)`);

  if (auditOnly) {
    return {
      auditOnly: true,
      lang, chunks, issues, patches: [], unresolved: issues,
      outputText: humanized, gates: [], metrics: {
        before: docMetrics(humanized, lang), after: docMetrics(humanized, lang),
      },
      stats: { totalWords, found: issues.length, applied: 0, rejected: 0, changedWords: 0, changedRatio: 0, modelCount, machineCount: pre.issues.length },
      errors, manual: [], elapsedMs: Date.now() - started, context: pre.context,
    };
  }

  // ── repair ────────────────────────────────────────────────────────────────
  const accepted = [];
  const modelUnresolved = [];
  let rejected = 0;

  for (const chunk of chunks) {
    let chunkIssues = issues
      .filter((i) => i.chunkIndex === chunk.index && i.span)
      .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    if (!chunkIssues.length) continue;

    const limit = cfg.maxIssuesPerChunk ?? 20;
    if (chunkIssues.length > limit) {
      log(`chunk ${chunk.index + 1}: ${chunkIssues.length - limit} lower-priority issue(s) deferred`);
      chunkIssues = chunkIssues.slice(0, limit);
    }

    const slice = draftSlice(draft, chunk, humanized.length, cfg, lang);
    const batchSize = cfg.repairBatch ?? 12;

    for (let b = 0; b < chunkIssues.length; b += batchSize) {
      const batch = chunkIssues.slice(b, b + batchSize);
      log(`repair chunk ${chunk.index + 1}: issues ${b + 1}-${b + batch.length} of ${chunkIssues.length}`);

      let failed = [];
      for (let round = 0; round < 2; round++) {
        const toFix = round === 0 ? batch : failed;
        if (!toFix.length) break;
        let data;
        try {
          data = await chatJson(cfg, {
            system: REPAIR_SYSTEM,
            user: repairPrompt({
              lang,
              draftText: slice || '(not provided)',
              chunkText: chunk.text,
              issues: toFix,
              failed: round === 0 ? [] : failed,
              strict: round > 0,
              skill: cfg.skillPrompt || '',
            }),
            label: `repair chunk ${chunk.index + 1}.${b + round + 1}`,
          }, log);
        } catch (e) {
          errors.push(`repair chunk ${chunk.index + 1}: ${e.message}`);
          log(`  repair failed: ${e.message}`);
          break;
        }

        const patches = Array.isArray(data?.patches) ? data.patches : [];
        const unresolved = Array.isArray(data?.unresolved) ? data.unresolved : [];
        for (const u of unresolved) {
          const issue = toFix.find((i) => String(i.id) === String(u.issue));
          if (issue) modelUnresolved.push({ id: issue.id, quote: issue.quote, reason: String(u.reason || 'model could not fix locally') });
        }

        const nextFailed = [];
        const refuse = (issue, reason, attempt) => {
          rejected++;
          nextFailed.push({ ...issue, reason, attempt });
        };
        for (const p of patches) {
          const issue = toFix.find((i) => String(i.id) === String(p.issue));
          if (!issue) continue;
          const before = String(p.before || '');
          const after = String(p.after || '');
          if (!before || !after) {
            refuse(issue, 'missing before/after', `${before} => ${after}`);
            continue;
          }
          const localHint = issue.span.start - chunk.start;
          const local = locateSpan(chunk.text, before, localHint);
          if (!local) {
            refuse(issue, 'before not found verbatim in DRAFT B', before.slice(0, 160));
            continue;
          }
          const issueLocalStart = issue.span.start - chunk.start;
          const issueLocalEnd = issue.span.end - chunk.start;
          if (local.end <= issueLocalStart || local.start >= issueLocalEnd) {
            refuse(issue, 'replacement does not overlap the quoted defect', before.slice(0, 160));
            continue;
          }

          // A replacement must not repeat a sentence that already exists
          // elsewhere (this is how a verification pass can silently duplicate
          // content) and must not repeat itself internally.
          const outside = normalizeForMatch(
            chunk.text.slice(0, local.start) + '\n' + chunk.text.slice(local.end),
          );
          const newSentences = splitSentences(after, lang);
          const seenNew = new Set();
          const minKey = lang === 'zh' ? 10 : 24;
          let duplicate = false;
          for (const s of newSentences) {
            const key = normalizeForMatch(s.text);
            if (key.length < minKey) continue;
            if (outside.includes(key) || seenNew.has(key)) { duplicate = true; break; }
            seenNew.add(key);
          }
          if (duplicate) {
            refuse(issue, 'replacement repeats a sentence already present in the text', after.slice(0, 160));
            continue;
          }

          const beforeText = chunk.text.slice(local.start, local.end);
          const absStart = chunk.start + local.start;
          const preceding = humanized.slice(Math.max(0, absStart - 200), absStart).replace(/\s+$/, '');
          const startsSentence = preceding === '' || /[.!?。！？]["'”’)\]]*$/.test(preceding);
          const check = validatePatch({
            before: beforeText, after, issueType: issue.type, draftChunk: slice, draftFull: draft, lang, cfg, startsSentence, existingOpeners: openers,
          });
          if (!check.ok) {
            refuse(issue, check.reason, beforeText.slice(0, 160));
            continue;
          }
          const absEnd = chunk.start + local.end;
          const clash = accepted.find((a) => absStart < a.end && absEnd > a.start);
          if (clash) {
            refuse(issue, 'overlaps a replacement already accepted for another issue', beforeText.slice(0, 160));
            continue;
          }
          accepted.push({
            id: issue.id, type: issue.type, severity: issue.severity,
            start: absStart, end: absEnd, before: beforeText, after,
            note: String(p.note || '').trim(), chunk: chunk.index + 1,
          });
          if (startsSentence) {
            const afterOpener = firstWord(after);
            const beforeOpener = firstWord(beforeText);
            if (afterOpener && afterOpener !== beforeOpener) {
              openers[afterOpener] = (openers[afterOpener] || 0) + 1;
              if (beforeOpener && openers[beforeOpener]) {
                openers[beforeOpener] = Math.max(0, openers[beforeOpener] - 1);
              }
            }
          }
        }

        if (round === 0) {
          failed = nextFailed;
          if (failed.length) log(`  ${failed.length} patch(es) rejected; retrying those only`);
        } else {
          for (const f of nextFailed) {
            modelUnresolved.push({ id: f.id, quote: f.quote, reason: `${f.reason} (after retry)` });
          }
        }
      }
    }
  }

  // ── apply patches (back to front) ──────────────────────────────────────────
  accepted.sort((a, b) => a.start - b.start);
  let outputText = humanized;
  const applied = [...accepted].sort((a, b) => b.start - a.start);
  for (const p of applied) {
    outputText = outputText.slice(0, p.start) + p.after + outputText.slice(p.end);
  }

  // Verify every patch landed where expected (cheap integrity check).
  for (const p of applied) {
    if (!outputText.includes(p.after)) {
      errors.push(`patch ${p.id} did not apply cleanly`);
    }
  }

  // ── verification pass ─────────────────────────────────────────────────────
  // Default: audit the repaired text again but do not edit it. A second repair
  // round is opt-in ("repair") because a model that is asked to fix a sentence
  // it has already touched can replace it with a paraphrase of a neighbouring
  // sentence, silently duplicating a claim.
  const verifyMode = cfg.verifyRound === false ? false : (cfg.verifyRound || 'audit');
  let verification = null;
  if (verifyMode && accepted.length > 0) {
    log(`verification pass (${verifyMode}): re-auditing the repaired text`);
    try {
      verification = await runPipeline({
        humanized: outputText,
        draft,
        cfg: { ...cfg, verifyRound: false },
        log: (m) => log(`  [verify] ${m}`),
        auditOnly: verifyMode !== 'repair',
      });
      if (verifyMode === 'repair' && verification.stats.applied > 0) outputText = verification.outputText;
    } catch (e) {
      errors.push(`verification pass: ${e.message}`);
      verification = null;
    }
  }

  let allPatches = [
    ...accepted.map((p) => ({ ...p, round: 1 })),
    ...(verification ? verification.patches.map((p) => ({ ...p, id: `R2-${p.id}`, round: 2 })) : []),
  ];

  // Issues left after repair + the audit-only verification pass.
  let unresolved;
  if (verification) {
    if (verifyMode === 'repair') {
      unresolved = verification.unresolved;
    } else {
      unresolved = verification.issues.map((i) => ({
        id: i.id, type: i.type, severity: i.severity, quote: i.quote, problem: i.problem,
        reason: '驗證輪發現；預設只審查、不自動修改，請人工覆核',
      }));
    }
    errors.push(...verification.errors);
  } else {
    // Issues not covered by a patch. An issue also counts as covered when its
    // whole quoted span sits inside a patch the model applied (models often
    // combine several overlapping issues into one replacement).
    const fixedIds = new Set(accepted.map((p) => p.id));
    for (const i of issues) {
      if (fixedIds.has(i.id)) continue;
      if (i.span && accepted.some((p) => i.span.start >= p.start && i.span.end <= p.end)) {
        fixedIds.add(i.id);
      }
    }
    unresolved = issues
      .filter((i) => !fixedIds.has(i.id))
      .map((i) => ({ id: i.id, type: i.type, severity: i.severity, quote: i.quote, problem: i.problem, reason: modelUnresolved.find((u) => u.id === i.id)?.reason || 'not addressed by the model' }));
  }

  // ── supervision / cleanup loop ────────────────────────────────────────────
  // Every remaining defect is sent to the full model with two choices: a local
  // patch, or a revert to the author's original sentence. Reverts guarantee
  // that a known Humanizer-damaged sentence cannot survive in the final text.
  let cleanupInfo = null;
  if (cfg.cleanup !== false && unresolved.length) {
    const reaudit = async (text) => {
      const r = await runPipeline({
        humanized: text,
        draft,
        cfg: { ...cfg, auditOnly: true, verifyRound: false, cleanup: false, cleanupQuiet: true },
        log: (m) => log(`  [supervise] ${m}`),
        auditOnly: true,
      });
      return r.issues;
    };
    log(`supervision: ${unresolved.length} issue(s) left; attempting repair-or-revert`);
    cleanupInfo = await runCleanup({
      outputText,
      draft: draft || humanized,
      humanized,
      unresolved,
      lang,
      cfg,
      log,
      reaudit,
    });
    outputText = cleanupInfo.outputText;
    allPatches.push(...cleanupInfo.actions);
    unresolved = cleanupInfo.remaining;
    log(`supervision done: ${cleanupInfo.actions.length} action(s), ${cleanupInfo.rewrites} rewrite(s), ${unresolved.length} issue(s) left`);
  }

  const changedWords = diffWords(humanized, outputText, lang);
  const patchStats = {
    totalWords,
    found: issues.length,
    verificationFound: verification ? verification.stats.found : 0,
    applied: allPatches.length,
    rejected: rejected + (verification ? verification.stats.rejected : 0),
    changedWords,
    changedRatio: totalWords ? changedWords / totalWords : 0,
    modelCount,
    machineCount: pre.issues.length,
    cleanupRounds: cleanupInfo ? cleanupInfo.rounds : 0,
    cleanupActions: cleanupInfo ? cleanupInfo.actions.length : 0,
    rewrites: cleanupInfo ? cleanupInfo.actions.filter((a) => a.action === 'rewrite').length : 0,
    hzRewrites: cleanupInfo ? cleanupInfo.actions.filter((a) => a.source === 'hz').length : 0,
    judgePass: cleanupInfo ? cleanupInfo.judge.pass : 0,
    judgeFail: cleanupInfo ? cleanupInfo.judge.fail : 0,
    judgeSkipped: cleanupInfo ? cleanupInfo.judge.skipped : 0,
    forced: cleanupInfo ? cleanupInfo.judge.forced : 0,
  };

  // ── final deterministic gates ─────────────────────────────────────────────
  const final = finalGates({ draft: draft || humanized, humanized, output: outputText, lang, patchStats, cfg });
  const gates = final.gates;
  const metrics = final.metrics;

  const manual = buildManualList({ draft: draft || humanized, output: outputText, lang, gates, context: pre.context });

  log(`done: ${patchStats.applied} patch(es), ${unresolved.length} unresolved, ${((patchStats.changedRatio) * 100).toFixed(1)}% of words touched`);

  return {
    lang, chunks, issues, patches: allPatches, unresolved, outputText, gates,
    deliverable: gates.every((g) => g.ok) && !unresolved.some((u) => u.severity === 'critical'),
    metrics, stats: patchStats, errors, manual,
    cleanup: cleanupInfo ? { rounds: cleanupInfo.rounds, rewrites: cleanupInfo.rewrites } : null,
    elapsedMs: Date.now() - started, context: pre.context,
  };
}

function buildManualList({ draft, output, lang, gates, context }) {
  const manual = [];
  const numOut = factNumbers(output);
  for (const n of context.missingNumbers || []) {
    if (!numOut.includes(n)) manual.push(`Restore the number ${n} from the original draft, or confirm it was intentionally deleted.`);
  }
  const citOut = citationsIn(output);
  for (const c of context.missingCitations || []) {
    if (!citOut.includes(c)) manual.push(`Restore the citation ${c} from the original draft at the claim it supports.`);
  }
  const draftCitCounts = new Map();
  for (const c of citationsIn(draft)) draftCitCounts.set(c, (draftCitCounts.get(c) || 0) + 1);
  const outCitCounts = new Map();
  for (const c of citOut) outCitCounts.set(c, (outCitCounts.get(c) || 0) + 1);
  for (const [c, n] of outCitCounts) {
    const d = draftCitCounts.get(c) || 0;
    if (n > d) manual.push(`Citation ${c} appears ${n} time(s) in B but ${d} time(s) in the draft; remove the duplicate or consolidate the claims.`);
  }
  for (const a of structureAdditions(draft, output)) {
    manual.push(`A ${a.kind} structure still appears ${a.added} time(s) more than in the original. Convert it back to prose.`);
  }
  if (truncation(output, lang)) manual.push('The text still ends mid-sentence. Finish it manually.');
  for (const d of duplicateSentences(output, lang).slice(0, 3)) {
    manual.push(`Possible duplicate: "${d.text.slice(0, 120)}"`);
  }
  for (const g of gates) {
    if (!g.ok) manual.push(`Gate "${g.name}" failed: ${g.detail}`);
  }
  return manual;
}

// ── supervision / cleanup ───────────────────────────────────────────────────
// The last-resort loop: for every defect the repair pass could not fix, the
// supervisor either patches it locally or restores the author's original
// sentence in a human academic voice. If no safe rewrite passes the guards, A is
// kept and the issue is reported; we never restore the AI-sounding draft.

function normalKey(s) {
  return normalizeForMatch(String(s).toLowerCase()).replace(/[^\p{L}\p{N}]/gu, '');
}

// Exact-string matching misses a rewrite that restates a nearby sentence with
// a few changed words. Compare content tokens instead: if most of a short
// sentence is already present in the surrounding text, it is a duplicate.
function nearDuplicate(text, outsideText, lang) {
  const q = tokenSet(text, lang);
  if (q.size < 6) return false;
  for (const s of splitSentences(outsideText, lang)) {
    const t = tokenSet(s.text, lang);
    if (t.size < 6) continue;
    let shared = 0;
    for (const w of q) if (t.has(w)) shared++;
    if (shared / Math.min(q.size, t.size) >= 0.8) return true;
  }
  return false;
}

function sentenceAtSpan(text, span, lang) {
  const sents = splitSentences(text, lang);
  return sents.find((s) => span.start >= s.start && span.end <= s.end)
    || sents.find((s) => span.start < s.end && span.end > s.start)
    || null;
}

function expandToSentences(text, span, lang) {
  const sents = splitSentences(text, lang);
  const hit = sents.filter((s) => s.end > span.start && s.start < span.end);
  if (!hit.length) return null;
  const start = hit[0].start;
  const end = hit[hit.length - 1].end;
  return { start, end, text: text.slice(start, end), count: hit.length };
}

function rewriteRequiredText(draft, target, lang) {
  const parts = [];
  for (const s of splitSentences(target.text, lang)) {
    const best = bestOriginalSentence(draft, s.text, lang, 0.1);
    if (best) parts.push(best.text);
  }
  return parts.join(' ');
}

function bestOriginalSentence(draft, quote, lang, minSim = 0.2) {
  const q = tokenSet(quote, lang);
  if (!q.size) return null;
  let best = null;
  let bestSim = 0;
  for (const s of splitSentences(draft, lang)) {
    const t = s.text.trim();
    if (!t) continue;
    const sim = jaccard(q, tokenSet(t, lang));
    if (sim > bestSim) { bestSim = sim; best = t; }
  }
  return best && bestSim >= minSim ? { text: best, sim: bestSim } : null;
}

function bestOriginalParagraph(draft, quote, lang, minSim = 0.2) {
  const q = tokenSet(quote, lang);
  if (!q.size) return null;
  let best = null;
  let bestSim = 0;
  for (const p of splitParagraphs(draft)) {
    const t = p.text.trim();
    if (!t) continue;
    const sim = jaccard(q, tokenSet(t, lang));
    if (sim > bestSim) { bestSim = sim; best = t; }
  }
  return best && bestSim >= minSim ? { text: best, sim: bestSim } : null;
}

function rewriteConfig(cfg) {
  return {
    ...cfg,
    provider: cfg.rewriteAdapter || cfg.provider,
    baseUrl: cfg.rewriteBaseUrl || cfg.baseUrl,
    model: cfg.rewriteModel || cfg.model,
    apiKey: cfg.rewriteApiKey || cfg.apiKey,
    temperature: cfg.rewriteTemperature ?? cfg.temperature,
    proxyUrl: cfg.rewriteProxyUrl || cfg.proxyUrl || '',
    extraBody: cfg.rewriteExtraBody || cfg.extraBody || undefined,
  };
}

function judgeConfig(cfg) {
  if (cfg.judge === false) return null;
  return {
    ...cfg,
    provider: cfg.judgeAdapter || cfg.provider,
    baseUrl: cfg.judgeBaseUrl || cfg.baseUrl,
    model: cfg.judgeModel || cfg.model,
    apiKey: cfg.judgeApiKey || cfg.apiKey,
    temperature: 0,
    maxOutputTokens: 1200,
    jsonMode: true,
    proxyUrl: cfg.judgeProxyUrl || cfg.proxyUrl || '',
  };
}

async function judgeCandidate({ original, current, candidate, issue, lang, cfg, log, judgeStats, contextCurrent = '', contextOriginal = '' }) {
  const jcfg = judgeConfig(cfg);
  if (!jcfg) {
    if (judgeStats) judgeStats.skipped++;
    return { ok: true, skipped: true, total: null, scores: null };
  }
  try {
    const data = await chatJson(jcfg, {
      system: JUDGE_SYSTEM,
      user: qualityJudgePrompt({
        lang, originalText: original, currentText: current, candidate, issue,
        contextCurrent, contextOriginal,
        minScore: cfg.judgeMinScore ?? 18,
        minDimension: cfg.judgeMinDimension ?? 3,
      }),
      label: `judge ${issue.id}`,
    }, log);
    const keys = ['meaning', 'academic', 'facts', 'naturalness', 'register'];
    const scores = {};
    for (const k of keys) {
      const n = Number(data?.scores?.[k]);
      scores[k] = Number.isFinite(n) ? n : 0;
    }
    const total = keys.reduce((n, k) => n + scores[k], 0);
    const minDim = Math.min(...keys.map((k) => scores[k]));
    const verdict = String(data?.verdict || '').toLowerCase();
    const ok = verdict === 'accept'
      && total >= (cfg.judgeMinScore ?? 18)
      && minDim >= (cfg.judgeMinDimension ?? 3);
    const problems = Array.isArray(data?.problems) ? data.problems.map(String) : [];
    const fix = String(data?.fix || '');
    log(`  judge ${issue.id}: ${verdict} ${total}/25 ${JSON.stringify(scores)}`);
    if (judgeStats) { if (ok) judgeStats.pass++; else judgeStats.fail++; }
    return { ok, total, scores, verdict, problems, fix, skipped: false };
  } catch (e) {
    log(`  judge ${issue.id} failed: ${e.message}`);
    if (cfg.judgeFailOpen) {
      if (judgeStats) judgeStats.skipped++;
      return { ok: true, skipped: true, error: e.message, total: null };
    }
    if (judgeStats) judgeStats.fail++;
    return { ok: false, total: null, skipped: false, error: e.message, problems: [], fix: '' };
  }
}

function paragraphAround(text, target) {
  const paras = splitParagraphs(text);
  return paras.find((p) => target.start >= p.start && target.end <= p.end)?.text || target.text;
}

function findRewriteTarget(text, span, lang, isStructure) {
  if (isStructure) {
    const paras = splitParagraphs(text);
    return paras.find((p) => span.start >= p.start && span.end <= p.end)
      || paras.find((p) => span.start < p.end && span.end > p.start)
      || sentenceAtSpan(text, span, lang);
  }
  const target = expandToSentences(text, span, lang);
  return target && target.count <= 1 ? target : null;
}

function rhythmOk(text, target, after, lang, cfg = {}) {
  const para = splitParagraphs(text).find((p) => target.start >= p.start && target.end <= p.end);
  if (!para) return true;
  const before = sentenceMetrics(para.text, lang);
  if (before.n < 4 || before.cv < 0.25) return true;
  const relStart = target.start - para.start;
  const relEnd = target.end - para.start;
  const afterPar = para.text.slice(0, relStart) + after + para.text.slice(relEnd);
  return sentenceMetrics(afterPar, lang).cv >= before.cv * (cfg.minCvRetention ?? 0.75);
}

function hzCandidate({ text, lang, cfg, rlog, label }) {
  if (!cfg.hzBin) return null;
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-supervise-'));
    const inPath = path.join(dir, 'in.txt');
    const outPath = path.join(dir, 'out.txt');
    fs.writeFileSync(inPath, `${String(text).trim()}
`, 'utf8');
    const args = [inPath, '-o', outPath, '--json'];
    if (lang === 'zh') args.push('--max-chars', '600');
    else args.push('--max-words', '350');
    const r = spawnSync(cfg.hzBin, args, {
      encoding: 'utf8',
      timeout: cfg.hzTimeoutMs ?? 180000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    if (r.error) {
      rlog(`  ${label}: hz error ${r.error.message}`);
      return null;
    }
    if (r.status !== 0) {
      rlog(`  ${label}: hz exited ${r.status}`);
      return null;
    }
    const out = fs.readFileSync(outPath, 'utf8').trim();
    return out || null;
  } catch (e) {
    rlog(`  ${label}: ${e.message}`);
    return null;
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function tryHzRewrite({ issue, text, draft, lang, cfg, rlog, judgeStats }) {
  if (!cfg.hzBin || cfg.hzRetry === false) return null;
  const issueSpan = locateSpan(text, issue.quote, issue.span ? issue.span.start : null);
  if (!issueSpan) return null;
  const isStructure = issue.type === 'structure';
  const allowMulti = isStructure || ['grammar', 'fact', 'citation'].includes(issue.type);
  const target = isStructure
    ? findRewriteTarget(text, issueSpan, lang, true)
    : (allowMulti
      ? expandToSentences(text, issueSpan, lang)
      : findRewriteTarget(text, issueSpan, lang, false));
  if (!target) return null;
  const original = isStructure
    ? bestOriginalParagraph(draft, target.text, lang, 0.1)?.text
    : rewriteRequiredText(draft, target, lang);
  if (!original) return null;

  for (let attempt = 1; attempt <= (cfg.hzRetries ?? 2); attempt++) {
    const cand = hzCandidate({ text: original, lang, cfg, rlog, label: `hz ${issue.id} #${attempt}` });
    if (!cand) continue;
    if (normalKey(cand) === normalKey(original)) {
      rlog(`  hz ${issue.id} attempt ${attempt} rejected (returned the original)`);
      continue;
    }
    const outsideText = text.slice(0, target.start) + ' ' + text.slice(target.end);
    const check = validateRewrite({
      before: target.text, after: cand, draftText: draft, requiredText: original,
      lang, cfg, isParagraph: isStructure, allowMultiSentence: allowMulti, outsideText,
    });
    if (!check.ok) {
      rlog(`  hz ${issue.id} attempt ${attempt} rejected (${check.reason})`);
      continue;
    }
    if (!rhythmOk(text, target, cand, lang, cfg)) {
      rlog(`  hz ${issue.id} attempt ${attempt} rejected (rhythm)`);
      continue;
    }
    const outside = normalKey(text.slice(0, target.start) + ' ' + text.slice(target.end));
    let dup = false;
    for (const s of splitSentences(cand, lang)) {
      const k = normalKey(s.text);
      if (k.length >= (lang === 'zh' ? 10 : 24) && outside.includes(k)) { dup = true; break; }
    }
    if (dup) {
      rlog(`  hz ${issue.id} attempt ${attempt} rejected (duplicate)`);
      continue;
    }
    const judged = await judgeCandidate({
      original, current: target.text, candidate: cand, issue, lang, cfg, log: rlog, judgeStats,
      contextCurrent: paragraphAround(text, target),
      contextOriginal: bestOriginalParagraph(draft, target.text, lang, 0.1)?.text || original,
    });
    if (!judged.ok) {
      rlog(`  hz ${issue.id} attempt ${attempt} rejected by quality judge${judged.total != null ? ` (${judged.total}/25)` : ''}`);
      continue;
    }
    const chunksNow = chunkText(text, cfg.chunkChars ?? 6000);
    const note = `hz 重新生成第 ${attempt} 次（保留原稿事實）${judged.total != null ? ` · judge ${judged.total}/25` : ''}`;
    const patch = {
      id: issue.id, type: 'rewrite', severity: issue.severity,
      start: target.start, end: target.end, before: target.text, after: cand,
      note, judge: judged,
      chunk: chunkIndexAt(chunksNow, target.start) + 1,
      round: 'cleanup', action: 'rewrite', source: 'hz',
    };
    return {
      text: text.slice(0, target.start) + cand + text.slice(target.end),
      patch,
    };
  }
  return null;
}

async function requestCleanupAction({ draft, text, issue, lang, cfg, log, failed = '' }) {
  const prompt = {
    system: CLEANUP_SYSTEM,
    user: cleanupPrompt({ lang, draftText: draft, currentText: text, issue, skill: cfg.skillPrompt || '', failed }),
    label: `cleanup ${issue.id}`,
  };
  const rcfg = rewriteConfig(cfg);
  const different = rcfg.provider !== cfg.provider
    || rcfg.baseUrl !== cfg.baseUrl
    || rcfg.model !== cfg.model
    || rcfg.apiKey !== cfg.apiKey;
  let data;
  if (cfg._rewriteDown) {
    data = await chatJson(cfg, prompt, log);
  } else {
    try {
      data = await chatJson(rcfg, prompt, log);
    } catch (e) {
      log(`  rewrite model failed (${rcfg.provider}/${rcfg.model}: ${e.message})`);
      if (cfg.rewriteFallback === false || !different) {
        log(`  rewrite fallback skipped (fallback=${cfg.rewriteFallback !== false}, different=${different})`);
        throw e;
      }
      log(`  falling back to ${cfg.provider}/${cfg.model}`);
      cfg._rewriteDown = true;
      data = await chatJson(cfg, prompt, log);
    }
  }
  const action = String(data?.action || '').toLowerCase();
  if (!['patch', 'rewrite', 'skip'].includes(action)) return null;
  return {
    action,
    before: String(data?.before || '').trim(),
    after: String(data?.after || '').trim(),
    reason: String(data?.reason || '').trim(),
  };
}

async function applyCleanupAction({ action, issue, text, draft, lang, cfg, rlog, judgeStats, feedback }) {
  const reject = (reason) => {
    if (feedback) feedback.reason = reason;
    return null;
  };
  if (!action) return null;
  if (action.action === 'skip') return null;
  if (!action.before || !action.after) return reject('invalid or incomplete action');
  if (!['patch', 'rewrite'].includes(action.action)) return reject('unknown action');
  const issueSpanNow = locateSpan(text, issue.quote, issue.span ? issue.span.start : null);
  if (!issueSpanNow) return reject('could not locate the quoted defect in the current text');

  const isStructure = issue.type === 'structure';
  // Grammar/fact/citation defects often span two sentences (a fragment plus
  // the clause it belongs to). Those may be rewritten as a short span; style
  // defects stay limited to one sentence so the humanizer's voice survives.
  const allowMulti = isStructure || ['grammar', 'fact', 'citation'].includes(issue.type);

  if (action.action === 'patch' && !(allowMulti && splitSentences(action.before, lang).length > 1)) {
    const span = locateSpan(text, action.before, issueSpanNow.start);
    if (!span) return reject('before not found verbatim in the current text');
    if (span.end <= issueSpanNow.start || span.start >= issueSpanNow.end) return reject('replacement does not overlap the quoted defect');
    const beforeText = text.slice(span.start, span.end);
    const outsideText = text.slice(0, span.start) + ' ' + text.slice(span.end);
    for (const s of splitSentences(action.after, lang)) {
      if (nearDuplicate(s.text, outsideText, lang)) {
        rlog(`  cleanup ${issue.id}: patch rejected (near-duplicate of a neighbouring sentence)`);
        return reject('the replacement nearly duplicates a sentence already in the text');
      }
    }
    const preceding = text.slice(Math.max(0, span.start - 200), span.start).replace(/\s+$/, '');
    const startsSentence = preceding === '' || /[.!?。！？]["'”’)\]]*$/.test(preceding);
    const check = validatePatch({
      before: beforeText, after: action.after, issueType: issue.type,
      draftChunk: draft, draftFull: draft, lang, cfg, startsSentence,
      existingOpeners: countOpeners(text, lang),
    });
    if (!check.ok) {
      rlog(`  cleanup ${issue.id}: patch rejected (${check.reason})`);
      return reject(check.reason);
    }
    const chunksNow = chunkText(text, cfg.chunkChars ?? 6000);
    const patch = {
      id: issue.id, type: issue.type, severity: issue.severity,
      start: span.start, end: span.end, before: beforeText, after: action.after,
      note: action.reason || '監督輪：局部修補', chunk: chunkIndexAt(chunksNow, span.start) + 1,
      round: 'cleanup', action: 'patch',
    };
    return {
      text: text.slice(0, span.start) + action.after + text.slice(span.end),
      patch,
    };
  }

  // rewrite: the full model rewrites the damaged sentence (or whole paragraph
  // for a structure issue) in a human academic voice, guided by the goals.
  if (!isStructure && issue.severity === 'minor') {
    rlog(`  cleanup ${issue.id}: rewrite rejected (minor issues require a patch)`);
    return reject('a minor issue must be fixed with a patch, not a rewrite');
  }
  const beforeSents = splitSentences(action.before, lang).length;
  if (!allowMulti && beforeSents !== 1) {
    rlog(`  cleanup ${issue.id}: rewrite rejected (before must be one sentence)`);
    return reject('before must be exactly one sentence');
  }
  const span = locateSpan(text, action.before, issueSpanNow.start) || issueSpanNow;
  const target = isStructure
    ? findRewriteTarget(text, span, lang, true)
    : (allowMulti
      ? expandToSentences(text, span, lang)
      : findRewriteTarget(text, span, lang, false));
  if (!target) {
    rlog(`  cleanup ${issue.id}: rewrite rejected (no target sentence/paragraph)`);
    return reject('could not identify a single target sentence');
  }

  const requiredText = isStructure
    ? (bestOriginalParagraph(draft, target.text, lang, 0.1)?.text || target.text)
    : rewriteRequiredText(draft, target, lang);

  const outsideText = text.slice(0, target.start) + ' ' + text.slice(target.end);
  const check = validateRewrite({
    before: target.text, after: action.after, draftText: draft, requiredText,
    lang, cfg, isParagraph: isStructure, allowMultiSentence: allowMulti, outsideText,
  });
  if (!check.ok) {
    rlog(`  cleanup ${issue.id}: rewrite rejected (${check.reason})`);
    return reject(check.reason);
  }

  const outside = normalKey(outsideText);
  for (const s of splitSentences(action.after, lang)) {
    const k = normalKey(s.text);
    if (k.length >= (lang === 'zh' ? 10 : 24) && outside.includes(k)) {
      rlog(`  cleanup ${issue.id}: rewrite rejected (duplicates a sentence)`);
      return reject('the replacement duplicates a sentence already in the text');
    }
    if (nearDuplicate(s.text, outsideText, lang)) {
      rlog(`  cleanup ${issue.id}: rewrite rejected (near-duplicate of a neighbouring sentence)`);
      return reject('the replacement nearly duplicates a sentence already in the text');
    }
  }

  if (!rhythmOk(text, target, action.after, lang, cfg)) {
    rlog(`  cleanup ${issue.id}: rewrite rejected (rhythm would flatten)`);
    return reject('the replacement would flatten the sentence rhythm');
  }

  const judged = await judgeCandidate({
    original: requiredText, current: target.text, candidate: action.after, issue, lang, cfg, log: rlog, judgeStats,
    contextCurrent: paragraphAround(text, target),
    contextOriginal: bestOriginalParagraph(draft, target.text, lang, 0.1)?.text || requiredText,
  });
  let forced = false;
  if (!judged.ok) {
    const scores = judged.scores || {};
    const forceOk = cfg.forceFix
      && (issue.severity === 'critical' || issue.severity === 'major')
      && scores.meaning >= 4
      && scores.facts >= 4
      && scores.academic >= 3
      && (judged.total ?? 0) >= (cfg.forceMinScore ?? 16);
    if (!forceOk) {
      rlog(`  cleanup ${issue.id}: rewrite rejected by quality judge${judged.total != null ? ` (${judged.total}/25)` : ''}`);
      const why = judged.problems?.length ? judged.problems.join('; ') : (judged.error || 'quality score too low');
      return reject(`quality judge: ${why}${judged.fix ? ` Fix: ${judged.fix}` : ''}`);
    }
    forced = true;
    if (judgeStats) judgeStats.forced = (judgeStats.forced || 0) + 1;
    rlog(`  cleanup ${issue.id}: FORCED fix (judge ${judged.total}/25; core dimensions passed)`);
  }

  const chunksNow = chunkText(text, cfg.chunkChars ?? 6000);
  const note = `${action.reason || '監督輪：完整 AI 改寫（保留事實）'}${judged.total != null ? ` · judge ${judged.total}/25` : ''}${forced ? ' · 強制修正（核心維度通過）' : ''}`;
  const patch = {
    id: issue.id, type: 'rewrite', severity: issue.severity,
    start: target.start, end: target.end, before: target.text, after: action.after,
    note, judge: judged, forced,
    chunk: chunkIndexAt(chunksNow, target.start) + 1,
    round: 'cleanup', action: 'rewrite',
  };
  return {
    text: text.slice(0, target.start) + action.after + text.slice(target.end),
    patch,
  };
}

async function runCleanup({ outputText, draft, humanized, unresolved, lang, cfg, log, reaudit }) {
  let text = outputText;
  const actions = [];
  let remaining = unresolved;
  let rounds = 0;
  const rlog = cfg.cleanupQuiet ? () => {} : log;
  const canRewrite = !!draft && draft !== humanized;
  const skipHz = new Set();
  const judgeStats = { pass: 0, fail: 0, skipped: 0, forced: 0 };
  // Style/meaning/terminology findings are advisory: rewriting synonyms makes
  // the text drift and flattens the humanizer's rhythm. Automatically repair
  // only objective defects; the rest go to the manual-review list.
  const autoTarget = (i) => ['grammar', 'structure', 'fact', 'citation', 'register'].includes(i.type)
    && !(i.severity === 'minor' && i.type === 'structure');
  const budgetWords = Math.max(40, (cfg.maxEditRatio ?? 0.15) * Math.max(1, wordCount(humanized, lang)));

  for (let round = 1; round <= (cfg.maxCleanupRounds ?? 2); round++) {
    const targets = remaining.filter(autoTarget).slice(0, cfg.maxCleanupActions ?? 8);
    if (!targets.length) {
      rlog('  supervision: no auto-fixable issues left; style/meaning findings go to manual review');
      break;
    }

    const snapshotText = text;
    const actionsBefore = actions.length;
    const remainingBefore = remaining;
    let changed = 0;
    let hzTried = 0;
    let budgetHit = false;
    for (const issue of targets) {
      if (!locateSpan(text, issue.quote)) continue;
      const beforeIssueText = text;
      if (canRewrite && cfg.hzRetry !== false && cfg.hzBin && !skipHz.has(issue.id) && hzTried < (cfg.maxHzIssues ?? 3)) {
        hzTried++;
        rlog(`  hz regenerate ${issue.id} (up to ${cfg.hzRetries ?? 2} tries)`);
        const hzApplied = await tryHzRewrite({ issue, text, draft, lang, cfg, rlog, judgeStats });
        if (hzApplied) {
          text = hzApplied.text;
          actions.push(hzApplied.patch);
          changed++;
          if (diffWords(humanized, text, lang) > budgetWords) {
            text = beforeIssueText;
            actions.pop();
            changed--;
            budgetHit = true;
            rlog(`  edit budget reached (${budgetWords} words); stopping supervision`);
            break;
          }
          continue;
        }
        rlog(`  hz retries failed for ${issue.id}; falling back to API rewrite`);
      }
      const maxApiAttempts = cfg.mode === 'strong' ? Math.max(1, cfg.strongAttempts ?? 3) : 2;
      let action = null;
      try {
        action = await requestCleanupAction({ draft: draft || humanized, text, issue, lang, cfg, log });
      } catch (e) {
        rlog(`  cleanup ${issue.id}: ${e.message}`);
        continue;
      }
      let applied = null;
      for (let attempt = 1; attempt <= maxApiAttempts && action; attempt++) {
        if (action.action === 'rewrite' && !canRewrite) {
          rlog(`  cleanup ${issue.id}: rewrite skipped (no original draft)`);
          break;
        }
        const feedback = { reason: '' };
        applied = await applyCleanupAction({ action, issue, text, draft: draft || humanized, lang, cfg, rlog, judgeStats, feedback });
        if (applied) break;
        if (!feedback.reason) break;
        rlog(`  cleanup ${issue.id}: attempt ${attempt}/${maxApiAttempts} rejected (${feedback.reason.slice(0, 140)})`);
        if (attempt === maxApiAttempts) break;
        try {
          action = await requestCleanupAction({ draft: draft || humanized, text, issue, lang, cfg, log, failed: feedback.reason });
        } catch (e) {
          rlog(`  cleanup ${issue.id} retry failed: ${e.message}`);
          break;
        }
      }
      if (!applied) continue;
      text = applied.text;
      actions.push(applied.patch);
      changed++;
      if (diffWords(humanized, text, lang) > budgetWords) {
        text = beforeIssueText;
        actions.pop();
        changed--;
        budgetHit = true;
        rlog(`  edit budget reached (${budgetWords} words); stopping supervision`);
        break;
      }
    }

    if (!changed) break;
    rounds = round;

    let left = [];
    try {
      left = await reaudit(text);
    } catch (e) {
      rlog(`  supervision re-audit failed: ${e.message}`);
      break;
    }
    rlog(`  supervision round ${round}: ${changed} action(s), ${left.length} issue(s) left`);
    if (budgetHit) {
      remaining = left;
      rlog('  edit budget reached; remaining issues go to manual review');
      break;
    }
    if (left.length >= remaining.length) {
      // A rewrite that the quality judge approved is kept even when the total
      // defect count did not fall: another issue may still be open. Without a
      // judge-approved rewrite, roll the round back so a bad rewrite cannot
      // survive.
      const roundActions = actions.slice(actionsBefore);
      const judgedRewrites = roundActions.filter((a) => a.judge && !a.judge.skipped && a.judge.ok);
      if (judgedRewrites.length) {
        remaining = left;
        rlog(`  no count reduction, but ${judgedRewrites.length} judge-approved rewrite(s) kept`);
        continue;
      }
      const hzActions = roundActions.filter((a) => a.source === 'hz');
      text = snapshotText;
      actions.length = actionsBefore;
      remaining = remainingBefore;
      if (hzActions.length) {
        for (const a of hzActions) skipHz.add(a.id);
        rlog('  no net progress; hz rewrites rolled back; API will retry those issues');
        continue;
      }
      rlog('  supervision round had no net progress; rolled back');
      break;
    }
    remaining = left;
  }

  remaining = remaining.map((i) => ({
    ...i,
    reason: ['grammar', 'structure', 'fact', 'citation', 'register'].includes(i.type)
      ? '監督輪無法安全改寫；已保留 A，請人工覆核'
      : '風格／語意建議，未自動改寫；請人工核對',
  }));
  return {
    outputText: text,
    actions,
    remaining,
    rounds,
    rewrites: actions.filter((a) => a.action === 'rewrite').length,
    hzRewrites: actions.filter((a) => a.source === 'hz').length,
    judge: judgeStats,
  };
}
