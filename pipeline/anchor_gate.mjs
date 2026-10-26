// anchor_gate.mjs — 9.0 課程品質門：交付文本對照真人 A 級錨點（hkuspace），
// 給出 B+ 可交付性判定。三維對應 rubric：Content／Language／Referencing。
// FAIL 項 = rubric C/D 帶風險（必須修）；WARN 項 = 未達 A 級剖面（B+ 可容）。
// 來源：anchors/hkuspace-anchor.json（3 份 A 級真人樣本剖面 + rubric 門檻）。
import fs from 'node:fs';
import path from 'node:path';
import { citationSpans, colloquialHits, registerHits } from '../polish/src/checks.mjs';
import { splitParagraphs, splitSentences, wordCount } from '../polish/src/text.mjs';

const cvOf = (xs) => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return m ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) / m : 0;
};

function loadProfile(anchorPath) {
  const stat = fs.statSync(anchorPath);
  if (stat.isDirectory()) {
    return JSON.parse(fs.readFileSync(path.join(anchorPath, 'hkuspace-anchor.json'), 'utf8'));
  }
  return JSON.parse(fs.readFileSync(anchorPath, 'utf8'));
}

/** 全文（含 References）+ 正文 → 三維 B+ 判定。 */
export function gradeAgainstAnchor({ text, body, profile }) {
  const P = profile.profile, G = profile.bplusGate;
  const paras = splitParagraphs(body);
  const sents = splitSentences(body);
  const words = wordCount(body, 'en') || 1;
  const per1k = (n) => (n / words) * 1000;
  const results = [];
  const add = (dim, verdict, rule, evidence) => results.push({ dim, verdict, rule, evidence });

  // ── Content ────────────────────────────────────────────────────────────
  if (words < G.content.minWords) add('Content', 'FAIL', 'wordCount', `正文 ${words} 詞 < rubric 底線 ${G.content.minWords}（D 帶：under word count）`);
  else if (words < P.words[0]) add('Content', 'WARN', 'wordCount', `正文 ${words} 詞低於 A 級樣本帶 ${P.words[0]}-${P.words[1]}（B+ 可容）`);
  if (paras.length < G.content.minParagraphs) add('Content', 'FAIL', 'paragraphs', `正文僅 ${paras.length} 段 < ${G.content.minParagraphs}（intro+3 body+conclusion）`);
  const last = paras[paras.length - 1]?.text || '';
  if (G.content.rolesComplete && !/\b(?:in conclusion|to conclude|to sum up|in summary)\b/i.test(last) && paras.length >= 3) {
    add('Content', 'WARN', 'conclusion', '結論段無「In conclusion」類標記（A 級錨點均有）');
  }

  // ── Language（正式書面語 = 語域紅線）──────────────────────────────────
  const reg = registerHits(body, 'en');
  const collo = colloquialHits(body, 'en').length;
  if (collo > G.language.maxColloquialDelta) add('Language', 'FAIL', 'colloquial', `口語詞 ${collo} 處（正式書面語不容）`);
  if (reg.secondPerson.length > G.language.maxSecondPerson) add('Language', 'FAIL', 'secondPerson', `第二人稱 ${reg.secondPerson.length} 處`);
  if (reg.contractions.length > G.language.maxContractions) add('Language', 'FAIL', 'contractions', `縮寫 ${reg.contractions.length} 處`);

  // ── Referencing ────────────────────────────────────────────────────────
  const spans = citationSpans(text);
  const perK = per1k(spans.length);
  if (perK < 12) add('Referencing', 'WARN', 'citationDensity', `引用密度 ${perK.toFixed(1)}/千詞 < A 級帶 12-30（B+ 需主要論點有據）`);
  const refList = (text.match(/\b(?:19|20)\d{2}\b/g) || []).length;
  if (refList < G.referencing.minSources) add('Referencing', 'FAIL', 'sourceCount', `年份條目 ${refList} 筆 < ${G.referencing.minSources}（D 帶：fewer than 3 sources）`);
  const narrative = (body.match(/\b[A-Z][A-Za-z'-]+(?:\s+et\s+al\.)?\s*\(\d{4}\)\s+(?:argues?|notes?|states?|points out|indicates?|explains?|suggests?|posits?)/g) || []).length;
  if (narrative < G.referencing.narrativeReportingVerbMin) add('Referencing', 'WARN', 'reportingVerbs', `敘述式引用（報導動詞）僅 ${narrative} 處 < ${G.referencing.narrativeReportingVerbMin}（rubric：reporting verbs 精確度）`);

  // ── 錨點剖面對照（A 級形狀）──────────────────────────────────────────
  const lens = sents.map((s) => wordCount(s.text, 'en'));
  const scv = cvOf(lens);
  const comma = per1k((body.match(/,/g) || []).length);
  if (scv < P.sentenceCv[0]) add('Language', 'WARN', 'sentenceCv', `句長 CV ${scv.toFixed(2)} < A 級帶 ${P.sentenceCv[0]}-${P.sentenceCv[1]}（節奏偏平）`);
  if (comma < P.commaPer1k[0]) add('Language', 'WARN', 'commaDensity', `逗號 ${comma.toFixed(0)}/千詞 < A 級帶 ${P.commaPer1k[0]}-${P.commaPer1k[1]}（A 級生用逗號鏈；壓平逗號是 AI 訊號）`);

  const fails = results.filter((r) => r.verdict === 'FAIL');
  const warns = results.filter((r) => r.verdict === 'WARN');
  return {
    grade: fails.length ? 'BELOW-B+' : 'B+',
    pass: fails.length === 0,
    fails, warns,
    metrics: { words, sentences: sents.length, paragraphs: paras.length, sentenceCv: +scv.toFixed(3), commaPer1k: +comma.toFixed(1), citationsPer1k: +perK.toFixed(1), narrativeCitations: narrative },
  };
}

export function renderAnchorSection(g) {
  const line = (r) => `- ${r.verdict === 'FAIL' ? '✗' : r.verdict === 'WARN' ? '⚠' : '✓'} **${r.dim}/${r.rule}**：${r.evidence}`;
  return `\n## 課程品質門（hkuspace B+）\n\n- 判定：**${g.grade}${g.pass ? '（可交付）' : '（不可交付）'}** — 三維對照 rubric（Content/Language/Referencing）\n${g.fails.map(line).join('\n')}${g.fails.length && g.warns.length ? '\n' : ''}${g.warns.map(line).join('\n')}${!g.fails.length && !g.warns.length ? '- 三維全數達 B+ 並落在 A 級剖面帶內 ✓' : ''}\n- 錨點剖面：詞 ${g.metrics.words} · 句長 CV ${g.metrics.sentenceCv} · 逗號 ${g.metrics.commaPer1k}/k · 引用 ${g.metrics.citationsPer1k}/k\n`;
}
