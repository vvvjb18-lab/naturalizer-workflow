#!/usr/bin/env node
// One-command pipeline: original draft → hz (Humanizer CLI) → academic polish → report.
//
//   node pipeline.mjs draft.txt
//   node pipeline.mjs draft.txt --verify audit --lang en
//   node pipeline.mjs draft.txt --humanized existing-hz-output.txt   (skip hz)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLISH = path.resolve(HERE, '..', 'polish', 'polish.mjs');

const HELP = `Humanizer + 學術修補，一條命令跑完

用法：
  node pipeline.mjs <原稿.txt|md|docx> [選項]

它會：
  1. 呼叫 hz（官方 Humanizer CLI）改寫原稿 → <name>.humanized.txt / .docx
  2. 呼叫 polish.mjs 做學術性修補（以原稿為事實基準）→ <name>.final.txt / .docx
  3. 產生 <name>.final.report.md / .json，並保留 hz 的統計 .humanized.json

  .docx：只修補 hz 實際改寫的散文段落，再用 python-docx 寫回 A.docx；
         標題、表格、References、含圖片／超連結的段落保持原樣。

選項：
  --out-dir <dir>        輸出資料夾（預設與原稿同目錄）
  --humanized <file>     已有 Humanizer 輸出，跳過 hz
  --hz-bin <path>        hz 執行檔（預設自動找 PATH 或 ~/.local/bin/hz）
  --hz-arg <arg>         額外傳給 hz 的參數，可重複（例如 --hz-arg=--max-words --hz-arg=250）
  --dry-run              只顯示會執行的命令
  --help                 顯示本說明

其餘選項會原樣傳給 polish.mjs，例如：
  --verify audit|repair|off   --lang auto|en|zh
  --provider deepseek|openai|gemini|...   --model ...   --api-key ...
  --audit-only   --quiet   --chunk-chars 6000   --max-edit-ratio 0.15

注意：--out / --report / --json / --draft 由管線自己決定，不要傳。

前置：
  - hz：uv tool install "git+https://github.com/sgaofen/humanizer-local-model"
  - Humanizer App 開著（hz 會自動找；關著也會嘗試啟動）
  - .docx：python-docx 已裝在 hz 的 uv tool venv（本機已裝）
  - polish/.env 或 polish/polish.config.json 內有 API key

輸出（A/B 都可直接拿去跑 Turnitin）：
  <name>.humanized.txt        A：Humanizer 原始輸出
  <name>.final.txt            B：學術修補後
  <name>.final.report.md      中文報告
  <name>.final.report.json    結構化結果
  <name>.humanized.json       hz 的逐段統計
`;

const PIPELINE_VALUE_FLAGS = new Set(['out-dir', 'humanized', 'hz-bin', 'hz-arg']);
const PIPELINE_FLAGS = new Set(['dry-run', 'help']);
const PIPELINE_RESERVED = new Set(['out', 'report', 'json', 'in', 'draft']);
const POLISH_NO_VALUE = new Set(['audit-only', 'quiet', 'no-json', 'help']);

function parseArgs(argv) {
  const out = { _: [], hzArgs: [], polish: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2).split('=')[0];
    if (PIPELINE_FLAGS.has(key)) { out[key] = true; continue; }
    if (PIPELINE_VALUE_FLAGS.has(key)) {
      const val = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      if (val == null) throw new Error(`--${key} 需要一個值`);
      if (key === 'hz-arg') out.hzArgs.push(val);
      else out[key] = val;
      continue;
    }
    if (PIPELINE_RESERVED.has(key)) {
      // Paths are owned by the pipeline; ignore a stray --out/--draft etc.
      if (!a.includes('=')) i++;
      continue;
    }
    if (POLISH_NO_VALUE.has(key)) { out.polish.push(a); continue; }
    // Forward a value option to polish.mjs, preserving its shape.
    if (a.includes('=')) { out.polish.push(a); continue; }
    out.polish.push(a);
    const v = argv[i + 1];
    if (v !== undefined && !v.startsWith('--')) { out.polish.push(v); i++; }
  }
  return out;
}

function findHz(explicit) {
  const candidates = [
    explicit,
    process.env.HZ_BIN,
    'hz',
    path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'hz.exe' : 'hz'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 15000 });
      if (r.status === 0) return c;
    } catch { /* try next */ }
  }
  return null;
}

function parseJsonLoose(s) {
  try { return JSON.parse(s); } catch { /* fall through */ }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch { /* fall through */ }
  }
  return null;
}

