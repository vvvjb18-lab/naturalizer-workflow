// glm_deai.mjs — 7.4 prototype: pattern-subtraction pass (GLM-5.3-Flash) for
// formal docs where hz alone cannot reach. Subtraction contract only: never
// injects personality (a "humanizer voice" is itself a fingerprint).
// Usage: node glm_deai.mjs <in.prose.txt> <out.prose.txt> [--lang en|zh]
import fs from 'node:fs';

const args = process.argv.slice(2);
const [IN, OUT] = args;
const lang = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : 'en';

const env = fs.readFileSync(new URL('../polish/.env', import.meta.url), 'utf8');
const key = env.match(/ZHIPU_API_KEY=(\S+)/)[1];

const CONTRACT_EN = `You are a copyeditor removing machine-generated writing patterns from a student assignment. Rewrite the paragraph under these rules:

1. PRESERVE exactly: every fact, number, percentage, citation, name, claim, and the paragraph's meaning and order. Do not add, invent, or drop anything.
2. REMOVE AI-typical wording: "delve", "leverage", "harness", "robust", "furthermore", "moreover", "additionally", "in conclusion", "it is important to note", "plays a significant role", "in today's world", "overall", "not only ... but also".
3. Break uniform sentence rhythm: let some sentences run short (6-12 words) and others long, the way a real student's draft does. Do NOT chop sentences into fragments. Do NOT add em-dashes, asides, exclamations, or fake personality.
4. Target register: a competent 17-year-old student's school report — clear, direct, slightly plain. Prefer simple main verbs over nominalised phrases ("carry out an analysis of" → "analyse"). Moderate contractions are fine. No slang, no exclamation. Vary paragraph openings. Dissolve "rule of three" lists into natural prose only when the meaning allows.
5. Subtraction and re-rhythm only. If a sentence has no AI pattern, keep it as is.

Output ONLY the rewritten paragraph, no commentary.`;

const CONTRACT_ZH = `你是校對編輯，負責消除學生功課中的機器生成痕跡。按以下規則改寫段落：

1. 完整保留：所有事實、數字、百分比、引用、人名、主張、段落順序與含義。不得增刪。
2. 移除 AI 常用詞：「隨著…的不斷提升」、「值得注意的是」、「綜上所述」、「總而言之」、「扮演重要角色」、「此外」、「與此同時」、「不僅…更」。
3. 打破均勻句長：短句（10-18 字）與長句自然交錯，像真學生的草稿。不得把句子切碎、不得加入破折號或假性情緒。
4. 維持原來的書面語語域。段首開頭方式要多變。
5. 只做減法與節奏調整；沒有 AI 痕跡的句子原樣保留。

只輸出改寫後的段落，不加說明。`;

const CONTRACT = lang === 'zh' ? CONTRACT_ZH : CONTRACT_EN;

async function glm(user) {
  const r = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: user }],
      temperature: 0.8,
      thinking: { type: 'enabled', level: 'low' },
    }),
  });
  if (!r.ok) throw new Error(`GLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || '').trim();
}

const text = fs.readFileSync(IN, 'utf8');
const paras = text.split(/\n\s*\n/).filter((p) => p.trim());
const out = [];
for (let i = 0; i < paras.length; i++) {
  const p = paras[i];
  if (p.split(/\s+/).length < 25 && lang === 'en') { out.push(p); continue; } // headings/short lines stay
  try {
    const r = await glm(`${CONTRACT}\n\nParagraph:\n${p}`);
    out.push(r || p);
    console.log(`p${i + 1}: ${(r || p).split(/\s+/).length}w ${r ? 'rewritten' : 'KEPT'}`);
  } catch (e) {
    console.error(`p${i + 1} FAILED: ${e.message}`);
    out.push(p);
  }
}
fs.writeFileSync(OUT, out.join('\n\n') + '\n', 'utf8');
console.log('-> ' + OUT);
