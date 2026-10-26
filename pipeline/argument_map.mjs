// argument_map.mjs — 9.0 L2 論證骨架抽取（確定性 v0）。
// 把文章拆成：主張（claim）／證據（evidence）／限制（limitation）／段落角色。
// 處理單位是論證不是句子（ROADMAP 方向1）。純規則、零模型；LLM 輔助抽取
// 之後再加，但骨架工件形狀從今天就固定，供重組約束與版本帳本引用。
import { citationSpans, factNumbers } from '../polish/src/checks.mjs';
import { splitParagraphs, splitSentences, wordCount } from '../polish/src/text.mjs';

const HEDGE_RE = /\b(?:may|might|could|appears?|seems?|suggests?|possibly|perhaps|however|although|while|despite|limitation|caveat|on the other hand)\b/i;
const CLAIM_RE = /\b(?:should|must|need(?:s)? to|argue(?:s|d)?|claim(?:s|ed)?|therefore|thus|it is (?:clear|evident)|essay will|this paper)\b/i;
const CONCLUSION_RE = /\b(?:in conclusion|to conclude|to sum up|in summary|overall)\b/i;

export function buildArgumentMap(text, lang = 'en') {
  const paras = splitParagraphs(text);
  const roles = paras.map((p, i) => {
    if (i === 0) return 'intro';
    if (i === paras.length - 1 || CONCLUSION_RE.test(p.text)) return 'conclusion';
    return 'body';
  });

  const claims = [], evidence = [], limitations = [];
  paras.forEach((p, pi) => {
    for (const s of splitSentences(p.text, lang)) {
      const item = { para: pi, sent: s.text.slice(0, 80), text: s.text };
      if (citationSpans(s.text).length || factNumbers(s.text).length) evidence.push(item);
      if (HEDGE_RE.test(s.text)) limitations.push(item);
      if (CLAIM_RE.test(s.text) || (roles[pi] === 'intro' && wordCount(s.text, lang) >= 12)) claims.push(item);
    }
  });

  // 推論連結：每條證據掛到最近的承載主張的段落（骨架約束用）
  const claimParas = [...new Set(claims.map((c) => c.para))];
  const links = evidence.map((e) => {
    const nearest = claimParas.length
      ? claimParas.reduce((a, b) => (Math.abs(b - e.para) < Math.abs(a - e.para) ? b : a))
      : null;
    return { ...e, supportsClaimAt: nearest };
  });

  return {
    roles,
    claims,
    evidence: links,
    limitations,
    stats: {
      paragraphs: paras.length,
      claims: claims.length,
      evidence: evidence.length,
      limitations: limitations.length,
      // 覆蓋率以 body 段計（intro/conclusion 天然不承載證據）
      evidenceCoverage: (() => {
        const bodyIdx = roles.map((r, i) => (r === 'body' ? i : null)).filter((x) => x != null);
        if (!bodyIdx.length) return 1;
        return bodyIdx.filter((i) => links.some((l) => l.para === i)).length / bodyIdx.length;
      })(),
    },
  };
}

/** 骨架完整性檢查：重組後的正文必須保住骨架的承載物（供 L3/帳本引用）。 */
export function skeletonSurvived(mapBefore, mapAfter) {
  const problems = [];
  const key = (m) => ({
    evidence: m.evidence.length,
    claims: m.claims.length,
    limitations: m.limitations.length,
  });
  const b = key(mapBefore), a = key(mapAfter);
  if (a.evidence < b.evidence * 0.9) problems.push(`證據句 ${b.evidence}→${a.evidence}（>10% 丟失）`);
  if (a.claims < b.claims * 0.9) problems.push(`主張句 ${b.claims}→${a.claims}（>10% 丟失）`);
  if (a.limitations < b.limitations * 0.9) problems.push(`限定/讓步 ${b.limitations}→${a.limitations}（>10% 丟失）`);
  return { ok: problems.length === 0, problems };
}
