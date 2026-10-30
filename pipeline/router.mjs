// router.mjs — 9.0 L0 路由層：原稿五狀態分診（S1–S5）。
// 不同起點不接受相同改動。確定性訊號優先，gen 由呼叫端提供（可為 null）。
// S5 > S4 > S3 > S1 > S2。S4/S5 是停改令，不是處理建議。
import { citationSpans, colloquialHits, registerHits } from '../polish/src/checks.mjs';
import { splitParagraphs, splitSentences, wordCount, tokenSet } from '../polish/src/text.mjs';

export const ROUTE_EXIT = { S4: 3, S5: 4 };

function referencesPresent(text) {
  return splitParagraphs(text).some((p) => /^(references?|works cited|bibliography|參考文獻)\s*:?$/i.test(p.text.trim()));
}

/** hugo 啟發：統計句 80 字內無引用支撐的比例（無源量化）。 */
export function unsourcedStatRatio(text, lang = 'en') {
  const sents = splitSentences(text, lang);
  const spans = citationSpans(text);
  let stat = 0, unsourced = 0;
  for (const s of sents) {
    if (!/\d/.test(s.text)) continue;
    stat++;
    const supported = spans.some((c) => c.start >= s.start - 80 && c.start < s.end + 80);
    if (!supported) unsourced++;
  }
  return stat >= 3 ? unsourced / stat : 0;
}

function repetitionPairs(text, lang = 'en') {
  const paras = splitParagraphs(text).map((p) => tokenSet(p.text));
  let pairs = 0;
  for (let i = 1; i < paras.length; i++) {
    const a = paras[i - 1], b = paras[i];
    if (!a.size || !b.size) continue;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    const jac = inter / (a.size + b.size - inter);
    if (jac >= 0.35) pairs++;
  }
  return pairs;
}

/** 自動分診主鏈（無覆蓋）。 */
function classifyAuto({ text, gen = null, cv = null, lang = 'en' }) {
  const signals = {
    citations: citationSpans(text).length,
    refsPresent: referencesPresent(text),
    unsourcedRatio: unsourcedStatRatio(text, lang),
    firstPersonPer1k: (() => {
      const w = wordCount(text, lang) || 1;
      return ((text.match(/\b(?:I|my|me|we|our|us|myself)\b/g) || []).length / w) * 1000;
    })(),
    repetitionPairs: repetitionPairs(text, lang),
    informal: colloquialHits(text, lang).length,
    gen, cv,
  };

  // S5：引用無法核實——有內文引用卻沒有文獻表，或（人文類稿）統計句多數無源。
  // 純 AI 無引用稿不走 S5——那是 S4（作者補分析與來源）的問題。
  const humanish = signals.citations > 0 || gen == null || gen < 0.5;
  if ((signals.citations > 0 && !signals.refsPresent) || (signals.unsourcedRatio > 0.6 && humanish)) {
    return { state: 'S5', signals, advice: '引用／來源無法核實（缺 References 或統計句多數無源）：先核實來源，本次不改稿。', exitCode: ROUTE_EXIT.S5 };
  }
  // S4：純 AI 且缺作者分析——引擎天花板類，管線不做靜默代工。
  if (gen != null && gen >= 0.65 && signals.firstPersonPer1k < 1 && signals.citations === 0) {
    return { state: 'S4', signals, advice: '原稿為大量 AI 生成且缺作者自己的分析（gen≥0.65、無第一人稱、無引用）：需要作者補充理解、觀點與證據後再處理。', exitCode: ROUTE_EXIT.S4 };
  }
  // S3：內容重複／論證薄弱——先重組論證（確定性去重前置＋交付時段級重組），再語言處理。
  if (signals.repetitionPairs >= 2) {
    return { state: 'S3', signals, advice: '相鄰段落高度重複：先去重再處理（S3 前置去重＋交付時論證重組），語言處理其後。' };
  }
  // S1：論證完整＋語言可信——保守編輯。
  if (gen != null && gen <= 0.40 && signals.informal === 0 && (cv == null || cv >= 0.4)) {
    return { state: 'S1', signals, advice: '原稿已有完整論證且語言可信：僅做保守編輯（機械標點＋LT＋檢查），不進候選生成。' };
  }
  return { state: 'S2', signals, advice: '標準路線：候選生成→手術→重組→研磨→驗證。' };
}

/** 狀態分診（對外入口）。routeOverride：--route S1..S5 顯式覆蓋。
 *  校準 #30：tmr 對新強模型近乎盲（GPT 6.1 稿 gen 0.315 穿過 S1 門 0.40，
 *  把 78% AI 稿判成保守編輯）——需要人工出口；signals 與自動分診結果照記帳本。 */
export function classifyDraft(opts) {
  const auto = classifyAuto(opts);
  const ov = opts?.routeOverride;
  if (ov && /^[Ss][1-5]$/.test(String(ov))) {
    const st = String(ov).toUpperCase();
    return { ...auto, state: st, override: true, advice: `人工覆蓋路由 --route ${st}（自動分診 ${auto.state}）：${auto.advice}` };
  }
  return auto;
}
