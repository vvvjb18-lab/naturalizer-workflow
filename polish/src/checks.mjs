// Deterministic checks: facts, citations, structure, register, rhythm.
// These run without a model and are also used to validate every model patch.

import {
  detectLang, isZh, splitSentences, splitParagraphs, wordCount,
  sentenceMetrics, hanCount, latinWordCount, normalizeForMatch, tokenSet, jaccard,
} from './text.mjs';

// ── pattern banks ────────────────────────────────────────────────────────────

export const AI_PHRASES_EN = [
  /delve into/gi,
  /it is important to note/gi,
  /it is worth noting/gi,
  /plays? a (?:crucial|key|significant|vital|pivotal) role/gi,
  /in today'?s (?:rapidly )?(?:evolving|changing|digital|modern) (?:world|landscape|era|society)/gi,
  /multifaceted/gi,
  /underscores? the (?:importance|significance)/gi,
  /navigat(?:e|es|ing) the (?:complexit|challeng)/gi,
  /seamless(?:ly)? (?:integrat|transition|experience)/gi,
  /robust (?:framework|solution|approach)/gi,
  /holistic/gi,
  /paradigm shift/gi,
  /tapestry/gi,
  /(?:a|serves as a) testament to/gi,
  /not only [^.!?]{0,120} but also/gi,
  /in the realm of/gi,
  /(?:pivotal|crucial) (?:role|moment|importance)/gi,
  /shed(?:s|ding)? light on/gi,
  /foster(?:s|ing)? (?:a|an|the) /gi,
  /ever-(?:evolving|changing)/gi,
  /the intersection of/gi,
  /comprehensive understanding/gi,
  /nuanced (?:understanding|perspective|approach)/gi,
];

export const AI_PHRASES_ZH = [
  /在當今[^。！？]{0,20}(?:時代|社會|環境)/g,
  /隨著[^。！？]{0,20}的(?:發展|進步|普及)/g,
  /(?:起著|發揮著|扮演著)(?:至關重要|關鍵|重要)的(?:作用|角色)/g,
  /具有重要(?:意義|價值)/g,
  /綜上所述/g,
  /值得注意的是/g,
  /深入探討/g,
  /(?:賦能|助力)[^。！？]{0,12}/g,
  /(?:多維度|全方位|立體化)/g,
  /不僅[^。！？]{0,30}而且/g,
  /至關重要/g,
  /不可忽視/g,
  /日益凸顯/g,
  /提供(?:了)?有力(?:支撐|保障)/g,
  /注入(?:新)?(?:動能|活力)/g,
  /(?:深刻|深遠)變革/g,
  /持續演進/g,
];

const COLLOQUIAL_EN = [
  /\ba lot of\b/gi, /\blots of\b/gi, /\ba bit\b/gi, /\bkind of\b/gi, /\bsort of\b/gi,
  /\byou know\b/gi, /\bturns out\b/gi, /\bpretty much\b/gi, /\bbasically\b/gi,
  /\bactually\b/gi, /\breally\b/gi, /\bhuge\b/gi, /\bstuff\b/gi,
  /\bthings like that\b/gi, /\band so on\b/gi, /\bnowadays\b/gi, /\ba big deal\b/gi,
  /\bget(?:s|ting)? (?:better|worse|bigger|smaller)\b/gi,
];

const COLLOQUIAL_ZH = [
  /其實/g, /基本上/g, /真的/g, /挺[^。！？]{0,6}/g, /蠻[^。！？]{0,6}/g,
  /超級/g, /東西/g, /一堆/g, /搞(?:得|的)?/g, /弄(?:得|的)?/g,
  /說到底/g, /大家都知道/g, /你看/g, /很多很多/g,
];

const CONTRACTION_RE = /\b(?:can't|won't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|wouldn't|couldn't|shouldn't|it's|that's|there's|they're|we're|you're|I'm|we've|they've|we'll|they'll|we'd|they'd)\b/gi;

const SECOND_PERSON_RE = /\b(?:you|your|yours|yourself)\b/gi;

const HEDGES_EN = /\b(?:may|might|could|appears?|appear to|suggests?|seems?|likely|arguably|potentially|tends? to|indicates?|approximately|roughly|generally|largely|partly|in some cases|is thought to|is believed to)\b/gi;
const HEDGES_ZH = /(?:可能|或許|似乎|顯示|表明|大致|傾向|有望|在一定程度上|通常|往往|據悉|一般認為)/g;

