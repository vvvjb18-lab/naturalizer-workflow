#!/usr/bin/env node
// Academic repair pass for Humanizer output.
// Usage: node polish.mjs <humanized.txt> [--draft original.txt] [options]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './src/pipeline.mjs';
import { buildReport, buildJsonReport } from './src/report.mjs';
import { chatJson } from './src/llm.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// API presets. `provider` in the config is one of these names (or "ollama" for
// a local Ollama server). Every non-ollama preset speaks the OpenAI protocol.
const PRESETS = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-pro' },
  'gemini-native': { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-pro' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k' },
  qwen: { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.5' },
  lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model' },
  ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen38-27b-q3:latest' },
};

const DEFAULTS = {
  provider: 'openai',
  baseUrl: '',
  model: '',
  apiKey: '',
  apiKeyEnv: '',
  temperature: 0,
  topP: 0.9,
  repeatPenalty: 1.0,
  numCtx: 8192,
  timeoutMs: 300000,
  maxOutputTokens: 3000,
  chunkChars: 6000,
  maxDraftChars: 12000,
  maxEditRatio: 0.15,
  minCvRetention: 0.8,
  maxPatchWords: 120,
  maxIssuesPerChunk: 20,
  repairBatch: 12,
  verifyRound: 'audit',
  hzRetry: true,
  hzRetries: 5,
  maxHzIssues: 3,
  hzTimeoutMs: 180000,
  hzBin: '',
  skill: 'academic-humanizer',
  judge: true,
  judgeProvider: '',
  judgeBaseUrl: '',
  judgeModel: '',
  judgeApiKey: '',
  judgeApiKeyEnv: '',
  judgeMinScore: 18,
  judgeMinDimension: 3,
  judgeFailOpen: false,
  mode: 'strong',
  strongAttempts: 3,
  forceFix: true,
  forceMinScore: 16,
  rewriteProvider: '',
  rewriteBaseUrl: '',
  rewriteModel: '',
  rewriteApiKey: '',
  rewriteApiKeyEnv: '',
  rewriteTemperature: null,
  rewriteProxyUrl: '',
  rewriteFallback: true,
  judgeProxyUrl: '',
  cleanup: true,
  maxCleanupRounds: 2,
  maxCleanupActions: 8,
  lang: 'auto',
  jsonMode: true,
};

const HELP = `Humanizer 之後的學術性修補（只修缺陷，不重寫）

用法：
  node polish.mjs <humanizer輸出.txt> [選項]
  node polish.mjs <humanizer輸出.txt> --draft <原始草稿.txt>
  node polish.mjs --ping            測試 API key 與模型是否可用

選項：
  --draft <file>        原始草稿。強烈建議提供：事實、引用、術語、論斷強度都以它為準。
  --out <file>          輸出檔（預設 <輸入>.polished.txt）
  --report <file>       Markdown 報告（預設 <輸出>.report.md）
  --json <file>         JSON 報告（預設 <輸出>.report.json）
  --audit-only          只審查、不修改，列出所有缺陷
  --ping                只發一個極短請求，確認 API 設定正確
  --lang <auto|en|zh>   語言（預設自動判斷）
  --provider <name>     openai | deepseek | gemini | openrouter | moonshot |
                        qwen | zhipu | lmstudio | ollama
  --base-url <url>      覆蓋 preset 的 API 位址
  --model <name>        覆蓋 preset 的模型
  --api-key <key>       API key（也可用 POLISH_API_KEY 或 apiKeyEnv）
  --skill <name|none>   注入的 skill 合約（預設 academic-humanizer）
  --mode <safe|strong>  監督改寫強度（預設 strong）
  --chunk-chars <n>     每次送給模型的字元數（預設 6000）
  --temperature <n>     預設 0
  --max-edit-ratio <n>  允許改動的字詞比例上限（預設 0.15）
  --verify <mode>       修補後的驗證：audit（預設，只審查）、repair（自動再修）、off
  --config <file>       設定檔（預設 polish.config.json）
  --no-json             不寫 JSON 報告
  --quiet               只輸出最後摘要
  -h, --help            顯示本說明

環境變數：POLISH_PROVIDER / POLISH_BASE_URL / POLISH_MODEL / POLISH_API_KEY / POLISH_LANG

退出碼：0 正常；1 無法執行；2 有嚴重問題或硬性檢查未通過，需人工覆核。
`;

