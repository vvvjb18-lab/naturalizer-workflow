// Text primitives shared by the checks, prompts and pipeline.
// Everything here is deterministic and language-aware (English / Traditional Chinese).

const HAN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
const LATIN_WORD_RE = /[A-Za-z]+(?:['’\-][A-Za-z]+)*/g;

export function hanCount(s) {
  return ((s || '').match(HAN_RE) || []).length;
}

export function latinWordCount(s) {
  return ((s || '').match(LATIN_WORD_RE) || []).length;
}

export function detectLang(text) {
  const han = hanCount(text);
  const latin = latinWordCount(text);
  if (han >= 20 && han > latin) return 'zh';
  if (latin >= 10) return 'en';
  return han > 0 ? 'zh' : 'en';
}

export function isZh(lang) {
  return lang === 'zh';
}

export function wordCount(text, lang) {
  if (isZh(lang)) {
    return hanCount(text) + latinWordCount(text);
  }
  return latinWordCount(text);
}

// ── sentences ────────────────────────────────────────────────────────────────

const ABBR = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'eg', 'ie',
  'al', 'fig', 'figs', 'no', 'nos', 'vol', 'vols', 'pp', 'p', 'ed', 'eds',
  'cf', 'approx', 'ca', 'inc', 'ltd', 'co', 'dept', 'univ', 'ch', 'sec', 'eq',
]);

function isAbbreviation(text, dotIdx) {
  let i = dotIdx - 1;
  while (i >= 0 && /[A-Za-z.]/.test(text[i])) i--;
  const raw = text.slice(i + 1, dotIdx).toLowerCase();
  const token = raw.replace(/\./g, '');
  if (!token) return false;
  if (/^[a-z]$/.test(token)) return true; // single initial
  return ABBR.has(token);
}

function isDecimal(text, dotIdx) {
  return /\d/.test(text[dotIdx - 1] || '') && /\d/.test(text[dotIdx + 1] || '');
}

/** Returns [{ text, start, end }] with absolute offsets into `text`. */
export function splitSentences(text, lang) {
  const out = [];
  if (!text) return out;
  const zh = isZh(lang);
  let start = 0;
  let i = 0;
  const push = (end) => {
    const raw = text.slice(start, end);
    if (raw.trim()) {
      const lead = raw.length - raw.trimStart().length;
      const seg = raw.trim();
      out.push({ text: seg, start: start + lead, end: start + lead + seg.length });
    }
    start = end;
  };
  while (i < text.length) {
    const c = text[i];
    const isTerm = zh ? /[。！？!?]/.test(c) : /[.!?]/.test(c);
    if (!isTerm) { i++; continue; }
    if (!zh && c === '.' && (isDecimal(text, i) || isAbbreviation(text, i))) { i++; continue; }
    let j = i + 1;
    while (j < text.length && /[.!?。！？]/.test(text[j])) j++;
    while (j < text.length && /["'”’)）\]】]/.test(text[j])) j++;
    // Chinese sentences do not require whitespace after the full stop.
    if (!zh && j < text.length && !/\s/.test(text[j])) { i = j; continue; }
    push(j);
    i = j;
  }
  if (start < text.length) push(text.length);
  return out;
}

// ── paragraphs ───────────────────────────────────────────────────────────────

/** Splits on blank lines; falls back to single newlines for CJK documents. */
export function splitParagraphs(text) {
  const out = [];
  const blocks = text.split(/\n\s*\n/);
  let offset = 0;
  for (const block of blocks) {
    const start = text.indexOf(block, offset);
    const seg = block.trim();
    if (seg) {
      const lead = block.length - block.trimStart().length;
      out.push({ text: seg, start: start + lead, end: start + lead + seg.length });
    }
    offset = start + block.length;
  }
  if (out.length <= 1) {
    // One long blob: treat each non-empty line as a paragraph.
    const lines = text.split(/\n/);
    offset = 0;
    out.length = 0;
    for (const line of lines) {
      const start = text.indexOf(line, offset);
      const seg = line.trim();
      if (seg) {
        const lead = line.length - line.trimStart().length;
        out.push({ text: seg, start: start + lead, end: start + lead + seg.length });
      }
      offset = start + line.length;
    }
  }
  return out;
}

// ── approximate phrase matching (used to apply model patches) ────────────────

const CHAR_FOLD = new Map([
  ['\u2018', "'"], ['\u2019', "'"], ['\u201A', "'"], ['\u2032', "'"],
  ['\u201C', '"'], ['\u201D', '"'], ['\u201E', '"'], ['\u2033', '"'],
  ['\u2010', '-'], ['\u2011', '-'], ['\u2012', '-'], ['\u2013', '-'],
  ['\u2014', '-'], ['\u2212', '-'], ['\u00AD', ''],
  ['\u00A0', ' '], ['\u3000', ' '], ['\u200B', ''],
  // Full-width forms are folded for *matching only*; output keeps the original.
  ['（', '('], ['）', ')'], ['，', ','], ['。', '.'], ['：', ':'],
  ['；', ';'], ['！', '!'], ['？', '?'], ['、', ','],
  ['「', '"'], ['」', '"'], ['『', '"'], ['』', '"'],
  ['【', '['], ['】', ']'],
]);

function foldChar(c) {
  return CHAR_FOLD.has(c) ? CHAR_FOLD.get(c) : c;
}

/**
 * Builds a whitespace-collapsed, punctuation-folded copy of `text`, plus an
 * index map back to the original string. A run of whitespace becomes one space.
 */
export function buildFoldMap(text) {
  let folded = '';
  const map = [];
  let lastWasSpace = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) {
      if (!lastWasSpace) { folded += ' '; map.push(i); lastWasSpace = true; }
      continue;
    }
    const f = foldChar(c);
    if (f === '') continue;
    folded += f;
    map.push(i);
    lastWasSpace = false;
  }
  map.push(text.length);
  return { folded, map };
}

