// probe_ft.mjs — 驗收微調模型：用「訓練時的同一模板」做 completion，再量 gen/ppl/CoLA。
// 判準（預註冊）：天花板文本經改寫後，整份 gen ≤ 0.8 = 強陽性；≤ 0.7 = 顯著。
// 用法：node probe_ft.mjs <prose.txt> [port] [temps]
import fs from 'node:fs';
import { splitSentences, wordCount } from '../polish/src/text.mjs';
import { gramScores, scoreTexts, closeDetector } from './detector_client.mjs';

const PROSE = process.argv[2] || 'v6-test/compare-stores/original-full.txt';
const PORT = Number(process.argv[3] || 8080);
const TEMPS = (process.argv[4] || '0.8,1.0').split(',').map(Number);
const ENDPOINT = `http://127.0.0.1:${PORT}`;

// 必須與 train_qlora.py 的 prompt 完全一致（訓練/推理格式漂移會毀掉 adapter）
const TEMPLATE = 'Rewrite the following paragraph to sound like a genuine university student writing an academic essay — natural, slightly imperfect, with the rhythm and word choices of a real L2 learner. Keep the same content.\n\n';

async function complete(prompt, temperature) {
  const r = await fetch(`${ENDPOINT}/completion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      temperature,
      top_p: 0.95,
      n_predict: 400,
      stop: ['\n###', '\n\nReferences'],
    }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  return String(d.content || '').trim();
}

const raw = fs.readFileSync(PROSE, 'utf8');
const body = raw.split(/\n\s*References\s*\n/i)[0];
const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => wordCount(p, 'en') >= 40);

console.log(`驗收：${paras.length} 段 · port ${PORT} · temps ${TEMPS.join('/')}`);
const [baseScore] = await scoreTexts([paras.join('\n\n')]);
console.log(`原天花板文本：gen=${baseScore?.p_ai_gen?.toFixed(3)} ppl=${baseScore?.perplexity?.toFixed(1)}`);

for (const temp of TEMPS) {
  const outs = [];
  for (const p of paras) {
    try {
      const out = await complete(TEMPLATE + p + '\n\n', temp);
      if (wordCount(out, 'en') < 25) { console.log(`  [p] 略過（輸出過短）`); outs.push(p); continue; }
      outs.push(out);
    } catch (e) { console.log('  [p] 失敗：', e.message.slice(0, 60)); outs.push(p); }
  }
  const joined = outs.join('\n\n');
  const [sc] = await scoreTexts([joined]);
  const sents = splitSentences(joined, 'en').map((s) => s.text);
  const grams = await gramScores(sents.slice(0, 60));
  const damaged = grams.filter((g) => g < 0.5).length;
  console.log(`── temp ${temp}: gen=${sc?.p_ai_gen?.toFixed(3)} ppl=${sc?.perplexity?.toFixed(1)} CoLA傷=${damaged}/${Math.min(sents.length, 60)}`);
  console.log(`   樣本：${outs[0]?.slice(0, 180)}`);
  fs.writeFileSync(PROSE.replace(/\.txt$/, '') + `.ft-t${temp}.txt`, joined + '\n', 'utf8');
}

console.log('\n判準：gen ≤0.8 強陽性 / ≤0.7 顯著 / >0.9 無效');
await closeDetector();
process.exit(0);
