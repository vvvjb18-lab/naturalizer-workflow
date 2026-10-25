#!/usr/bin/env node
// assault.mjs — 8.9 極端文檔 best-of-N 編排：hz 取樣方差實錘（同文檔四跑
// 0.573/0.649/0.735/0.938，單次 ≤0.65 成功率 ~50%），自助模式需要可預測
// 交付。包裝 v6.mjs 跑 N 次（每次全新取樣），按交付離線 gen 擇優。
// Usage: node assault.mjs <file.docx> [--attempts N] [--threshold 0.65] [v6 flags...]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const file = path.resolve(args[0] || '');
if (!file || !fs.existsSync(file)) { console.error('用法：node assault.mjs <file.docx> [--attempts N] [--threshold 0.65]'); process.exit(1); }
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : dflt; };
const ATTEMPTS = flag('--attempts', 3);
const THRESHOLD = flag('--threshold', 0.65);
const outDir = path.dirname(file);
const base = path.basename(file).replace(/\.[^.]+$/, '');

console.log(`=== 極端文檔 best-of-${ATTEMPTS} 攻堅（目標 gen ≤ ${THRESHOLD}）===`);

const best = { gen: Infinity, report: null, delivery: null, attempt: 0 };
for (let a = 1; a <= ATTEMPTS; a++) {
  const runDir = path.join(outDir, `.assault-${a}`);
  fs.mkdirSync(runDir, { recursive: true });
  console.log(`\n─── attempt ${a}/${ATTEMPTS} ───`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'v6.mjs'), file, '--out-dir', runDir, '--final-name', 'assault-final'], { cwd: import.meta.dirname, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (c) => { buf += c.toString('utf8'); const lines = buf.split('\n'); buf = lines.pop(); for (const l of lines) if (l.trim()) console.log(l); });
    child.stderr.on('data', (c) => process.stderr.write(c));
    child.on('error', () => resolve(1));
    child.on('close', (cc) => resolve(cc ?? 1));
  });
  const reportPath = path.join(runDir, `${base}.v6.report.json`);
  if (!fs.existsSync(reportPath)) { console.log(`attempt ${a}: 管線失敗（exit ${code}），跳過`); continue; }
  let rep;
  try { rep = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { continue; }
  const gen = rep.chosenScore?.p_ai_gen ?? Infinity;
  console.log(`attempt ${a}: 交付 gen ${Number(gen).toFixed(3)}`);
  if (gen < best.gen) {
    best.gen = gen; best.report = rep; best.attempt = a;
    const delivery = rep.files?.aDocx || path.join(runDir, `${base}.v6-A.docx`);
    best.delivery = fs.existsSync(delivery) ? delivery : null;
  }
  if (best.gen <= THRESHOLD) { console.log(`達標（gen ≤ ${THRESHOLD}），停止重試`); break; }
}

console.log(`\n=== 攻堅結果：attempt ${best.attempt} · gen ${best.gen === Infinity ? '—' : Number(best.gen).toFixed(3)} ===`);
if (best.delivery) {
  const finalPath = path.join(outDir, `${base}.assault-final.docx`);
  fs.copyFileSync(best.delivery, finalPath);
  console.log(`最佳交付：${finalPath}`);
  const md = best.report && path.join(outDir, `${base}.assault-final.report.md`);
  const mdSrc = best.report && path.join(outDir, `.assault-${best.attempt}`, `${base}.v6.report.md`);
  if (md && mdSrc && fs.existsSync(mdSrc)) fs.copyFileSync(mdSrc, md);
}
if (best.gen > THRESHOLD) {
  console.log(`⚠ ${ATTEMPTS} 次嘗試均未達 gen ≤ ${THRESHOLD}——建議人工覆核或要求客戶提供草稿種子`);
  process.exit(2);
}