const TERMINAL_RE = /[.!?。！？:："'”’)\]】]$/;

const STOPWORDS = new Set([
  'the', 'and', 'that', 'with', 'from', 'this', 'these', 'those', 'have', 'has',
  'had', 'been', 'being', 'they', 'their', 'there', 'which', 'while', 'when',
  'where', 'what', 'will', 'would', 'could', 'should', 'about', 'into', 'over',
  'under', 'between', 'during', 'after', 'before', 'than', 'then', 'also',
  'only', 'even', 'just', 'very', 'much', 'many', 'each', 'both', 'same', 'own',
  'because', 'although', 'though', 'since', 'until', 'unless', 'more', 'most',
  'such', 'some', 'other', 'can', 'may', 'might', 'must', 'not', 'are', 'was',
  'were', 'for', 'but', 'you', 'your', 'its', 'it', 'is', 'be', 'as', 'at',
  'on', 'in', 'of', 'to', 'or', 'by', 'we', 'our', 'an', 'a',
]);

const CONNECTIVE_WORDS = new Set([
  'however', 'moreover', 'furthermore', 'additionally', 'therefore',
  'consequently', 'thus', 'nevertheless', 'nonetheless', 'overall',
  'meanwhile', 'subsequently', 'hence',
]);

export function firstWord(s) {
  const m = String(s).trim().match(/^[^A-Za-z]*([A-Za-z]+)/);
  return m ? m[1].toLowerCase() : '';
}

/** Counts sentence-initial connectives, to stop the model from stacking them. */
export function countOpeners(text, lang) {
  const counts = Object.create(null);
  if (lang !== 'en') return counts;
  for (const s of splitSentences(text, 'en')) {
    const w = firstWord(s.text);
    if (CONNECTIVE_WORDS.has(w)) counts[w] = (counts[w] || 0) + 1;
  }
  return counts;
}

function countRe(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

function matchesOf(text, res) {
  const list = Array.isArray(res) ? res : [res];
  const out = [];
  for (const re of list) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      out.push({ text: m[0], index: m.index });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return out;
}

export function aiPhraseHits(text, lang) {
  return matchesOf(text, isZh(lang) ? AI_PHRASES_ZH : AI_PHRASES_EN);
}

export function colloquialHits(text, lang) {
  return matchesOf(text, isZh(lang) ? COLLOQUIAL_ZH : COLLOQUIAL_EN);
}

export function registerHits(text, lang) {
  return {
    colloquial: colloquialHits(text, lang),
    contractions: matchesOf(text, CONTRACTION_RE),
    secondPerson: matchesOf(text, SECOND_PERSON_RE),
    questions: splitSentences(text, lang).filter((s) => /[?？]\s*$/.test(s.text)).length,
    hedges: countRe(text, isZh(lang) ? HEDGES_ZH : HEDGES_EN),
  };
}

// ── facts and citations ──────────────────────────────────────────────────────

const NUMBER_RE = /(?<![\w.])[+-]?\d+(?:[.,]\d+)*(?:\s?(?:%|％))?/g;

// Academic drafts often spell numbers out ("three sub-tasks", "six hours")
// while a rewrite may use digits. Treat the two forms as the same fact.
const NUMBER_WORDS = new Map(Object.entries({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
}));
const NUMBER_WORD_RE = new RegExp(`\\b(${[...NUMBER_WORDS.keys()].join('|')})\\b`, 'gi');

export function numbersIn(text) {
  NUMBER_RE.lastIndex = 0;
  return (text.match(NUMBER_RE) || []).map((s) => s.replace(/\s+/g, ''));
}

const CITATION_RES = [
  /\[(\d{1,3}(?:\s*[-,–]\s*\d{1,3})*)\]/g,
  /\([A-Z][A-Za-z'’\-]+(?:\s+(?:et\s+al\.?|&\s*[A-Z][A-Za-z'’\-]+|and\s+[A-Z][A-Za-z'’\-]+))?(?:,\s*|\s+)\d{4}[a-z]?(?:,\s*(?:p|pp)\.?\s*\d+(?:\s*[-–]\s*\d+)?)?\)/g,
  /\([^()]{0,80}\b(?:19|20)\d{2}[a-z]?[^()]{0,40}\)/g,
];

export function citationSpans(text) {
  const found = [];
  for (const re of CITATION_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const rendered = m[1] && /^\d/.test(m[1]) && m[0].startsWith('[') ? `[${m[1]}]` : m[0];
      found.push({ s: rendered, start: m.index, end: m.index + m[0].length });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  found.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept = [];
  for (const x of found) {
    if (!kept.some((k) => x.start < k.end && x.end > k.start)) kept.push(x);
  }
  return kept;
}

export function citationsIn(text) {
  return citationSpans(text).map((x) => x.s);
}

function multiset(list) {
  const m = new Map();
  for (const x of list) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

function multisetDiff(a, b) {
  const ma = multiset(a);
  const mb = multiset(b);
  const missing = [];
  const extra = [];
  for (const [k, v] of ma) {
    const d = v - (mb.get(k) || 0);
    for (let i = 0; i < d; i++) missing.push(k);
  }
  for (const [k, v] of mb) {
    const d = v - (ma.get(k) || 0);
    for (let i = 0; i < d; i++) extra.push(k);
  }
  return { missing, extra };
}

// ── structure ────────────────────────────────────────────────────────────────

const STRUCTURE_RES = {
  parenNumber: /(?:^|[\s，。；：,;:])(?:\(\d{1,2}\)|（\d{1,2}）)/gm,
  // hz sometimes emits inline "1) … 2) … 3) …" enumerations inside one
  // sentence; match the digit only when it starts a word (not "2013)").
  inlineNumber: /(?:^|[\s，。；：,;:])(?:\d{1,2})\)\s/gm,
  lineNumber: /^\s*\d{1,2}[.)、]\s+/gm,
  bullets: /^\s*[-*•·]\s+/gm,
  headings: /^\s*#{1,6}\s+/gm,
  circled: /[①②③④⑤⑥⑦⑧⑨⑩]/g,
  letterList: /(?:^|[\s，。；：,;:])(?:\([a-h]\)|（[a-h]）)/g,
};

export function structureCounts(text) {
  const out = {};
  for (const [k, re] of Object.entries(STRUCTURE_RES)) {
    re.lastIndex = 0;
    out[k] = (text.match(re) || []).length;
  }
  return out;
}

/**
 * Numbers that carry factual content. Numbers inside citations, (1)(2)(3)
 * enumerations and list markers are excluded: they are markers, not data.
 */
export function factNumbers(text) {
  const spans = citationSpans(text).map((s) => ({ start: s.start, end: s.end }));
  for (const kind of ['parenNumber', 'inlineNumber', 'lineNumber', 'circled', 'letterList']) {
    const re = STRUCTURE_RES[kind];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      spans.push({ start: m.index, end: m.index + m[0].length });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  const out = [];
  NUMBER_RE.lastIndex = 0;
  let m;
  while ((m = NUMBER_RE.exec(text))) {
    const at = m.index;
    if (spans.some((s) => at >= s.start && at < s.end)) continue;
    out.push(m[0].replace(/\s+/g, ''));
  }
  NUMBER_WORD_RE.lastIndex = 0;
  while ((m = NUMBER_WORD_RE.exec(text))) {
    const at = m.index;
    if (spans.some((s) => at >= s.start && at < s.end)) continue;
    out.push(String(NUMBER_WORDS.get(m[1].toLowerCase())));
  }
  return out;
}

export function structureAdditions(draft, text) {
  const a = structureCounts(draft);
  const b = structureCounts(text);
  const added = [];
  for (const k of Object.keys(a)) {
    if (b[k] > a[k]) added.push({ kind: k, added: b[k] - a[k] });
  }
  return added;
}

export function structureTotal(text) {
  return Object.values(structureCounts(text)).reduce((x, y) => x + y, 0);
}

// ── document metrics ─────────────────────────────────────────────────────────

export function docMetrics(text, lang) {
  const paras = splitParagraphs(text);
  const sents = splitSentences(text, lang);
  const m = sentenceMetrics(text, lang);
  const reg = registerHits(text, lang);
  return {
    lang,
    words: wordCount(text, lang),
    han: hanCount(text),
    latinWords: latinWordCount(text),
    paragraphs: paras.length,
    sentences: sents.length,
    ...m,
    aiPhrases: aiPhraseHits(text, lang).length,
    colloquial: reg.colloquial.length,
    contractions: reg.contractions.length,
    secondPerson: reg.secondPerson.length,
    questions: reg.questions,
    hedges: reg.hedges,
    structure: structureTotal(text),
    numbers: factNumbers(text).length,
    citations: citationsIn(text).length,
  };
}

export function duplicateSentences(text, lang) {
  const seen = new Map();
  const dupes = [];
  for (const s of splitSentences(text, lang)) {
    const key = normalizeForMatch(s.text.toLowerCase()).replace(/[^\p{L}\p{N}]/gu, '');
    if (key.length < (isZh(lang) ? 10 : 24)) continue;
    if (wordCount(s.text, lang) < 6 && !isZh(lang)) continue;
    if (seen.has(key)) dupes.push({ text: s.text, first: seen.get(key) });
    else seen.set(key, s.text);
  }
  return dupes;
}

export function truncation(text, lang) {
  const sents = splitSentences(text, lang);
  if (!sents.length) return null;
  const last = sents[sents.length - 1].text.trim();
  if (TERMINAL_RE.test(last)) return null;
  if (wordCount(text, lang) < 40) return null;
  return { text: last };
}

export function unbalanced(text) {
  const out = [];
  for (const p of splitParagraphs(text)) {
    const open = (p.text.match(/[（(]/g) || []).length;
    const close = (p.text.match(/[）)]/g) || []).length;
    const dq = (p.text.match(/"/g) || []).length;
    const curly = (p.text.match(/[“”]/g) || []).length;
    if (open !== close || dq % 2 === 1 || curly % 2 === 1) {
      out.push({ text: p.text.slice(0, 160), open, close, dq, curly });
    }
  }
  return out;
}

// ── deterministic audit ──────────────────────────────────────────────────────

let checkId = 0;
function check(issues, obj) {
  issues.push({ id: `C${++checkId}`, source: 'check', ...obj });
}

function firstSentenceWith(text, needle, lang) {
  const sents = splitSentences(text, lang);
  const key = normalizeForMatch(needle);
  for (const s of sents) {
    if (normalizeForMatch(s.text).includes(key)) return s.text;
  }
  return null;
}

function sentenceAt(text, index, lang) {
  for (const s of splitSentences(text, lang)) {
    if (index >= s.start && index < s.end) return s.text;
  }
  return null;
}

function sentenceAround(text, index, lang) {
  const sents = splitSentences(text, lang);
  for (const s of sents) {
    if (index >= s.start && index < s.end) {
      if (s.text.length <= 320) return s.text;
      const cut = s.text.slice(0, 320);
      const sp = cut.lastIndexOf(' ');
      return sp > 200 ? cut.slice(0, sp) : cut;
    }
  }
  return null;
}

function structureQuote(text, kind, lang) {
  const re = STRUCTURE_RES[kind];
  re.lastIndex = 0;
  const m = re.exec(text);
  if (!m) return null;
  return sentenceAround(text, m.index, lang) || m[0].trim();
}

/**
 * Produces machine-confirmed issues plus a `context` object for the model.
 * Facts/citations that disappeared cannot be placed automatically; they are
 * reported in `context` so the audit model can locate them in DRAFT B.
 */
export function auditDeterministic(draft, humanized, lang) {
  const issues = [];
  const context = { missingNumbers: [], extraNumbers: [], missingCitations: [], extraCitations: [], hedgeNote: null };

  if (draft && draft !== humanized) {
    const nd = multisetDiff(factNumbers(draft), factNumbers(humanized));
    context.missingNumbers = nd.missing.slice(0, 30);
    context.extraNumbers = nd.extra.slice(0, 30);

    for (const n of context.extraNumbers.slice(0, 6)) {
      const s = firstSentenceWith(humanized, n, lang);
      if (s) {
        check(issues, {
          type: 'fact', severity: 'critical',
          quote: s, problem: `The number ${n} does not appear in the author's draft; it may have been invented.`,
          fix: `Remove or restore ${n} to the value used in DRAFT A. Do not guess.`,
        });
      }
    }

    const cd = multisetDiff(citationsIn(draft), citationsIn(humanized));
    context.missingCitations = cd.missing.slice(0, 20);
    context.extraCitations = cd.extra.slice(0, 20);

    for (const c of context.extraCitations.slice(0, 6)) {
      const s = firstSentenceWith(humanized, c, lang);
      if (s) {
        check(issues, {
          type: 'citation', severity: 'critical',
          quote: s, problem: `The citation ${c} does not appear in the author's draft and may have been invented.`,
          fix: `Remove ${c} unless DRAFT A supports the same claim with it. Never invent a citation.`,
        });
      }
    }

    const hedgeD = registerHits(draft, lang).hedges;
    const hedgeB = registerHits(humanized, lang).hedges;
    if (hedgeD >= 3 && hedgeB <= Math.max(1, Math.floor(hedgeD * 0.25))) {
      context.hedgeNote = `DRAFT A contains ${hedgeD} hedging expressions (may/might/suggests/可能/似乎…); DRAFT B contains ${hedgeB}. Claim strength may have been inflated. Restore a hedge only where DRAFT A had one and the claim now reads as certain.`;
    }
  }

  const added = structureAdditions(draft || humanized, humanized);
  for (const a of added) {
    const labels = {
      parenNumber: '(1)(2)(3)-style inline numbering',
      inlineNumber: 'inline "1) 2) 3)" numbering',
      lineNumber: 'a numbered list',
      bullets: 'a bullet list',
      headings: 'a Markdown heading',
      circled: 'circled-number numbering',
      letterList: '(a)(b)(c)-style inline lettering',
    };
    check(issues, {
      type: 'structure', severity: 'major',
      quote: structureQuote(humanized, a.kind, lang),
      problem: `DRAFT B adds ${a.added} instance(s) of ${labels[a.kind] || a.kind}; the author's draft had none.`,
      fix: 'Turn the enumeration back into ordinary prose sentences. Keep every item; do not add or drop content.',
      meta: { kind: a.kind },
    });
  }

  const trunc = truncation(humanized, lang);
  if (trunc) {
    check(issues, {
      type: 'structure', severity: 'critical',
      quote: trunc.text,
      problem: 'The document ends mid-sentence (possible truncation).',
      fix: 'Complete the sentence using only information already present in DRAFT A or DRAFT B. Do not invent a conclusion.',
    });
  }

  for (const d of duplicateSentences(humanized, lang).slice(0, 4)) {
    check(issues, {
      type: 'structure', severity: 'major',
      quote: d.text,
      problem: 'This sentence repeats an earlier sentence almost verbatim.',
      fix: 'Delete the duplicate, or rewrite the second occurrence only if it carries new meaning.',
    });
  }

  const coll = colloquialHits(humanized, lang).slice(0, 8);
  for (const c of coll) {
    const s = firstSentenceWith(humanized, c.text, lang);
    if (!s) continue;
    check(issues, {
      type: 'register', severity: 'minor',
      quote: s,
      problem: `Colloquial expression "${c.text}" is out of place in academic prose.`,
      fix: `Replace only "${c.text}" with the plainest standard academic equivalent. Keep the sentence length and everything else unchanged.`,
    });
  }

  // Sentence-initial "But"/"So" is conversational in academic prose. The
  // humanizer adds these often; catch them deterministically so the first
  // repair round sees them instead of leaving them for manual review.
  if (!isZh(lang)) {
    const openerRe = /(?:^|[.!?]["'”’)\]]*\s+)(But|So)(?!\s+(?:far|long|much)\b)/g;
    let om;
    let n = 0;
    while ((om = openerRe.exec(humanized)) && n < 6) {
      const at = om.index + om[0].length - om[1].length;
      const s = sentenceAt(humanized, at, lang);
      if (!s) continue;
      n++;
      check(issues, {
        type: 'register', severity: 'major',
        quote: s,
        problem: `Sentence opens with the conversational "${om[1]}"; academic prose uses a formal connective or a reporting clause.`,
        fix: `Replace the opening with DRAFT A's connective or reporting clause (for example "However" or "These findings indicate that"), keeping the rest of the sentence.`,
      });
    }
  }

  const ai = aiPhraseHits(humanized, lang).slice(0, 5);
  for (const a of ai) {
    const s = firstSentenceWith(humanized, a.text, lang);
    if (!s) continue;
    check(issues, {
      type: 'register', severity: 'minor',
      quote: s,
      problem: `Formulaic phrase "${a.text}" weakens the prose.`,
      fix: `Remove or replace only "${a.text}". Do not restructure the sentence.`,
    });
  }

  return { issues, context, unplaceable: context };
}

// ── patch validation ─────────────────────────────────────────────────────────

const PATCH_TYPES_ALLOWING_RESTORED_FACTS = new Set(['fact', 'citation', 'terminology']);

/**
 * Validates one model patch against the current text.
 * Returns { ok, reason }.
 */
export function validatePatch({ before, after, issueType, draftChunk, draftFull, lang, cfg, startsSentence = false, existingOpeners = null }) {
  if (!before || !after) return { ok: false, reason: 'empty before/after' };
  if (before === after) return { ok: false, reason: 'no-op' };
  if (!after.trim()) return { ok: false, reason: 'empty replacement' };

  const beforeW = wordCount(before, lang);
  const afterW = wordCount(after, lang);
  if (beforeW < 2) return { ok: false, reason: 'before span too short to be safe' };
  if (beforeW > (cfg.maxPatchWords || 120)) return { ok: false, reason: `before span too long (${beforeW} words)` };

  const ratio = afterW / beforeW;
  if (ratio < 0.45 || ratio > 2.2) {
    return { ok: false, reason: `length change out of bounds (${ratio.toFixed(2)}x)` };
  }

  const beforeSents = splitSentences(before, lang).length;
  const afterSents = splitSentences(after, lang).length;
  if (afterSents > beforeSents + 1) {
    return { ok: false, reason: `adds ${afterSents - beforeSents} sentences` };
  }
  if (issueType !== 'structure' && afterSents > beforeSents) {
    return { ok: false, reason: `adds ${afterSents - beforeSents} sentence(s)` };
  }
  // Converting a list back into prose legitimately merges several items into
  // one sentence; every other repair must keep the sentence count. Adding or
  // dropping a sentence can duplicate a claim or leave a pronoun orphaned.
  if (issueType !== 'structure' && afterSents < beforeSents) {
    return { ok: false, reason: `drops ${beforeSents - afterSents} sentence(s)` };
  }
  if (beforeSents > 3 && issueType !== 'structure') {
    return { ok: false, reason: `replacement span covers ${beforeSents} sentences; must be local` };
  }

  // A grammar or cohesion fix must stay recognisably the same sentence. A low
  // content-word overlap means the model rephrased whole clauses instead of
  // repairing the defect. Meaning/terminology fixes may legitimately reword
  // more (they restore a qualifier or a term), so they are limited by the
  // sentence-count and length checks above instead.
  if (['grammar', 'cohesion'].includes(issueType)) {
    const sim = jaccard(tokenSet(before, lang), tokenSet(after, lang));
    if (sim < (cfg.minPatchSimilarity ?? 0.28)) {
      return { ok: false, reason: `replacement rewrites too much (similarity ${sim.toFixed(2)})` };
    }
  }

  const nlBefore = (before.match(/\n/g) || []).length;
  const nlAfter = (after.match(/\n/g) || []).length;
  if (nlAfter > nlBefore) return { ok: false, reason: 'adds a line break / list item' };

  // Capitalisation at the boundary must not drift: a replacement that begins a
  // sentence cannot start lowercase, and one in the middle cannot start
  // uppercase.
  const firstLetter = (s) => {
    const m = String(s).match(/[A-Za-z]/);
    return m ? m[0] : '';
  };
  const afterFirst = firstLetter(after);
  const beforeFirst = firstLetter(before);
  if (startsSentence && afterFirst && /[a-z]/.test(afterFirst)) {
    return { ok: false, reason: 'replacement starts a sentence with a lowercase letter' };
  }
  if (!startsSentence && afterFirst && beforeFirst
    && /[A-Z]/.test(afterFirst) && /[a-z]/.test(beforeFirst)) {
    return { ok: false, reason: 'replacement capitalises a mid-sentence word' };
  }

  // Do not turn two different openings into the same stock transition.
  if (lang === 'en' && startsSentence && existingOpeners) {
    const afterOpener = firstWord(after);
    const beforeOpener = firstWord(before);
    if (CONNECTIVE_WORDS.has(afterOpener) && afterOpener !== beforeOpener
      && (existingOpeners[afterOpener] || 0) >= 1) {
      return { ok: false, reason: `repeats the transition "${afterOpener}" already used in the text` };
    }
  }

  const sBefore = structureCounts(before);
  const sAfter = structureCounts(after);
  for (const k of Object.keys(sBefore)) {
    if (sAfter[k] > sBefore[k]) return { ok: false, reason: `adds structure (${k})` };
  }

  const aiB = aiPhraseHits(before, lang).length;
  const aiA = aiPhraseHits(after, lang).length;
  if (aiA > aiB) return { ok: false, reason: 'introduces a formulaic AI phrase' };

  const secB = (before.match(SECOND_PERSON_RE) || []).length;
  const secA = (after.match(SECOND_PERSON_RE) || []).length;
  if (secA > secB) return { ok: false, reason: 'adds second-person address' };

  const conB = (before.match(CONTRACTION_RE) || []).length;
  const conA = (after.match(CONTRACTION_RE) || []).length;
  if (conA > conB) return { ok: false, reason: 'adds a contraction' };

  const notOnlyB = /not only [^.!?]{0,120} but also/i.test(before);
  const notOnlyA = /not only [^.!?]{0,120} but also/i.test(after);
  if (notOnlyA && !notOnlyB) return { ok: false, reason: 'adds "not only … but also"' };

  // A patch that repeats the same content bigram twice inside one replacement
  // ("productivity gains ... productivity gains") reads as machine stutter.
  if (!isZh(lang)) {
    const bigrams = (s) => {
      const words = (s.toLowerCase().match(/[a-z][a-z'’-]{2,}/g) || []);
      const m = new Map();
      for (let i = 0; i < words.length - 1; i++) {
        const a = words[i];
        const b = words[i + 1];
        if (STOPWORDS.has(a) || STOPWORDS.has(b)) continue;
        const k = `${a} ${b}`;
        m.set(k, (m.get(k) || 0) + 1);
      }
      return m;
    };
    const afterBi = bigrams(after);
    const beforeBi = bigrams(before);
    for (const [bg, n] of afterBi) {
      if (n >= 2 && n > (beforeBi.get(bg) || 0)) {
        return { ok: false, reason: `repeats the phrase "${bg}"` };
      }
    }
  }

  const numB = factNumbers(before);
  const numA = factNumbers(after);
  const draftNums = new Set([...factNumbers(draftChunk || ''), ...factNumbers(draftFull || '')]);
  for (const n of numB) {
    if (!numA.includes(n)) return { ok: false, reason: `drops the number ${n}` };
  }
  for (const n of numA) {
    if (!numB.includes(n) && !(PATCH_TYPES_ALLOWING_RESTORED_FACTS.has(issueType) && draftNums.has(n))) {
      return { ok: false, reason: `introduces the number ${n}` };
    }
  }

  const citB = citationsIn(before);
  const citA = citationsIn(after);
  const draftCits = new Set([...citationsIn(draftChunk || ''), ...citationsIn(draftFull || '')]);
  for (const c of citB) {
    if (!citA.includes(c)) return { ok: false, reason: `drops the citation ${c}` };
  }
  for (const c of citA) {
    if (!citB.includes(c) && !(PATCH_TYPES_ALLOWING_RESTORED_FACTS.has(issueType) && draftCits.has(c))) {
      return { ok: false, reason: `introduces the citation ${c}` };
    }
  }

  return { ok: true, reason: '' };
}

// ── rewrite validation (supervision) ────────────────────────────────────────

/**
 * A rewrite is allowed to change the wording more than a patch, but it must
 * keep the claim, facts, citations, paragraph/list structure and academic
 * register. Required facts come from the best-matching DRAFT sentence.
 */
export function validateRewrite({ before, after, draftText, requiredText, lang, cfg, isParagraph = false, allowMultiSentence = false, outsideText = '' }) {
  if (!before || !after) return { ok: false, reason: 'empty rewrite' };
  if (before.trim() === after.trim()) return { ok: false, reason: 'no-op rewrite' };
  if ((after.match(/\n/g) || []).length > 0) return { ok: false, reason: 'rewrite adds a line break' };

  const sBefore = splitSentences(before, lang).length;
  const sAfter = splitSentences(after, lang).length;
  const maxSents = isParagraph ? Math.max(1, sBefore + 3) : (allowMultiSentence ? Math.max(1, sBefore + 2) : 1);
  if (sAfter < 1 || sAfter > maxSents) {
    return { ok: false, reason: `rewrite changes sentence count (${sBefore} -> ${sAfter})` };
  }

  const ratio = wordCount(after, lang) / Math.max(1, wordCount(before, lang));
  const maxRatio = isParagraph ? 1.6 : 2.5;
  if (ratio < 0.55 || ratio > maxRatio) {
    return { ok: false, reason: `rewrite length ratio ${ratio.toFixed(2)} out of bounds` };
  }

  const sB = structureCounts(before);
  const sA = structureCounts(after);
  for (const k of Object.keys(sB)) {
    if (sA[k] > sB[k]) return { ok: false, reason: `rewrite adds structure (${k})` };
  }

  if (aiPhraseHits(after, lang).length > aiPhraseHits(before, lang).length) {
    return { ok: false, reason: 'rewrite introduces a formulaic AI phrase' };
  }

  const regB = registerHits(before, lang);
  const regA = registerHits(after, lang);
  if (regA.secondPerson > regB.secondPerson) return { ok: false, reason: 'rewrite adds second-person address' };
  if (regA.contractions > regB.contractions) return { ok: false, reason: 'rewrite adds contractions' };

  const required = requiredText || '';
  const reqNums = factNumbers(required);
  const draftNums = new Set(factNumbers(draftText || ''));
  const afterNums = factNumbers(after);
  // A number may already sit in the sentence next to the rewrite target; the
  // document still keeps it, so a local rewrite need not repeat it.
  const outsideNums = factNumbers(outsideText || '');
  for (const n of reqNums) {
    if (!afterNums.includes(n) && !outsideNums.includes(n)) {
      return { ok: false, reason: `rewrite drops the number ${n}` };
    }
  }
  for (const n of afterNums) {
    if (!draftNums.has(n) && !reqNums.includes(n)) return { ok: false, reason: `rewrite introduces the number ${n}` };
  }

  const reqCits = citationsIn(required);
  const draftCits = new Set(citationsIn(draftText || ''));
  const afterCits = citationsIn(after);
  const outsideCits = citationsIn(outsideText || '');
  for (const c of reqCits) {
    if (!afterCits.includes(c) && !outsideCits.includes(c)) {
      return { ok: false, reason: `rewrite drops the citation ${c}` };
    }
  }
  for (const c of afterCits) {
    if (!draftCits.has(c) && !reqCits.includes(c)) return { ok: false, reason: `rewrite introduces the citation ${c}` };
  }

  return { ok: true, reason: '' };
}

// ── final gates ──────────────────────────────────────────────────────────────

export function finalGates({ draft, humanized, output, lang, patchStats, cfg }) {
  const gates = [];
  const push = (name, ok, detail) => gates.push({ name, ok, detail });
  const mh = docMetrics(humanized, lang);
  const mo = docMetrics(output, lang);

  push('language', detectLang(output) === detectLang(humanized), `${detectLang(humanized)} → ${detectLang(output)}`);

  const minCv = (cfg.minCvRetention ?? 0.8) * mh.cv;
  const rhythmJudgeable = mh.n >= 8 && (patchStats.totalWords ?? 0) >= 120;
  push('rhythm', !rhythmJudgeable || mo.cv >= minCv,
    rhythmJudgeable
      ? `sentence-length CV ${mh.cv} → ${mo.cv} (floor ${round2(minCv)})`
      : `too short to judge (${mh.n} sentences, ${patchStats.totalWords ?? 0} words); CV ${mh.cv} → ${mo.cv}`);

  push('ai-phrases', mo.aiPhrases <= mh.aiPhrases, `${mh.aiPhrases} → ${mo.aiPhrases}`);
  push('structure', structureAdditions(draft || humanized, output).length === 0,
    structureAdditions(draft || humanized, output).map((x) => x.kind).join(', ') || 'no new lists/headings');

  const numDiff = multisetDiff(factNumbers(draft || humanized), factNumbers(output));
  push('numbers', numDiff.missing.length === 0,
    numDiff.missing.length ? `${numDiff.missing.length} still missing: ${numDiff.missing.slice(0, 8).join(', ')}` : 'all draft numbers present');

  const citDiff = multisetDiff(citationsIn(draft || humanized), citationsIn(output));
  push('citations', citDiff.missing.length === 0,
    citDiff.missing.length ? `${citDiff.missing.length} still missing: ${citDiff.missing.slice(0, 5).join(', ')}` : 'all draft citations present');

  const budget = Math.max(40, (cfg.maxEditRatio ?? 0.15) * (patchStats.totalWords || 0));
  patchStats.budgetWords = Math.round(budget);
  push('edit-budget', (patchStats.changedWords ?? 0) <= budget,
    `${patchStats.changedWords ?? 0} words replaced (limit ${Math.round(budget)}; ${((patchStats.changedRatio ?? 0) * 100).toFixed(1)}% of text)`);

  push('duplicates', duplicateSentences(output, lang).length <= duplicateSentences(humanized, lang).length,
    `${duplicateSentences(humanized, lang).length} → ${duplicateSentences(output, lang).length}`);

  push('truncation', !truncation(output, lang), truncation(output, lang) ? 'still ends mid-sentence' : 'ends complete');

  push('register', mo.secondPerson <= mh.secondPerson && mo.contractions <= mh.contractions,
    `you/your ${mh.secondPerson}→${mo.secondPerson}, contractions ${mh.contractions}→${mo.contractions}`);

  return { gates, metrics: { before: mh, after: mo } };
}

function round2(x) {
  return Math.round(x * 1000) / 1000;
}

export function countMultiset(text) {
  return multiset(text);
}
