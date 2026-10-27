// probe_xtragpt.mjs — 9.1 引擎探針：XtraGPT-7B 句級重生 vs 現行 12B 的天花板。
// 判準（WORKFLOW 出路 #1）：天花板文本（gen 0.91–0.98）句級重生後，
// gen 壓到 0.5–0.7 且 CoLA 傷率不退步 → S4 類解鎖；否則永久排除。
// 用法：node probe_xtragpt.mjs <prose.txt> [limit]
import fs from 'node:fs';
import { splitSentences, wordCount } from '../polish/src/text.mjs';
import { gramScores, scoreTexts, closeDetector } from './detector_client.mjs';

const PROSE = process.argv[2] || 'v6-test/compare-stores/original-full.txt';
const LIMIT = Number(process.argv[3] || 12);
const PORT = Number(process.argv[4] || 8080);
const ENDPOINT = `http://127.0.0.1:${PORT}`;

const INSTR = 'You are an academic writing assistant. Revise the given sentence to improve academic register and sentence variety while preserving ALL facts, numbers, citations, and meaning exactly. Output only the revised sentence.';

async function revise(sentence, temperature) {
  const r = await fetch(`${ENDPOINT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: INSTR },
        { role: 'user', content: `Revise this sentence:\n${sentence}` },
      ],
      temperature,
      max_tokens: 220,
    }),
  });
  const d = await r.json();
  let out = (d.choices?.[0]?.message?.content || '').trim();
  out = out.replace(/^["'「]|["'」]$/g, '').split('\n')[0].trim();
  return out;
}

const text = fs.readFileSync(PROSE, 'utf8');
// 去掉標題行與 References
const bodyStart = text.indexOf('\n\n');
const body = text.slice(bodyStart + 2).split(/\n\s*References\s*\n/i)[0];
const sents = splitSentences(body, 'en')
  .map((s) => s.text.trim())
  .filter((s) => wordCount(s, 'en') >= 12 && wordCount(s, 'en') <= 60)
  .slice(0, LIMIT);

console.log(`探針：${sents.length} 句 × 5 次重生（XtraGPT-7B-q4 @ :${PORT}）`);
const [origGram] = await gramScores(sents);
const [origScore] = await scoreTexts([sents.join(' ')]);
console.log(`原稿整段：gen=${origScore?.p_ai_gen?.toFixed(3)} ppl=${origScore?.perplexity?.toFixed(1)}`);

const rows = [];
for (let i = 0; i < sents.length; i++) {
  const s = sents[i];
  const [gBefore] = await gramScores([s]);
  const attempts = [];
  for (let a = 0; a < 5; a++) {
    try {
      const out = await revise(s, 0.7 + a * 0.08);
      if (!out || wordCount(out, 'en') < 6) continue;
      const [g] = await gramScores([out]);
      const [sc] = await scoreTexts([out]);
      attempts.push({ text: out, cola: g, gen: sc?.p_ai_gen ?? 1 });
    } catch (e) { /* attempt failed */ }
  }
  if (!attempts.length) { rows.push({ i, before: gBefore, best: null }); console.log(`s${i + 1}: 無有效重生`); continue; }
  // 最佳 = CoLA 不降且 gen 最低
  const ok = attempts.filter((a) => a.cola >= Math.min(gBefore, 0.7));
  const best = (ok.length ? ok : attempts).reduce((a, b) => (b.gen < a.gen ? b : a));
  rows.push({ i, before: gBefore, after: best.cola, genBefore: null, genAfter: best.gen, text: best.text });
  console.log(`s${i + 1}: CoLA ${gBefore?.toFixed(2)}→${best.cola?.toFixed(2)} | 句級gen→${best.gen?.toFixed(2)} | ${best.text.slice(0, 60)}…`);
}

const scored = rows.filter((r) => r.best);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const [afterAll] = await scoreTexts([scored.map((r) => r.best.text).join(' ')]);
console.log('\n═══ 判準 ═══');
console.log(`重生句數：${scored.length}/${sents.length}`);
console.log(`重生句 CoLA 均值：${mean(scored.map((r) => r.after)).toFixed(3)}（原句均值 ${mean(rows.map((r) => r.before)).toFixed(3)}）`);
console.log(`重生句拼接後整段 gen：${afterAll?.p_ai_gen?.toFixed(3)}（原稿 ${origScore?.p_ai_gen?.toFixed(3)}）`);
console.log(`判準：拼接 gen 0.5–0.7 且 CoLA 不退 → S4 解鎖；否則排除。`);
fs.writeFileSync(PROSE.replace(/\.txt$/, '') + '.xtragpt-probe.json', JSON.stringify({ rows, afterAll }, null, 1));
await closeDetector();
process.exit(0);
