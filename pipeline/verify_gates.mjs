// verify_gates.mjs — 9.0 L3 三環否決制：內容正確性（一票否決）→ 格式結構
// （一票否決）→ 品質維度（只比較、不否決）。取代「單一加權總分」作為
// 接受/回退判據（--arch90 時生效；不加權總分是 ROADMAP 裁決）。
// 語意相似 ≠ 事實正確：NLI entail 只進第三環參考，矛盾進第一環。
import {
  factNumbers, citationsIn, structureAdditions,
  duplicateSentences, truncation, colloquialHits, registerHits, aiPhraseHits,
} from '../polish/src/checks.mjs';
import { splitSentences, wordCount, tokenSet } from '../polish/src/text.mjs';

const HEDGE_RE = /\b(?:may|might|could|appears?|seems?|suggests?|possibly|perhaps|approximate(?:ly)?|roughly|tend(?:s)? to|likely|unlikely)\b/gi;
export const hedgeCount = (text) => (text.match(HEDGE_RE) || []).length;

const multisetDiff = (a, b) => {
  // a 有 b 沒有（丟失）；b 有 a 沒有（新增）
  const mb = new Map();
  for (const x of b) mb.set(x, (mb.get(x) || 0) + 1);
  const lost = [], invented = [];
  const ma = new Map();
  for (const x of a) ma.set(x, (ma.get(x) || 0) + 1);
  for (const [x, n] of ma) if ((mb.get(x) || 0) < n) lost.push(x);
  for (const [x, n] of mb) if ((ma.get(x) || 0) < n) invented.push(x);
  return { lost, invented };
};

// 代名詞 "one" 會被 factNumbers 的詞數字映射成 1（"one of the great things"），
// 在比較前洗掉；量詞用法（one percent / one hundred）保留。
const PRONOUN_ONE = /\b(?<!no\s+)one\b(?!\s*(?:hundred|thousand|million|billion|percent|%))/gi;
const scrubPronounOne = (t) => t.replace(PRONOUN_ONE, ' ');
export { scrubPronounOne };

function containmentRatio(prose, draft, lang) {
  const ds = splitSentences(draft, lang).map((s) => tokenSet(s.text, lang));
  const ps = splitSentences(prose, lang);
  if (!ds.length || !ps.length) return 0;
  let sum = 0;
  for (const s of ps) {
    const t = tokenSet(s.text, lang);
    if (!t.size) continue;
    let best = 0;
    for (const d of ds) {
      let inter = 0;
      for (const w of t) if (d.has(w)) inter++;
      const c = inter / t.size;
      if (c > best) best = c;
    }
    sum += best;
  }
  return sum / ps.length;
}

const acronyms = (text) => new Set((text.match(/\b[A-Z]{2,6}\b/g) || []).filter((w) => !/^(THE|AND|FOR|NOT|BUT|ALL|ANY)$/i.test(w)));

/**
 * 對一份「改寫後全文」做三環評估。draft = 原稿全文（事實基準），prose = 候選全文。
 * nli: { maxContradict, meanEntail } | null（呼叫端已有 NLI 時傳入，省一次模型）。
 */
