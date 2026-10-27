// gen_ai_side.mjs — 構造微調配對的 AI 味側：真人段落 H → A(H)（LLM 拋光版）。
// 訓練對 = (A(H), H)：教模型把 LLM 味文本轉成本文類的真人文本。
// 用 DeepSeek（polish/.env 的 key）。用法：node gen_ai_side.mjs [limit]
import fs from 'node:fs';
import path from 'node:path';

const LIMIT = Number(process.argv[2] || 80);
const HERE = import.meta.dirname;
const env = fs.readFileSync(path.join(HERE, '..', '..', 'polish', '.env'), 'utf8');
const KEY = (env.match(/DEEPSEEK_API_KEY=(\S+)/) || [])[1];
if (!KEY) { console.error('no DEEPSEEK_API_KEY'); process.exit(1); }

const units = JSON.parse(fs.readFileSync(path.join(HERE, 'pelic', 'pelic_paragraph_units.json'), 'utf8')).slice(0, LIMIT);
const PROMPT = (h) => `Rewrite the following paragraph to make it polished, well-organized, and formal — the way a capable AI writing assistant would produce it. Fix all grammar issues, improve flow and coherence, use varied academic vocabulary, ensure smooth transitions. Keep the same content and length. Output only the rewritten paragraph.

${h}`;

async function polish(h) {
  const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: PROMPT(h) }],
      temperature: 0.7,
      max_tokens: 600,
    }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 80)}`);
  const d = await r.json();
  return (d.choices?.[0]?.message?.content || '').trim();
}

const outPath = path.join(HERE, 'pairs.jsonl');
const done = new Set();
if (fs.existsSync(outPath)) {
  for (const l of fs.readFileSync(outPath, 'utf8').split('\n')) {
    if (l.trim()) { try { done.add(JSON.parse(l).anon + ':' + JSON.parse(l).para); } catch {} }
  }
}
console.log(`resuming: ${done.size} already done`);

const fh = fs.openSync(outPath, 'a');
let ok = 0, fail = 0;
for (const u of units) {
  const key = u.anon + ':' + u.para;
  if (done.has(key)) continue;
  try {
    const ai = await polish(u.text);
    if (ai.split(/\s+/).length < u.words * 0.5) { fail++; continue; }  // 明顯縮水丟棄
    fs.writeSync(fh, JSON.stringify({ human: u.text, ai, meta: { anon: u.anon, L1: u.L1, level: u.level, words: u.words } }) + '\n');
    ok++;
    process.stdout.write(`\r${ok + done.size}/${units.length}`);
  } catch (e) {
    fail++;
    console.log(`\nfail: ${e.message.slice(0, 60)}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
fs.closeSync(fh);
console.log(`\ndone: +${ok}, fail: ${fail}, total pairs in file: ${done.size + ok}`);