function parseArgs(argv) {
  const out = { _: [] };
  const takesValue = new Set([
    'draft', 'out', 'report', 'json', 'lang', 'provider', 'base-url', 'model',
    'api-key', 'chunk-chars', 'temperature', 'max-edit-ratio', 'config', 'in',
    'timeout', 'max-patch-words', 'max-output-tokens', 'verify', 'skill', 'mode',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { out.help = true; continue; }
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (key === 'audit-only') { out.auditOnly = true; continue; }
    if (key === 'ping') { out.ping = true; continue; }
    if (key === 'quiet') { out.quiet = true; continue; }
    if (key === 'no-json') { out.noJson = true; continue; }
    if (!takesValue.has(key)) throw new Error(`未知選項 --${key}`);
    const val = argv[++i];
    if (val == null) throw new Error(`--${key} 需要一個值`);
    out[key] = val;
  }
  return out;
}

function num(v, fallback) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function readJsonIfExists(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`設定檔讀取失敗 ${p}: ${e.message}`);
  }
}

/** Minimal .env loader: KEY=value lines, quotes optional, never overwrites. */
function loadDotEnv(file) {
  try {
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  } catch { /* a broken .env should not stop the run */ }
}

function isLocalUrl(url) {
  return /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/i.test(url || '')
    || /^https?:\/\/(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(url || '');
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function defaultOut(input) {
  if (input === '-') return path.resolve('polished.txt');
  const ext = path.extname(input);
  return input.slice(0, input.length - ext.length) + '.polished' + (ext || '.txt');
}

function findHzPath() {
  const candidates = [
    process.env.POLISH_HZ_BIN,
    'hz',
    path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'hz.exe' : 'hz'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 15000 });
      if (r.status === 0) return c;
    } catch { /* try next */ }
  }
  return '';
}

function loadSkillPrompt(name) {
  if (!name || name === 'none') return '';
  const dir = path.join(HERE, 'skills', name);
  for (const file of ['PROMPT.md', 'SKILL.md']) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) {
      let text = fs.readFileSync(p, 'utf8');
      if (text.length > 14000) text = `${text.slice(0, 14000)}

[...truncated]`;
      return text;
    }
  }
  console.error(`找不到 skill：${name}（${dir}），改用無 skill 模式。`);
  return '';
}