function hzStats(stdout) {
  const data = parseJsonLoose(stdout || '');
  if (!data) return null;
  const pieces = Array.isArray(data.pieces) ? data.pieces : [];
  const chosen = pieces.map((p) => p.attempts?.[(p.chosen || 1) - 1] || p.attempts?.[0] || {});
  const rates = chosen.map((a) => a.copy_rate).filter((n) => typeof n === 'number');
  return {
    pieces: pieces.length,
    seconds: Math.round(pieces.reduce((n, p) => n + (p.seconds || 0), 0)),
    avgCopyRate: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
    missingNumbers: chosen.reduce((n, a) => n + (a.missing_numbers?.length || 0), 0),
    flagged: pieces.filter((p) => p.flagged).length,
    raw: data,
  };
}

const DOCX_BRIDGE = path.join(HERE, 'docx_bridge.py');

function findDocxPython(explicit) {
  const toolPython = process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Roaming', 'uv', 'tools', 'humanize-model', 'Scripts', 'python.exe')
    : path.join(os.homedir(), '.local', 'share', 'uv', 'tools', 'humanize-model', 'bin', 'python');
  const candidates = [explicit, process.env.PYTHON, toolPython, 'python', 'python3'].filter(Boolean);
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-c', 'import docx'], { encoding: 'utf8', timeout: 20000 });
      if (r.status === 0) return c;
    } catch { /* try next */ }
  }
  return null;
}

function runBridge(py, args) {
  const r = spawnSync(py, [DOCX_BRIDGE, ...args], {
    encoding: 'utf8',
    timeout: 2 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) throw new Error(r.error.message);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').trim();
    throw new Error(detail || `docx bridge exited ${r.status}`);
  }
}

function extractParas(py, docx, outJson) {
  runBridge(py, ['extract', docx, outJson]);
  const data = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  return Array.isArray(data.paragraphs) ? data.paragraphs : [];
}

function splitTextParagraphs(text) {
  return String(text).replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
}

/** Mirrors hz's docx plan: only paragraphs hz actually rewrote are polished. */
function prepareDocxSubset(py, originalDocx, aDocx, workDir) {
  const orig = extractParas(py, originalDocx, path.join(workDir, 'original.paras.json'));
  const a = extractParas(py, aDocx, path.join(workDir, 'humanized.paras.json'));
  if (orig.length !== a.length) {
    throw new Error(`段落數不同（原稿 ${orig.length}、A ${a.length}）；hz 應保持段落數，請確認 A.docx。`);
  }
  const indices = [];
  for (let i = 0; i < orig.length; i++) {
    if (orig[i].trim() && orig[i] !== a[i]) indices.push(i);
  }
  if (!indices.length) throw new Error('hz 沒有改寫任何段落（可能全是標題、表格、引用或含圖片的段落）。');
  const draft = indices.map((i) => orig[i]).join('\n\n');
  const hz = indices.map((i) => a[i]).join('\n\n');
  fs.writeFileSync(path.join(workDir, 'original.prose.txt'), `${draft}\n`, 'utf8');
  fs.writeFileSync(path.join(workDir, 'humanized.prose.txt'), `${hz}\n`, 'utf8');
  return { indices, total: orig.length };
}

function writeBackDocx(py, baseDocx, indices, texts, workDir, outDocx) {
  const mapPath = path.join(workDir, 'map.json');
  fs.writeFileSync(mapPath, JSON.stringify({ indices, texts }, null, 2), 'utf8');
  runBridge(py, ['apply', baseDocx, mapPath, outDocx]);
}

