// diagnostics.mjs — 9.0 L1 診斷器：hugo 特徵引擎的策展子集＋段落級均勻度。
// 職責是「指出問題與證據」，不是把文本推向某個數值剖面（ROADMAP 裁決：
// 特徵有解釋力不等於有預測力，閾值只做警報不做目標）。
import { citationSpans } from '../polish/src/checks.mjs';
import { splitParagraphs, splitSentences, wordCount } from '../polish/src/text.mjs';

const cvOf = (xs) => {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (!mean) return 0;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length) / mean;
};

// 收尾金句偵測（v2.1 91% 的屍檢教訓：每段落點都是精心打造的句子＝指紋）
const APHORISM_RE = /\b(?:lesson|truth|bottom line|pays? itself|pay themselves|teaches|no lecture|stays? close to (?:zero|nothing)|serves the degree|depends on whether|ultimately|not the \w+ but the \w+|which no \w+ teaches|now more than)\b/i;

export function diagnoseText(text, lang = 'en') {
  const paras = splitParagraphs(text);
  const sents = splitSentences(text, lang);
  const words = wordCount(text, lang) || 1;
  const per1k = (n) => (n / words) * 1000;
  const metrics = {};
  const issues = [];

  // ── 段落級均勻度（我方新增：LLM 改寫使段間離散度縮 21–50%，SOURATI-2026）
  const paraLens = paras.map((p) => wordCount(p.text, lang)).filter((n) => n > 0);
  metrics.paragraphCount = paras.length;
  metrics.paragraphLenCv = +cvOf(paraLens).toFixed(3);
  if (paraLens.length >= 4 && metrics.paragraphLenCv < 0.15) {
    issues.push({ id: 'uniformParagraphs', severity: 'medium', evidence: `段長 CV ${metrics.paragraphLenCv}（${paraLens.length} 段）——段落展開深度過於整齊` });
  }

  // ── 段首/段尾模板重複（hugo prose analyzers）
  const openerKey = (p) => p.text.trim().split(/\s+/).slice(0, 3).join(' ').toLowerCase();
  const closerKey = (p) => p.text.trim().split(/\s+/).slice(-2).join(' ').toLowerCase();
  const openers = new Map(), closers = new Map();
  for (const p of paras) {
    if (wordCount(p.text, lang) < 12) continue;
    openers.set(openerKey(p), (openers.get(openerKey(p)) || 0) + 1);
    closers.set(closerKey(p), (closers.get(closerKey(p)) || 0) + 1);
  }
  metrics.repeatedOpeners = [...openers.values()].filter((n) => n >= 3).length;
  metrics.repeatedClosers = [...closers.values()].filter((n) => n >= 3).length;
  if (metrics.repeatedOpeners) issues.push({ id: 'repeatedOpeners', severity: 'medium', evidence: `${metrics.repeatedOpeners} 個段首三詞模板出現 ≥3 次` });
  if (metrics.repeatedClosers) issues.push({ id: 'repeatedClosers', severity: 'low', evidence: `${metrics.repeatedClosers} 個段尾模板出現 ≥3 次` });

  // ── 收尾金句密度
  const aphorisms = [];
  for (const p of paras) {
    if (wordCount(p.text, lang) < 30) continue;
    const ss = splitSentences(p.text, lang);
    const last = ss[ss.length - 1]?.text || '';
    if (APHORISM_RE.test(last) && !citationSpans(last).length && !/\d/.test(last)) aphorisms.push(last.trim().slice(0, 60));
  }
  metrics.aphorismEndings = aphorisms.length;
  if (aphorisms.length >= 2) {
    issues.push({ id: 'aphorismEndings', severity: 'high', evidence: `${aphorisms.length} 個段落以金句收尾（如「${aphorisms[0]}…」）——拋光密度指紋` });
  }

  // ── 連接詞機械接力（hugo rule layer）
  const connectives = (sents.map((s) => (s.text.match(/^\s*(Moreover|Furthermore|Additionally|In addition)\b/i) || [])[1]).filter(Boolean)).length;
  metrics.sentenceInitialConnectives = connectives;
  if (connectives >= 3) issues.push({ id: 'connectiveChains', severity: 'medium', evidence: `${connectives} 個句首 Moreover/Furthermore/Additionally 接力` });

  // ── 三連列舉（AI 基準是人類 3.7 倍，hugo rule layer）
  const triads = (text.match(/\b[\w-]+,\s+[\w-]+,\s+and\s+[\w-]+/gi) || []).length;
  metrics.triadLists = triads;
  if (per1k(triads) > 5) issues.push({ id: 'triadLists', severity: 'medium', evidence: `三連列舉 ${triads} 處（${per1k(triads).toFixed(1)}/千詞 > 5）` });

  // ── 敘述式引用密度（分類器主要正向特徵之一）
  const narrative = (text.match(/\b[A-Z][A-Za-z'-]+(?:\s+et\s+al\.)?\s*\(\d{4}\)\s+(?:argues?|notes?|states?|points out|indicates?|explains?|posits?|suggests?)/g) || []).length;
  metrics.narrativeCitations = narrative;

  // ── 無源量化（hugo semantic chain）
  const unsourced = [];
  for (const s of sents) {
    if (!/\d/.test(s.text)) continue;
    const supported = citationSpans(text).some((c) => c.start >= s.start - 80 && c.start < s.end + 80);
    if (!supported) unsourced.push(s.text.trim().slice(0, 50));
  }
  metrics.unsourcedStats = unsourced.length;
  if (unsourced.length >= 3) {
    issues.push({ id: 'unsourcedStats', severity: 'high', evidence: `${unsourced.length} 個含數字句 80 字內無引用（如「${unsourced[0]}…」）` });
  }

  return { metrics, issues };
}