export function evaluateText({ draft, prose, lang = 'en', nli = null, cvDraft = null, cvProse = null }) {
  const vetoes = [];

  // ── 第一環：內容正確性（一票否決）───────────────────────────────
  const nums = multisetDiff(factNumbers(scrubPronounOne(draft)), factNumbers(scrubPronounOne(prose)));
  if (nums.lost.length) vetoes.push({ ring: 1, rule: 'missingNumbers', detail: `原稿事實數字丟失：${nums.lost.slice(0, 6).join(' ')}` });
  if (nums.invented.length) vetoes.push({ ring: 1, rule: 'inventedNumbers', detail: `出現原稿沒有的數字：${nums.invented.slice(0, 6).join(' ')}` });

  const cits = multisetDiff(citationsIn(draft), citationsIn(prose));
  if (cits.lost.length) vetoes.push({ ring: 1, rule: 'missingCitations', detail: `引用丟失：${cits.lost.slice(0, 3).join(' | ')}` });
  if (cits.invented.length) vetoes.push({ ring: 1, rule: 'inventedCitations', detail: `出現原稿沒有的引用：${cits.invented.slice(0, 3).join(' | ')}` });

  const hdDraft = hedgeCount(draft), hdProse = hedgeCount(prose);
  if (hdDraft >= 2 && hdProse / hdDraft < 0.5) vetoes.push({ ring: 1, rule: 'hedgeLoss', detail: `限定語 ${hdDraft}→${hdProse}（<50%，主張強度被拉高）` });

  const acr = acronyms(draft);
  const acrProse = acronyms(prose);
  const lostAcr = [...acr].filter((w) => !acrProse.has(w));
  if (lostAcr.length) vetoes.push({ ring: 1, rule: 'properNounLoss', detail: `專名/縮寫丟失：${lostAcr.slice(0, 6).join(' ')}` });

  if (nli && Number.isFinite(nli.maxContradict) && nli.maxContradict > 0.5) {
    vetoes.push({ ring: 1, rule: 'nliContradiction', detail: `maxContradict=${nli.maxContradict.toFixed(2)} > 0.5（語義矛盾）` });
  }

  // ── 第二環：格式與結構（一票否決）───────────────────────────────
  const struct = structureAdditions(draft, prose);
  if (struct.length) vetoes.push({ ring: 2, rule: 'structureAdditions', detail: struct.map((s) => `${s.kind} +${s.added}`).join('、') });
  const dupDraft = duplicateSentences(draft, lang).length, dupProse = duplicateSentences(prose, lang).length;
  if (dupProse > dupDraft) vetoes.push({ ring: 2, rule: 'duplicateSentences', detail: `重複句 ${dupDraft}→${dupProse}` });
  const trunc = truncation(prose, lang);
  if (trunc) vetoes.push({ ring: 2, rule: 'truncation', detail: `停在半句：「${trunc.text.slice(0, 40)}…」` });

  // ── 第三環：品質維度（只比較、不否決；進帳本與報告）─────────────
  const containment = containmentRatio(prose, draft, lang);
  const evidence = (text) => {
    const sents = splitSentences(text, lang);
    if (!sents.length) return 0;
    return sents.filter((s) => citationsIn(s.text).length || /\d/.test(s.text)).length / sents.length;
  };
  const evDraft = evidence(draft), evProse = evidence(prose);
  const regDraft = registerHits(draft, lang), regProse = registerHits(prose, lang);
  const informal = (r) => r.colloquial.length + r.contractions.length + r.secondPerson.length;
  const colloquial = colloquialHits(prose, lang).length - colloquialHits(draft, lang).length;
  const register = informal(regProse) - informal(regDraft);
  const aiPhrase = aiPhraseHits(prose, lang).length - aiPhraseHits(draft, lang).length;
  const styleDrift = cvDraft > 0 && cvProse != null ? Math.abs(cvProse - cvDraft) / Math.max(cvDraft, 0.05) : null;

  const dimensions = {
    fidelity: nli && Number.isFinite(nli.meanEntail) ? nli.meanEntail : containment,           // 0–1，越高越忠實
    argumentation: evDraft > 0 ? Math.max(0, 1 - Math.max(0, evDraft - evProse) / evDraft) : null, // 證據密度不倒退
    academic: Math.max(0, 1 - Math.max(0, colloquial + register) * 0.25 - Math.max(0, aiPhrase) * 0.15), // 口語/AI套語不增
    styleConsistency: styleDrift == null ? null : Math.max(0, 1 - styleDrift),                  // 節奏漂移
  };

  return { pass: vetoes.length === 0, vetoes, dimensions };
}

/** 便於 v6 選擇處接入：候選物件（stats/score/nli）+ 原稿 → 評估。 */
export function evaluateCandidate({ c, originalsProse, lang = 'en' }) {
  return evaluateText({
    draft: originalsProse,
    prose: c.prose,
    lang,
    nli: c.nli || null,
    cvDraft: c.cvDraft ?? null,
    cvProse: c.stats?.cv ?? null,
  });
}