function resolveConfig(args, fileCfg) {
  const requested = args.provider || process.env.POLISH_PROVIDER || fileCfg.provider || DEFAULTS.provider;
  const preset = PRESETS[requested] || {};
  const adapter = requested === 'ollama' ? 'ollama' : 'openai';

  const baseUrl = args['base-url'] || process.env.POLISH_BASE_URL || fileCfg.baseUrl || preset.baseUrl || '';
  const model = args.model || process.env.POLISH_MODEL || fileCfg.model || preset.model || '';
  const apiKey = args['api-key']
    || process.env.POLISH_API_KEY
    || (fileCfg.apiKeyEnv ? process.env[fileCfg.apiKeyEnv] : '')
    || fileCfg.apiKey
    || '';

  const verifyChoice = args.verify ?? fileCfg.verifyRound ?? DEFAULTS.verifyRound;
  const verifyRound = verifyChoice === 'off' || verifyChoice === false ? false : verifyChoice;

  const cfg = {
    ...DEFAULTS,
    ...fileCfg,
    provider: adapter,
    preset: requested,
    baseUrl: adapter === 'ollama' ? baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') : baseUrl,
    model,
    apiKey,
    lang: args.lang || process.env.POLISH_LANG || fileCfg.lang || DEFAULTS.lang,
    chunkChars: num(args['chunk-chars'], fileCfg.chunkChars ?? DEFAULTS.chunkChars),
    temperature: num(args.temperature, fileCfg.temperature ?? DEFAULTS.temperature),
    numCtx: num(undefined, fileCfg.numCtx ?? DEFAULTS.numCtx),
    timeoutMs: num(args.timeout, fileCfg.timeoutMs ?? (adapter === 'ollama' ? 900000 : DEFAULTS.timeoutMs)),
    maxEditRatio: num(args['max-edit-ratio'], fileCfg.maxEditRatio ?? DEFAULTS.maxEditRatio),
    maxPatchWords: num(args['max-patch-words'], fileCfg.maxPatchWords ?? DEFAULTS.maxPatchWords),
    maxOutputTokens: num(args['max-output-tokens'], fileCfg.maxOutputTokens ?? DEFAULTS.maxOutputTokens),
    minCvRetention: num(args['min-cv-retention'], fileCfg.minCvRetention ?? DEFAULTS.minCvRetention),
    verifyRound,
    hzBin: process.env.POLISH_HZ_BIN || fileCfg.hzBin || findHzPath(),
    rewriteExtraBody: fileCfg.rewriteExtraBody || null,
    hzRetry: fileCfg.hzRetry ?? DEFAULTS.hzRetry,
    hzRetries: num(undefined, fileCfg.hzRetries ?? DEFAULTS.hzRetries),
    maxHzIssues: num(undefined, fileCfg.maxHzIssues ?? DEFAULTS.maxHzIssues),
    hzTimeoutMs: num(undefined, fileCfg.hzTimeoutMs ?? DEFAULTS.hzTimeoutMs),
    skill: args.skill || fileCfg.skill || DEFAULTS.skill,
    skillPrompt: '',
    judge: fileCfg.judge ?? DEFAULTS.judge,
    judgeProvider: fileCfg.judgeProvider || '',
    judgeBaseUrl: fileCfg.judgeBaseUrl || '',
    judgeModel: fileCfg.judgeModel || '',
    judgeApiKey: (fileCfg.judgeProvider || '')
      ? (process.env.POLISH_JUDGE_API_KEY
        || (fileCfg.judgeApiKeyEnv ? process.env[fileCfg.judgeApiKeyEnv] : '')
        || fileCfg.judgeApiKey
        || '')
      : '',
    judgeMinScore: num(undefined, fileCfg.judgeMinScore ?? DEFAULTS.judgeMinScore),
    judgeMinDimension: num(undefined, fileCfg.judgeMinDimension ?? DEFAULTS.judgeMinDimension),
    judgeFailOpen: fileCfg.judgeFailOpen ?? DEFAULTS.judgeFailOpen,
    rewriteProxyUrl: fileCfg.rewriteProxyUrl || '',
    rewriteFallback: fileCfg.rewriteFallback ?? DEFAULTS.rewriteFallback,
    judgeProxyUrl: fileCfg.judgeProxyUrl || '',
    mode: args.mode || fileCfg.mode || DEFAULTS.mode,
    strongAttempts: num(undefined, fileCfg.strongAttempts ?? DEFAULTS.strongAttempts),
    forceFix: fileCfg.forceFix ?? DEFAULTS.forceFix,
    forceMinScore: num(undefined, fileCfg.forceMinScore ?? DEFAULTS.forceMinScore),
  };
  cfg.skillPrompt = loadSkillPrompt(cfg.skill);

  const rewriteProvider = fileCfg.rewriteProvider || '';
  const rewritePreset = PRESETS[rewriteProvider] || {};
  const rewriteAdapter = rewriteProvider
    ? (rewriteProvider === 'ollama' ? 'ollama' : rewriteProvider === 'gemini-native' ? 'gemini' : 'openai')
    : cfg.provider;
  cfg.rewriteProvider = rewriteProvider;
  cfg.rewriteAdapter = rewriteAdapter;
  cfg.rewriteBaseUrl = fileCfg.rewriteBaseUrl || rewritePreset.baseUrl || '';
  cfg.rewriteModel = fileCfg.rewriteModel || rewritePreset.model || '';
  cfg.rewriteApiKey = rewriteProvider
    ? (process.env.POLISH_REWRITE_API_KEY
      || (fileCfg.rewriteApiKeyEnv ? process.env[fileCfg.rewriteApiKeyEnv] : '')
      || fileCfg.rewriteApiKey
      || '')
    : '';
  cfg.rewriteTemperature = fileCfg.rewriteTemperature ?? null;

  const judgeProvider = fileCfg.judgeProvider || '';
  const judgePreset = PRESETS[judgeProvider] || {};
  cfg.judgeAdapter = judgeProvider
    ? (judgeProvider === 'ollama' ? 'ollama' : judgeProvider === 'gemini-native' ? 'gemini' : 'openai')
    : cfg.provider;
  if (!cfg.judgeBaseUrl && judgePreset.baseUrl) cfg.judgeBaseUrl = judgePreset.baseUrl;
  if (!cfg.judgeModel && judgePreset.model) cfg.judgeModel = judgePreset.model;
  // Explicit --temperature is a number; allow null in the config to omit it.
  if (fileCfg.temperature === null) cfg.temperature = null;
  return cfg;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(e.message);
    console.error('用 --help 查看用法。');
    process.exit(1);
  }
  if (args.help) { console.log(HELP); return; }

  const cfgPath = args.config ? path.resolve(args.config) : path.join(HERE, 'polish.config.json');
  loadDotEnv(path.join(HERE, '.env'));
  const fileCfg = readJsonIfExists(cfgPath) || {};
  if (!Object.keys(fileCfg).length && !args.quiet) {
    console.error(`找不到 ${path.basename(cfgPath)}，使用內建預設。可複製 polish.config.example.json 後填寫。`);
  }
  const cfg = resolveConfig(args, fileCfg);
  const log = args.quiet ? () => {} : (m) => console.error(m);

  if (!cfg.baseUrl) {
    console.error('缺少 API 位址。設定 --base-url，或在 polish.config.json 選一個 provider。');
    process.exit(1);
  }
  if (!cfg.model) {
    console.error('缺少模型名稱。設定 --model，或在 polish.config.json 填 model。');
    process.exit(1);
  }
  if (cfg.provider === 'openai' && !cfg.apiKey && !isLocalUrl(cfg.baseUrl)) {
    console.error('缺少 API key。');
    console.error('  方法一：在 polish.config.json 填 "apiKey"');
    console.error('  方法二：設定環境變數 POLISH_API_KEY');
    console.error('  方法三：命令列加 --api-key sk-...');
    console.error('  方法四：在 config 填 "apiKeyEnv": "DEEPSEEK_API_KEY" 之類的變數名');
    process.exit(1);
  }

  if (args.ping) {
    console.log(`測試連線：${cfg.preset} / ${cfg.model}`);
    console.log(`端點：${cfg.baseUrl}`);
    const t0 = Date.now();
    try {
      const res = await chatJson(cfg, {
        system: 'You are a connectivity test. Return JSON only.',
        user: 'Return exactly this JSON object and nothing else: {"ok":true}',
        label: 'ping',
      }, log);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`成功：模型有回應，JSON 解析正常（${secs} 秒）${res && res.ok === true ? '' : '（回應內容與預期不同，但格式可用）'}`);
      return;
    } catch (e) {
      console.error(`失敗：${e.message}`);
      console.error('檢查 key、模型名稱、base URL 與帳戶餘額。');
      process.exit(1);
    }
  }

  const inputPath = args.in || args._[0];
  if (!inputPath) {
    console.error('缺少輸入檔。\n');
    console.log(HELP);
    process.exit(1);
  }

  // ── read input ──
  let raw;
  try {
    raw = inputPath === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(inputPath, 'utf8');
  } catch (e) {
    console.error(`讀不到輸入檔 ${inputPath}: ${e.message}`);
    process.exit(1);
  }
  const crlf = /\r\n/.test(raw);
  const humanized = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!humanized) {
    console.error('輸入檔是空的。');
    process.exit(1);
  }

  let draft = '';
  if (args.draft) {
    try {
      draft = fs.readFileSync(args.draft, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    } catch (e) {
      console.error(`讀不到原始草稿 ${args.draft}: ${e.message}`);
      process.exit(1);
    }
  }

  const outPath = path.resolve(args.out || defaultOut(inputPath));
  const outBase = outPath.replace(/\.txt$/i, '');
  const reportPath = path.resolve(args.report || (outBase + (args.auditOnly ? '.audit.md' : '.report.md')));
  const jsonPath = args.noJson ? null : path.resolve(args.json || (outBase + (args.auditOnly ? '.audit.report.json' : '.report.json')));

  log(`模型：${cfg.preset} / ${cfg.model} @ ${cfg.baseUrl}`);
  if (!draft) log('提示：沒有提供 --draft，無法核對事實、引用與論斷強度（強烈建議提供）。');

  let result;
  try {
    result = await runPipeline({ humanized, draft, cfg, log, auditOnly: !!args.auditOnly });
  } catch (e) {
    console.error(`執行失敗：${e.message}`);
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|connect/i.test(e.message)) {
      console.error('連不上模型服務。檢查 --base-url、網路與 API key；可先用 --ping 測試。');
    }
    process.exit(1);
  }

  const now = stamp();
  const restoreEol = (s) => (crlf ? s.replace(/\n/g, '\r\n') : s);

  if (!args.auditOnly) {
    fs.writeFileSync(outPath, restoreEol(result.outputText.endsWith('\n') ? result.outputText : result.outputText + '\n'), 'utf8');
  }

  const report = buildReport({
    inputName: path.basename(inputPath === '-' ? '(stdin)' : inputPath),
    draftName: args.draft ? path.basename(args.draft) : null,
    outputName: args.auditOnly ? '(審查模式，未輸出)' : path.basename(outPath),
    cfg, result, generatedAt: now,
    draftText: draft,
    humanizedText: humanized,
  });
  fs.writeFileSync(reportPath, report, 'utf8');

  if (jsonPath) {
    const json = buildJsonReport({
      inputName: path.basename(inputPath === '-' ? '(stdin)' : inputPath),
      draftName: args.draft ? path.basename(args.draft) : null,
      cfg, result, generatedAt: now,
      draftText: draft,
      humanizedText: humanized,
    });
    fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), 'utf8');
  }

  // ── summary ──
  const s = result.stats;
  const failed = result.gates.filter((g) => !g.ok);
  const criticalCount = result.unresolved.filter((u) => u.severity === 'critical').length;
  const important = result.unresolved.filter((u) => u.severity === 'critical' || u.severity === 'major');
  const verifyAuditOnly = s.verificationFound > 0 && result.unresolved.length > 0
    && !result.patches.some((p) => p.round === 2);
  const cvRetention = result.metrics.before.cv ? result.metrics.after.cv / result.metrics.before.cv : 1;

  console.log('');
  console.log(args.auditOnly ? '審查完成（未修改）' : '修補完成');
  if (args.auditOnly) {
    const sev = { critical: 0, major: 0, minor: 0 };
    for (const u of result.unresolved) sev[u.severity] = (sev[u.severity] || 0) + 1;
    console.log(`  發現缺陷    ${s.found}（critical ${sev.critical} / major ${sev.major} / minor ${sev.minor}）`);
  } else {
    console.log(`  發現缺陷    ${s.found}`);
    console.log(`  實際修補    ${s.applied} 處（改動 ${(s.changedRatio * 100).toFixed(1)}% 字詞）`);
    if (s.verificationFound) console.log(`  驗證輪     另發現 ${s.verificationFound} 項`);
    if (s.cleanupActions) console.log(`  監督輪     ${s.cleanupActions} 處${s.rewrites ? `（hz ${s.hzRewrites || 0}、API ${s.rewrites - (s.hzRewrites || 0)}）` : ''}`);
    if (s.judgePass || s.judgeFail) console.log(`  品質 gate   通過 ${s.judgePass}、退回 ${s.judgeFail}${s.forced ? `、強制 ${s.forced}` : ''}`);
    console.log(`  未解決      ${result.unresolved.length} 項${criticalCount ? `（其中 ${criticalCount} 項嚴重）` : ''}${verifyAuditOnly ? '（驗證輪待覆核）' : ''}`);
    console.log(`  節奏保留    ${(cvRetention * 100).toFixed(0)}%`);
    console.log(`  硬性檢查    ${failed.length ? `${failed.length} 項未通過：${failed.map((g) => g.name).join(', ')}` : '全部通過'}`);
  }
  console.log('');
  console.log(`  報告  ${reportPath}`);
  if (!args.auditOnly) console.log(`  輸出  ${outPath}`);
  if (jsonPath) console.log(`  JSON  ${jsonPath}`);

  if (important.length || failed.length) {
    console.log('');
    console.log('需要人工覆核：');
    for (const c of important.slice(0, 8)) console.log(`  - [${c.type}/${c.severity}] ${String(c.problem || '').slice(0, 140)}`);
    for (const g of failed) console.log(`  - 檢查「${g.name}」：${g.detail}`);
    console.log('');
    console.log('詳見報告的「人工覆核清單」與「未自動處理」。');
    process.exitCode = 2;
  }

  if (result.errors.length && s.applied === 0) {
    console.log('');
    console.log('注意：模型呼叫有錯誤，且沒有任何修改被套用。詳見報告的執行紀錄。');
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(`未預期的錯誤：${e.stack || e.message}`);
  process.exit(1);
});