export function normalizeForMatch(s) {
  return buildFoldMap(s).folded.trim();
}

/** All occurrences of `needle` in `hay`, tolerant of whitespace and quote style. */
export function findSpans(hay, needle) {
  if (!needle || !hay) return [];
  const exact = [];
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    exact.push({ start: i, end: i + needle.length });
    from = i + Math.max(1, needle.length);
  }
  if (exact.length) return exact;

  const n = normalizeForMatch(needle);
  if (!n) return [];
  const { folded, map } = buildFoldMap(hay);
  const out = [];
  let i = 0;
  for (;;) {
    const j = folded.indexOf(n, i);
    if (j < 0) break;
    out.push({ start: map[j], end: map[j + n.length - 1] + 1 });
    i = j + Math.max(1, n.length);
  }
  return out;
}

/** Picks the match nearest to `hint` (absolute offset), else the only match. */
export function locateSpan(hay, needle, hint = null) {
  const spans = findSpans(hay, needle);
  if (spans.length === 0) return null;
  if (spans.length === 1) return { ...spans[0], ambiguous: false };
  if (hint == null) return { ...spans[0], ambiguous: true, candidates: spans.length };
  let best = spans[0];
  for (const s of spans) {
    if (Math.abs(s.start - hint) < Math.abs(best.start - hint)) best = s;
  }
  return { ...best, ambiguous: true, candidates: spans.length };
}

export function trimToSentence(text, maxWords, lang) {
  const sentences = splitSentences(text, lang);
  if (!sentences.length) return text;
  let out = sentences[0].text;
  for (const s of sentences) {
    out = s.text;
    if (wordCount(out, lang) >= maxWords) break;
  }
  const wc = wordCount(out, lang);
  if (isZh(lang)) return wc > maxWords * 2 ? out.slice(0, maxWords * 2) + '…' : out;
  const tokens = out.split(/\s+/);
  return tokens.length > maxWords ? tokens.slice(0, maxWords).join(' ') + '…' : out;
}

// ── metrics ──────────────────────────────────────────────────────────────────

