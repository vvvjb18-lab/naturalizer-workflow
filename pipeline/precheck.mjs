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

// 五點映射（OriginCheck/turnitai 雙渠道校準），分段線性插值
const MAP = [[0.034, 2], [0.573, 0], [0.649, 8], [0.782, 41], [0.983, 98]];
function expectTurnitin(g) {
  if (g == null) return null;
  if (g <= MAP[0][0]) return 2;
  for (let i = 1; i < MAP.length; i++) {
    if (g <= MAP[i][0]) {
      const [x0, y0] = MAP[i - 1], [x1, y1] = MAP[i];
      return Math.max(0, Math.round(y0 + (g - x0) * (y1 - y0) / (x1 - x0)));
    }
  }
  return 98;
}
const nowScore = expectTurnitin(gen);
const afterScore = gen == null ? null : (gen > 0.65 ? 8 : Math.round(expectTurnitin(gen) * 0.5));

let family, plan, runtime, quote;
if (gen == null) { family = '未知'; plan = '—'; runtime = '—'; quote = '—'; }
else if (gen > 0.8) { family = '🔴 極端（純 AI 稿）'; plan = '極速路徑：4 候選＋結構重造＋句級研磨至 ≤0.65＋語域手術'; runtime = '~12-25 分鐘'; quote = '建議極端加成（實測 0.983→0.573→0%）'; }
else if (gen > 0.65) { family = '🟠 攻堅（膝點上方）'; plan = '極速路徑＋延長研磨至 ≤0.65'; runtime = '~15-30 分鐘'; quote = '建議攻堅加成（膝點上方，必須磨過 0.65）'; }
else if (gen > 0.4) { family = '🟡 中度'; plan = '標準管線（4 候選＋研磨）'; runtime = '~15-25 分鐘'; quote = '標準報價'; }
else { family = '🟢 正常（有真人底子）'; plan = '標準管線（6 候選＋研磨）'; runtime = '~10-20 分鐘'; quote = '標準報價'; }

console.log('──────────── 接單預檢卡 ────────────');
console.log(`文件：${path.basename(file)}`);
console.log(`語言：${lang === 'zh' ? '中文' : '英文'} · ${words} 詞 · ${sents.length} 句 · CV ${cv.toFixed(3)}`);
console.log(`離線評分：gen ${gen?.toFixed(3)} · ppl ${ppl?.toFixed(1)} · edit ${sc?.p_ai_edit?.toFixed(3)}`);
console.log(`現狀預期 Turnitin AI：~${nowScore}%（五點映射插值，膝點區誤差大）`);
console.log('');
console.log(`文檔族：${family}`);
console.log(`管線：${plan}`);
console.log(`預計耗時：${runtime}`);
console.log(`交付預期：研磨後 Turnitin AI ~${afterScore}%（校準：0.573→0%、0.649→8%）`);
console.log(`報價建議：${quote}`);
if (lang === 'zh') console.log('⚠ 中文稿：檢測服務的 AI 報告僅支持英文/西班牙文');
if (words < 350) console.log('⚠ 字數 <350：檢測服務不出 AI 報告');
if (words > 30000) console.log('⚠ 字數 >30000：超出檢測服務上限');
console.log('────────────────────────────────────');
await closeDetector();
process.exit(0);