function docxFullText(py, docx, outTxt) {
  runBridge(py, ['fulltext', docx, outTxt]);
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (args.help || !args._.length) { console.log(HELP); process.exit(args.help ? 0 : 1); }

  const input = path.resolve(args._[0]);
  if (!fs.existsSync(input)) {
    console.error(`找不到原稿：${input}`);
    process.exit(1);
  }
  const ext = path.extname(input).toLowerCase();
  if (!['.txt', '.md', '.docx'].includes(ext)) {
    console.error(`支援 .txt / .md / .docx；${ext || '(無副檔名)'} 請先轉成文字。`);
    process.exit(1);
  }
  const isDocx = ext === '.docx';

  const outDir = args['out-dir'] ? path.resolve(args['out-dir']) : path.dirname(input);
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(input, ext);
  const humanizedDocx = path.join(outDir, `${base}.humanized.docx`);
  const finalDocx = path.join(outDir, `${base}.final.docx`);
  const humanizedPath = args.humanized
    ? path.resolve(args.humanized)
    : (isDocx ? humanizedDocx : path.join(outDir, `${base}.humanized.txt`));
  const humanizedTxt = path.join(outDir, `${base}.humanized.txt`);
  const finalPath = path.join(outDir, `${base}.final.txt`);
  const reportPath = path.join(outDir, `${base}.final.report.md`);
  const jsonPath = path.join(outDir, `${base}.final.report.json`);
  const hzJsonPath = path.join(outDir, `${base}.humanized.json`);
  const pipelineJsonPath = path.join(outDir, `${base}.pipeline.json`);
  const workDir = isDocx ? path.join(outDir, `.${base}.pipeline`) : null;
  const polishInputPath = isDocx ? path.join(workDir, 'humanized.prose.txt') : humanizedPath;
  const polishDraftPath = isDocx ? path.join(workDir, 'original.prose.txt') : input;
  const polishOutPath = isDocx ? path.join(workDir, 'polished.prose.txt') : finalPath;
  if (isDocx) fs.mkdirSync(workDir, { recursive: true });

  if (isDocx && args.humanized && path.extname(humanizedPath).toLowerCase() !== '.docx') {
    console.error('docx 模式的 --humanized 必須是 .docx（才能保留格式）。');
    process.exit(1);
  }
  if (!isDocx && args.humanized && path.extname(humanizedPath).toLowerCase() === '.docx') {
    console.error('原稿是文字、A 卻是 .docx。請把原稿也存成 .docx，或提供文字版 A。');
    process.exit(1);
  }

  const hzBin = findHz(args['hz-bin']);
  if (!hzBin && !args.humanized) {
    console.error('找不到 hz。先安裝：');
    console.error('  uv tool install "git+https://github.com/sgaofen/humanizer-local-model"');
    process.exit(1);
  }
  if (args.humanized && !fs.existsSync(humanizedPath)) {
    console.error(`找不到 Humanizer 輸出：${humanizedPath}`);
    process.exit(1);
  }

  const polishArgs = [
    polishInputPath,
    '--draft', polishDraftPath,
    '--out', polishOutPath,
    '--report', reportPath,
    '--json', jsonPath,
    ...args.polish,
  ];

  if (args['dry-run']) {
    if (args.humanized) {
      console.log(`hz:     (skip, using ${humanizedPath})`);
    } else {
      const shown = [input, '-o', humanizedPath, '--json', ...args.hzArgs]
        .map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
      console.log(`hz:     ${hzBin || '(missing)'} ${shown}`);
    }
    if (isDocx) console.log('docx:   提取段落 → 只取 hz 改寫的段落 → polish → 寫回 A.docx（python-docx）');
    console.log(`polish: ${process.execPath} "${POLISH}" ${polishArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
    return;
  }

  let docxPy = null;
  if (isDocx) {
    docxPy = findDocxPython();
    if (!docxPy) {
      console.error('找不到有 python-docx 的 Python。執行：');
      console.error('  uv pip install --python "<uv tools>/humanize-model/Scripts/python.exe" python-docx');
      console.error('（hz 的執行環境也需要 python-docx；兩者通常同一個 uv tool venv）');
      process.exit(1);
    }
  }

  // ── step 1: Humanizer CLI ────────────────────────────────────────────────
  if (!args.humanized) {
    console.log('');
    console.log('=== 1/2 Humanizer（hz）===');
    const hzArgs = [input, '-o', humanizedPath, '--json', ...args.hzArgs];
    if (args.polish.includes('--quiet')) hzArgs.push('-q');
    const r = spawnSync(hzBin, hzArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: 30 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (r.error) {
      console.error(`hz 執行失敗：${r.error.message}`);
      process.exit(1);
    }
    if (r.status !== 0) {
      console.error(`hz 回傳 ${r.status}。確認 Humanizer App 已啟動，或加 --hz-bin 指定路徑。`);
      process.exit(1);
    }
    const stats = hzStats(r.stdout);
    if (stats) {
      try {
        fs.writeFileSync(hzJsonPath, JSON.stringify(stats.raw, null, 2), 'utf8');
      } catch { /* stats are optional */ }
      const copy = stats.avgCopyRate == null ? '—' : `${(stats.avgCopyRate * 100).toFixed(1)}%`;
      console.log(`  ${stats.pieces} 段 · ${stats.seconds}s · 複製率 ${copy} · 缺數字 ${stats.missingNumbers} · 需重寫 ${stats.flagged}`);
    }
    if (!fs.existsSync(humanizedPath)) {
      console.error('hz 沒有產生輸出檔。');
      process.exit(1);
    }
    console.log(`  A（Humanizer）→ ${humanizedPath}`);
  } else {
    console.log('');
    console.log('=== 1/2 Humanizer（跳過，使用既有輸出）===');
    console.log(`  A（Humanizer）→ ${humanizedPath}`);
  }

  let docxInfo = null;
  if (isDocx) {
    console.log('');
    console.log('=== DOCX 段落對照 ===');
    try {
      docxInfo = prepareDocxSubset(docxPy, input, humanizedPath, workDir);
      console.log(`  原文件 ${docxInfo.total} 段 · hz 改寫 ${docxInfo.indices.length} 段；只修補這 ${docxInfo.indices.length} 段。`);
    } catch (e) {
      console.error(`docx 準備失敗：${e.message}`);
      process.exit(1);
    }
  }

  // ── step 2: academic polish ──────────────────────────────────────────────
  console.log('');
  console.log('=== 2/2 學術性修補（polish）===');
  const r2 = spawnSync(process.execPath, [POLISH, ...polishArgs], {
    stdio: 'inherit',
    timeout: 60 * 60 * 1000,
    env: { ...process.env, POLISH_HZ_BIN: hzBin || '' },
  });
  if (r2.error) {
    console.error(`polish 執行失敗：${r2.error.message}`);
    process.exit(1);
  }

  const auditOnly = args.polish.includes('--audit-only');
  let docxFailed = false;

  if (isDocx) {
    try {
      if (!auditOnly && fs.existsSync(polishOutPath)) {
        const bParas = splitTextParagraphs(fs.readFileSync(polishOutPath, 'utf8'));
        if (bParas.length !== docxInfo.indices.length) {
          console.error('');
          console.error(`修補後的段落數 ${bParas.length} 與 hz 改寫段數 ${docxInfo.indices.length} 不一致，未寫回 docx。`);
          console.error(`修補後的文字在：${polishOutPath}`);
          console.error('可把 --chunk-chars 調大，或把 --verify 設 audit 後重跑。');
          docxFailed = true;
        } else {
          writeBackDocx(docxPy, humanizedPath, docxInfo.indices, bParas, workDir, finalDocx);
          docxFullText(docxPy, finalDocx, finalPath);
          docxFullText(docxPy, humanizedPath, humanizedTxt);
          console.log('');
          console.log(`  B.docx → ${finalDocx}`);
          console.log(`  B 全文 → ${finalPath}`);
          console.log(`  A 全文 → ${humanizedTxt}`);
        }
      } else {
        docxFullText(docxPy, humanizedPath, humanizedTxt);
        console.log('');
        console.log(`  A 全文 → ${humanizedTxt}`);
      }
    } catch (e) {
      console.error(`docx 寫回失敗：${e.message}`);
      process.exit(1);
    }
  }

  fs.writeFileSync(pipelineJsonPath, JSON.stringify({
    input,
    docx: isDocx,
    a: humanizedPath,
    aTxt: isDocx ? humanizedTxt : humanizedPath,
    b: isDocx ? (fs.existsSync(finalDocx) ? finalDocx : null) : finalPath,
    bTxt: isDocx ? (fs.existsSync(finalPath) ? finalPath : null) : finalPath,
    report: reportPath,
    json: jsonPath,
    paragraphs: docxInfo ? docxInfo.total : null,
    changedParagraphs: docxInfo ? docxInfo.indices.length : null,
    auditOnly,
    exitCode: r2.status ?? 0,
  }, null, 2), 'utf8');

  console.log('');
  console.log('=== 完成 ===');
  console.log(`  A（Humanizer）  ${humanizedPath}`);
  if (isDocx) console.log(`  A 全文          ${humanizedTxt}`);
  if (auditOnly) {
    console.log('  審查模式：未產生 B，只列缺陷。');
  } else if (isDocx) {
    if (fs.existsSync(finalDocx)) console.log(`  B（學術修補）  ${finalDocx}`);
    if (fs.existsSync(finalPath)) console.log(`  B 全文          ${finalPath}`);
  } else {
    console.log(`  B（學術修補）  ${finalPath}`);
  }
  console.log(`  報告            ${reportPath}`);
  console.log(`  JSON            ${jsonPath}`);
  if (isDocx && docxInfo) {
    console.log('');
    console.log(`  docx：只修補 hz 改寫的 ${docxInfo.indices.length} 段散文（共 ${docxInfo.total} 段）；`);
    console.log('        標題、表格、References、含圖片／超連結的段落保持原樣。');
    console.log('        報告的三稿對照就是這幾段，不是整份文件。');
  }
  console.log('');
  console.log('交付前：A/B 各跑一次正式 Turnitin 報告；先看報告的「未自動處理」與「人工覆核清單」。');

  process.exit(docxFailed ? 1 : (r2.status ?? 0));
}

main();