export function sentenceMetrics(text, lang) {
  const sents = splitSentences(text, lang);
  const lens = sents.map((s) => wordCount(s.text, lang)).filter((n) => n > 0);
  const n = lens.length;
  if (!n) return { n: 0, mean: 0, sd: 0, cv: 0, min: 0, max: 0, shortRatio: 0, longRatio: 0 };
  const mean = lens.reduce((a, b) => a + b, 0) / n;
  const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  const shortMax = isZh(lang) ? 10 : 8;
  const longMin = isZh(lang) ? 60 : 35;
  return {
    n,
    mean: round(mean),
    sd: round(sd),
    cv: mean ? round(sd / mean) : 0,
    min: Math.min(...lens),
    max: Math.max(...lens),
    shortRatio: round(lens.filter((x) => x <= shortMax).length / n),
    longRatio: round(lens.filter((x) => x >= longMin).length / n),
  };
}

export function round(x, digits = 3) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function tokenSet(text, lang) {
  const lower = (text || '').toLowerCase();
  if (isZh(lang)) {
    const han = lower.replace(/[^\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g, '');
    const grams = new Set();
    for (let i = 0; i < han.length - 1; i++) grams.add(han.slice(i, i + 2));
    return grams;
  }
  return new Set(lower.match(/[a-z][a-z'’-]{2,}/g) || []);
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function diffTokens(text, lang) {
  if (isZh(lang)) {
    const out = [];
    for (const m of (text || '').matchAll(/[\u3400-\u4DBF\u4E00-\u9FFF]|[A-Za-z]+|\d+/g)) out.push(m[0].toLowerCase());
    return out;
  }
  return (text || '').toLowerCase().match(/[a-z0-9]+(?:['’\-][a-z0-9]+)*/g) || [];
}

/**
 * Number of word tokens actually different between two versions (LCS based),
 * not the sum of patch lengths. Two rounds of edits on the same sentence are
 * therefore counted once.
 */
export function diffWords(a, b, lang) {
  const A = diffTokens(a, lang);
  const B = diffTokens(b, lang);
  if (!A.length && !B.length) return 0;
  if (A.length * B.length > 40_000_000) {
    const counts = new Map();
    for (const t of A) counts.set(t, (counts.get(t) || 0) + 1);
    let common = 0;
    for (const t of B) {
      const c = counts.get(t) || 0;
      if (c) { counts.set(t, c - 1); common++; }
    }
    return Math.max(A.length, B.length) - common;
  }
  let prev = new Uint32Array(B.length + 1);
  let cur = new Uint32Array(B.length + 1);
  for (let i = 1; i <= A.length; i++) {
    for (let j = 1; j <= B.length; j++) {
      cur[j] = A[i - 1] === B[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const t = prev;
    prev = cur;
    cur = t;
    cur.fill(0);
  }
  return Math.max(A.length, B.length) - prev[B.length];
}

// ── chunking ─────────────────────────────────────────────────────────────────

/**
 * Groups paragraphs into chunks of at most `maxChars` characters. A paragraph
 * longer than the limit is split on sentence boundaries.
 */
export function chunkText(text, maxChars) {
  const paras = splitParagraphs(text);
  const chunks = [];
  let cur = null;
  const pushCur = () => {
    if (!cur) return;
    chunks.push({
      text: text.slice(cur.start, cur.end),
      start: cur.start,
      end: cur.end,
      index: chunks.length,
    });
    cur = null;
  };
  for (const p of paras) {
    if (p.end - p.start > maxChars) {
      pushCur();
      let buf = '';
      let bufStart = p.start;
      for (const s of splitSentences(p.text, detectLang(p.text))) {
        const abs = p.start + s.start;
        const absEnd = p.start + s.end;
        if (buf && absEnd - bufStart > maxChars) {
          chunks.push({ text: text.slice(bufStart, abs), start: bufStart, end: abs, index: chunks.length });
          buf = '';
          bufStart = abs;
        }
        if (!buf) bufStart = abs;
        buf += text.slice(abs, absEnd);
      }
      if (buf.trim()) {
        const end = bufStart + buf.length;
        chunks.push({ text: text.slice(bufStart, end), start: bufStart, end, index: chunks.length });
      }
      continue;
    }
    if (cur && p.end - cur.start > maxChars) pushCur();
    if (!cur) cur = { start: p.start, end: p.end };
    else cur.end = p.end;
  }
  pushCur();
  return chunks.length ? chunks : [{ text, start: 0, end: text.length, index: 0 }];
}
