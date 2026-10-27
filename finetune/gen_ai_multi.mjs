// gen_ai_multi.mjs — 全量 AI 味側生成（DeepSeek + Gemini 3.8-flash，curl 統一呼叫）
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const HERE = import.meta.dirname;
const LIMIT = Number(process.argv[2] || 2000);
const UNITS = process.argv[3] || path.join(HERE, 'pelic', 'pelic_units_all.json');
const OUT = process.argv[4] || path.join(HERE, 'pairs_all.jsonl');
const env = fs.readFileSync(path.join(HERE, '..', '..', 'polish', '.env'), 'utf8');
const KEY = (n) => (env.match(new RegExp('^' + n + '=(\\S+)', 'm')) || [])[1];
const DS = KEY('DEEPSEEK_API_KEY');
const GM = KEY('GEMINI_API_KEY');
const PROXY = 'http://127.0.0.1:7897';

const PROMPT = (h) => `Rewrite the following paragraph to make it polished, well-organized, and formal — the way a capable AI writing assistant would produce it. Fix all grammar issues, improve flow and coherence, use varied academic vocabulary, ensure smooth transitions. Keep the same content and length. Output only the rewritten paragraph.

${h}`;

function curl(args) {
  const r = spawnSync('curl', ['-s', '-m', '120', ...args], { encoding: 'utf8', maxBuffer: 16 << 20 });
  if (r.status !== 0) throw new Error('curl exit ' + r.status);
  return r.stdout;
}

async function callDeepseek(h) {
  const body = JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: PROMPT(h) }], temperature: 0.7, max_tokens: 700 });
  const out = curl(['https://api.deepseek.com/v1/chat/completions', '-H', 'Content-Type: application/json', '-H', 'Authorization: Bearer ' + DS, '-d', body]);
  const d = JSON.parse(out);
  if (d.error) throw new Error('deepseek ' + String(d.error.message || '').slice(0, 40));
  return (d.choices?.[0]?.message?.content || '').trim();
}

async function callGemini(h) {
  const body = JSON.stringify({ contents: [{ parts: [{ text: PROMPT(h) }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 700 } });
  const out = curl(['-x', PROXY, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=' + GM, '-H', 'Content-Type: application/json', '-d', body]);
  const d = JSON.parse(out);
  if (d.error) throw new Error('gemini ' + String(d.error.message || '').slice(0, 40));
  return (d.candidates?.[0]?.content?.parts?.map((x) => x.text).join('') || '').trim();
}

const PROVIDERS = [];
if (DS) PROVIDERS.push(['deepseek', callDeepseek]);
if (GM) PROVIDERS.push(['gemini', callGemini]);
if (!PROVIDERS.length) { console.error('no keys (DS/GM empty)'); process.exit(1); }
console.log('providers:', PROVIDERS.map(([n]) => n).join(', '));

const units = JSON.parse(fs.readFileSync(UNITS, 'utf8')).slice(0, LIMIT);
const hash = (s) => createHash('sha1').update(s.trim().toLowerCase()).digest('hex').slice(0, 16);
const done = new Set();
if (fs.existsSync(OUT)) {
  for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { done.add(hash(JSON.parse(l).human)); } catch { /* skip */ }
  }
}
console.log(`target ${units.length}, already ${done.size}`);
const counts = Object.fromEntries(PROVIDERS.map(([n]) => [n, 0]));
const fh = fs.openSync(OUT, 'a');
let ok = 0, fail = 0, skipped = 0, idx = 0;
for (const u of units) {
  if (done.has(hash(u.text))) { skipped++; continue; }
  const [pname, fn] = PROVIDERS[idx++ % PROVIDERS.length];
  try {
    const ai = await fn(u.text);
    if (!ai || ai.split(/\s+/).length < u.words * 0.5) { fail++; continue; }
    fs.writeSync(fh, JSON.stringify({ human: u.text, ai, meta: { anon: u.anon, L1: u.L1, level: u.level, words: u.words, model: pname } }) + '\n');
    done.add(hash(u.text)); counts[pname]++; ok++;
    if (ok % 25 === 0) process.stdout.write(`\r${done.size}/${units.length} `);
  } catch (e) {
    fail++;
    console.log(`\n[${pname}] ${String(e.message).slice(0, 50)}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}
fs.closeSync(fh);
console.log(`\ndone +${ok} skipped ${skipped} fail ${fail} total ${done.size}`);
console.log('by model:', JSON.stringify(counts));
