#!/usr/bin/env node
// precheck.mjs — 8.9 接單預檢：離線掃描（~1 分鐘），輸出定價與交付預期卡。
// 依據 23 點校準集與五點映射曲線（gen→Turnitin AI：0.034→0%/3%、0.573→0%、
// 0.649→8%、0.782→41%、0.983→98%，膝點 0.65-0.78 之間極陡）。
// Usage: node precheck.mjs <file.docx|txt>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scoreTexts, closeDetector } from './detector_client.mjs';
import { detectLang, splitSentences, wordCount } from '../polish/src/text.mjs';

// 8.10: canary self-drift check — the offline scorer is local and static, so
// it cannot see Turnitin updates (that needs a code: see canary.json rule),
// but it CAN detect our own drift (model/daemon changes). Run with --canary.
if (process.argv.includes('--canary')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'canary', 'canary.json'), 'utf8'));
  console.log('──── 金絲雀離線自漂移檢查 ────');
  let drift = false;
  for (const c of manifest.canaries) {
    const p = path.join(import.meta.dirname, 'canary', c.file);
    let txt = fs.readFileSync(p, 'utf8');
    if (p.endsWith('.docx')) {
      const out = p + '.precheck.txt';
      const rr = spawnSync('python', [path.join(import.meta.dirname, 'docx_bridge.py'), 'fulltext', p, out], { encoding: 'utf8' });
      if (rr.status !== 0) { console.log(`✗ ${c.file}: docx 解析失敗`); drift = true; continue; }
      txt = fs.readFileSync(out, 'utf8');
    }
    const body = (() => {
      const paras = txt.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
      const outP = [];
      let refs = false;
      for (const pp of paras) {
        if (!refs && /^(references?|works cited|bibliography)\s*:?\s*$/i.test(pp)) { refs = true; continue; }
        if (!refs) outP.push(pp);
      }
      return (outP.length ? outP : paras).join('\n\n');
    })();
    const [s] = await scoreTexts([body]);
    const g = s?.p_ai_gen ?? null;
    const delta = g == null ? null : Math.abs(g - c.offlineGen);
    const bad = delta != null && delta > 0.03;
    if (bad) drift = true;
    console.log(`${bad ? '✗' : '✓'} ${c.file}: 已知 ${c.offlineGen.toFixed(3)} → 現測 ${g?.toFixed(3)}（Δ${delta?.toFixed(3)}）`);
  }
  console.log(drift ? '✗ 本地評分器漂移 >0.03——先排查模型/daemon 變更，再做映射決策' : '✓ 本地評分器無漂移');
  await closeDetector();
  process.exit(drift ? 2 : 0);
}

const file = path.resolve(process.argv[2] || '');
if (!file || !fs.existsSync(file)) { console.error('用法：node precheck.mjs <file.docx|txt>'); process.exit(1); }

const ext = path.extname(file).toLowerCase();
let text;
if (ext === '.docx') {
  const out = path.join(path.dirname(file), `.${path.basename(file)}.precheck.txt`);
  const r = spawnSync('python', [path.join(import.meta.dirname, 'docx_bridge.py'), 'fulltext', file, out], { encoding: 'utf8' });
  if (r.status !== 0) { console.error('docx 解析失敗：' + String(r.stderr).slice(0, 200)); process.exit(1); }
  text = fs.readFileSync(out, 'utf8');
} else {
  text = fs.readFileSync(file, 'utf8');
}

const lang = detectLang(text) === 'zh' ? 'zh' : 'en';
// 校準基準是純正文：References 區塊（及其後）剔除，否則引用列表污染分數
// （第 21 課；映射曲線全部以正文計算）。
const REF_HEAD = /^(references?|reference list|works cited|bibliography|參考文獻|參考資料)\s*:?\s*$/i;
const allParas = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const bodyParas = [];
let inRefs = false;
for (const p of allParas) {
  if (!inRefs && REF_HEAD.test(p)) { inRefs = true; continue; }
  if (!inRefs) bodyParas.push(p);
}
const body = (bodyParas.length ? bodyParas : allParas).join('\n\n');
const words = wordCount(body, lang);
const sents = splitSentences(body, lang);
const lens = sents.map((s) => wordCount(s.text, lang));
const mean = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
const va = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, lens.length);
const cv = mean > 0 ? Math.sqrt(va) / mean : 0;

const [sc] = await scoreTexts([body]);
const gen = sc?.p_ai_gen ?? null;
const ppl = sc?.perplexity ?? null;

// 8.12：雙特徵規則（九點對齊，9/9 吻合）——CV 主導，gen 於中 CV 帶調製
// CV≥0.54 → 全過（至 gen 0.69 實測）；CV 0.38-0.39 → gen≤0.76 過/0.98 敗；CV≤0.28 → 敗
function expectTurnitin(g, cvv) {
  if (g == null) return null;
  if (cvv >= 0.54) return 3;                       // 0-3% 實測帶
  if (cvv >= 0.37) return g <= 0.76 ? 8 : 41;      // 邊界帶：8-41%
  if (cvv >= 0.30) return g <= 0.76 ? 20 : 70;     // 內插保守帶（無實測點）
  return 98;                                        // 實測 98%
}
const nowScore = expectTurnitin(gen, cv);
const afterScore = gen == null ? null : (cv >= 0.5 ? 3 : (cv >= 0.37 ? (gen > 0.76 ? 20 : 8) : 70));

let family, plan, runtime, quote;
if (gen == null) { family = '未知'; plan = '—'; runtime = '—'; quote = '—'; }
else if (cv < 0.37) { family = '🔴 節奏危險（CV 過低，實測 41-98%）'; plan = '結構重造主攻（burstify 至 CV ≥ 0.5）＋句級研磨＋語域手術'; runtime = '~12-30 分鐘'; quote = '建議極端加成'; }
else if (cv < 0.5) { family = '🟠 邊界帶（CV 0.37-0.5：gen 決定）'; plan = '結構重造＋研磨至 CV ≥ 0.5'; runtime = '~12-30 分鐘'; quote = '攻堅加成（gen 越高越難）'; }
else { family = '🟢 節奏安全（CV ≥ 0.5，九點實測全過）'; plan = '標準管線'; runtime = '~10-25 分鐘'; quote = '標準報價'; }

console.log('──────────── 接單預檢卡 ────────────');
console.log(`文件：${path.basename(file)}`);
console.log(`語言：${lang === 'zh' ? '中文' : '英文'} · ${words} 詞 · ${sents.length} 句 · CV ${cv.toFixed(3)}`);
console.log(`離線評分：gen ${gen?.toFixed(3)} · ppl ${ppl?.toFixed(1)} · edit ${sc?.p_ai_edit?.toFixed(3)}`);
console.log(`現狀預期 Turnitin AI：~${nowScore}%（CV ${cv.toFixed(2)}/gen ${gen?.toFixed(2)} 雙特徵規則，九點校準）`);
console.log('');
console.log(`文檔族：${family}`);
console.log(`管線：${plan}`);
console.log(`預計耗時：${runtime}`);
console.log(`交付預期：攻堅後 Turnitin AI ~${afterScore}%（CV 規則：≥0.54 全過；0.37-0.54 看 gen）`);
console.log(`報價建議：${quote}`);
if (lang === 'zh') console.log('⚠ 中文稿：檢測服務的 AI 報告僅支持英文/西班牙文');
if (words < 350) console.log('⚠ 字數 <350：檢測服務不出 AI 報告');
if (words > 30000) console.log('⚠ 字數 >30000：超出檢測服務上限');
console.log('────────────────────────────────────');
await closeDetector();
process.exit(0);
