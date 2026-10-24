#!/usr/bin/env node
// evolve.mjs — Workflow 7.1 overnight seed evolution.
//
// Zero-cost autonomous iteration: rounds of candidate generation → surgery →
// crossover → offline scoring → Pareto archive. No polish, no cloud, no
// Turnitin — it builds a seed library while you sleep; the morning report
// lists the top seeds for certification.
//
// Built-in watchdog: if the Humanizer engine dies mid-run it is restarted
// automatically (up to 3 attempts); if it cannot come back the run stops and
// everything collected so far is kept.
//
// Usage:
//   node evolve.mjs <draft.docx|txt> [--out-dir DIR] [--rounds N] [--minutes M]
//        [--k 6] [--target balanced|ideal] [--resume]
//
// Output in --out-dir:
//   archive.json      every kept seed with metrics (resumable)
//   seeds/seed-XX.txt each seed's prose
//   evolve.log        full run log
//   evolve.report.md  morning report (Pareto front + top seeds + checklist)

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

import {
  generateCandidate, candidateStats, rankCandidates, scoreTexts, closeDetector,
  detectDocType, surgicalRepair, assembleCrossover, mechanicalPolish, grammarScores,
} from './candidates.mjs';
import { detectLang, splitSentences, wordCount } from '../polish/src/text.mjs';

const HERE = import.meta.dirname;
const DOCX_BRIDGE = path.resolve(HERE, 'docx_bridge.py');
const HUMANIZER_EXE = 'F:\\Humanizer\\Humanizer.exe';

// crash telemetry: if the run dies overnight, the log must say why
process.on('uncaughtException', (e) => { try { fs.appendFileSync(logPathFallback, `[FATAL uncaught] ${e.stack || e.message}\n`); } catch {} console.error(e.stack || e.message); process.exit(1); });
process.on('unhandledRejection', (e) => { try { fs.appendFileSync(logPathFallback, `[FATAL rejection] ${(e && e.stack) || e}\n`); } catch {} console.error((e && e.stack) || e); process.exit(1); });
let logPathFallback = 'evolve-crash.log';

function parseArgs(argv) {
  const out = { _: [], k: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('--')) { out.k[key] = v; i++; }
      else out.k[key] = true;
    } else out._.push(a);
  }
  return out;
}

const fmt = (x, d = 3) => (x == null || !Number.isFinite(x) ? '—' : Number(x).toFixed(d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runBridge(args) {
  const r = spawnSync('python', [DOCX_BRIDGE, ...args], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`docx_bridge ${args[0]} failed: ${String(r.stderr).slice(0, 300)}`);
  return r.stdout.trim();
}

// ── engine watchdog ─────────────────────────────────────────────────────────
async function engineReady() {
  try {
    const res = await fetch('http://127.0.0.1:47615/app/status', { signal: AbortSignal.timeout(5000) });
    const j = await res.json();
    return j.phase === 'ready';
  } catch { return false; }
}
async function ensureEngine(log) {
  if (await engineReady()) return true;
  log('引擎離線，嘗試重啟 Humanizer…');
  try { spawn(HUMANIZER_EXE, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* best effort */ }
  for (let i = 0; i < 36; i++) {   // up to ~3 min model load
    await sleep(5000);
    if (await engineReady()) { log('引擎已恢復'); return true; }
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args._.length) { console.error('用法：node evolve.mjs <draft> [--out-dir DIR] [--rounds N] [--minutes M] [--k 6] [--target balanced] [--resume]'); process.exit(1); }
  const input = path.resolve(args._[0]);
  if (!fs.existsSync(input)) { console.error(`找不到：${input}`); process.exit(1); }
  const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'v6.config.json'), 'utf8'));
  const target = args.k.target || cfg.target || 'balanced';
  const K = Math.max(2, parseInt(args.k.k || 3, 10));
  const maxRounds = parseInt(args.k.rounds || 30, 10);
  const maxMinutes = parseFloat(args.k.minutes || 420);
  const outDir = path.resolve(args.k['out-dir'] || path.join(path.dirname(input), 'evolve'));
  const seedsDir = path.join(outDir, 'seeds');
  fs.mkdirSync(seedsDir, { recursive: true });
  const logPath = path.join(outDir, 'evolve.log');
  const log = (m) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
    console.log(line);
    fs.appendFileSync(logPath, line + '\n', 'utf8');
  };
  logPathFallback = logPath;

  const gramThreshold = cfg.grammarThreshold ?? 0.5;
  const weights = cfg.weights;
  const filters = { ...cfg.filters, formMode: false };

  // plan (docx via bridge; txt single unit)
  const ext = path.extname(input).toLowerCase();
  let plan;
  if (ext === '.docx') {
    const planPath = path.join(outDir, 'plan.json');
    log(runBridge(['plan', input, planPath]));
    plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } else {
    plan = { paragraphs: [fs.readFileSync(input, 'utf8')], targets: { 0: { units: [{ id: 1, text: fs.readFileSync(input, 'utf8') }], joiner: ' ' } }, kept: {} };
  }
  const targetIdx = Object.keys(plan.targets);
  if (!targetIdx.length) throw new Error('沒有可改寫段落');
  const originalsByPara = {};
  for (const i of targetIdx) originalsByPara[i] = plan.targets[i].units.map((u) => u.text).join(' ');
  const originalProse = targetIdx.map((i) => originalsByPara[i]).join('\n\n');
  fs.writeFileSync(path.join(outDir, 'original.prose.txt'), originalProse + '\n', 'utf8');
  const lang = detectLang(originalProse) === 'zh' ? 'zh' : 'en';
  const docType = detectDocType(plan);
  log(`plan：${targetIdx.length} 段 · lang=${lang} · 型別 ${docType.form ? 'form' : 'essay'} · 目標 ${target} · K=${K} · 上限 ${maxRounds} 輪/${maxMinutes} 分`);

  // archive (resumable)
  const archivePath = path.join(outDir, 'archive.json');
  let archive = [];
  let nextSeedId = 1;
  if (args.k.resume && fs.existsSync(archivePath)) {
    archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    nextSeedId = Math.max(0, ...archive.map((s) => s.seed)) + 1;
    log(`續跑：載入 ${archive.length} 個既有種子`);
  }
  const sentMemo = new Map();
  const scoreSents = async (sents) => {
    const idx = []; const missing = [];
    for (const s of sents) { if (sentMemo.has(s)) idx.push(sentMemo.get(s)); else { idx.push(null); missing.push(s); } }
    if (missing.length) {
      const got = await grammarScores(missing);
      missing.forEach((s, i) => sentMemo.set(s, got[i]));
      for (let i = 0, j = 0; i < idx.length; i++) if (idx[i] === null) idx[i] = got[j++];
    }
    return idx;
  };
  const damageOf = async (prose) => {
    const sents = splitSentences(prose, lang).map((s) => s.text);
    if (!sents.length) return 0;
    const sc = await scoreSents(sents);
    return sc.filter((p) => p < gramThreshold).length / sents.length;
  };

  const startedAt = Date.now();
  const roundSamplings = [
    [{ temperature: 1.0, topP: 0.95 }, { temperature: 1.0, topP: 0.95 }, { temperature: 0.9, topP: 0.95 }, { temperature: 1.1, topP: 0.95 }, { temperature: 1.0, topP: 0.90 }, { temperature: 0.95, topP: 0.95 }],
    [{ temperature: 1.0, topP: 0.95 }, { temperature: 1.05, topP: 0.95 }, { temperature: 0.9, topP: 0.92 }, { temperature: 1.1, topP: 0.95 }, { temperature: 1.0, topP: 0.95 }, { temperature: 1.15, topP: 0.95 }],
  ];

  let engineFailures = 0;
  let round = 0;
  try {
    for (round = 1; round <= maxRounds; round++) {
      if ((Date.now() - startedAt) / 60000 > maxMinutes) { log(`到達時間上限（${maxMinutes} 分），停止`); break; }
      if (!(await ensureEngine(log))) {
        engineFailures++;
        log(`引擎無法恢復（第 ${engineFailures} 次）`);
        if (engineFailures >= 3) { log('引擎三次無法恢復，結束夜跑；已收集結果保留'); break; }
        await sleep(60000);
        continue;
      }
      engineFailures = 0;
      const t0 = Date.now();
      log(`── round ${round}/${maxRounds} ──`);
      const samplings = roundSamplings[(round - 1) % roundSamplings.length];

      // 1) generate K candidates
      const cands = [];
      for (let k = 0; k < K; k++) {
        if ((Date.now() - t0) / 60000 > 20) { log('  本輪已超 20 分，停止生成，處理手上候選'); break; }
        const sampling = samplings[k % samplings.length];
        try {
          const gen = await generateCandidate({ plan, sampling, retries: 1, lang, log: () => {} });
          const prose = targetIdx.map((i) => gen.paras[i]).filter(Boolean).join('\n\n');
          if (!prose) continue;
          const stats = candidateStats({ originalProse, prose, lang });
          stats.coverage = gen.coverage;
          const c = { id: k + 1, sampling, prose, stats, paras: gen.paras, failures: gen.failures };
          c.grammarDamagePre = await damageOf(prose);
          cands.push(c);
          log(`  cand${k + 1} ok coverage=${(gen.coverage * 100).toFixed(0)}% CV=${fmt(stats.cv)} dmg=${fmt(c.grammarDamagePre)}`);
        } catch (e) {
          log(`  cand${k + 1} 生成失敗：${e.message}`);
        }
      }
      if (!cands.length) { log('  本輪沒有可用候選，跳過'); continue; }

      // 2) surgery (non-fatal per candidate)
      for (const c of cands) {
        if ((c.grammarDamagePre ?? 0) === 0) { c.grammarDamage = 0; c.surgeries = []; continue; }
        if ((c.grammarDamagePre ?? 0) > (cfg.grammarDamageDrop ?? 0.3)) { c.grammarDamage = c.grammarDamagePre; c.surgeries = []; continue; }
        try {
          const repaired = await surgicalRepair({
            paras: c.paras, originalsByPara, lang, cfg: { ...cfg, grammarThreshold: gramThreshold },
            scorer: scoreSents, log: () => {},
          });
          c.paras = repaired.paras;
          c.surgeries = repaired.surgeries;
          c.prose = targetIdx.map((i) => c.paras[i]).filter(Boolean).join('\n\n');
          const newStats = candidateStats({ originalProse, prose: c.prose, lang });
          newStats.coverage = c.stats.coverage;
          c.stats = newStats;
          const total = splitSentences(c.prose, lang).length;
          c.grammarDamage = total ? repaired.residualDamaged / total : 0;
        } catch (e) {
          c.grammarDamage = c.grammarDamagePre;
          c.surgeries = [];
          log(`  cand${c.id} 手術中斷（${e.message}），保留原樣`);
        }
      }

      // 3) crossover within the round
      const poolOk = cands.filter((c) => (c.stats.coverage ?? 0) >= 1);
      let extra = [];
      if (poolOk.length >= 2) {
        try {
          const paraStats = {};
          for (const c of poolOk) {
            for (const [pi, text] of Object.entries(c.paras)) {
              const sents = splitSentences(text, lang).map((s) => s.text);
              const sc = await scoreSents(sents);
              const damaged = sc.filter((p) => p < gramThreshold).length;
              const lens = sents.map((s) => wordCount(s, lang));
              const mean = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
              const va = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, lens.length);
              (paraStats[pi] ||= []).push({ candId: c.id, damage: sents.length ? damaged / sents.length : 0, damaged, cv: mean > 0 ? Math.sqrt(va) / mean : 0 });
            }
          }
          const rankTmp = rankCandidates(cands, { weights, filters });
          const xo = assembleCrossover({ cands: poolOk, paraStats, cvBand: filters.cvBand });
          const prose = targetIdx.map((i) => xo.paras[i]).filter(Boolean).join('\n\n');
          if (prose) {
            const stats = candidateStats({ originalProse, prose, lang });
            stats.coverage = 1;
            const dmg = Object.entries(xo.provenance).reduce((n, [pi, candId]) => {
              const st = paraStats[pi].find((x) => x.candId === candId);
              return n + (st ? st.damaged : 0);
            }, 0);
            const total = splitSentences(prose, lang).length;
            extra.push({
              id: 'X', crossover: true, provenance: xo.provenance, paras: xo.paras, prose, stats,
              grammarDamage: total ? dmg / total : 0, grammarDamagePre: null, surgeries: 0, failures: [],
            });
          }
        } catch (e) {
          log(`  重組失敗（${e.message}）`);
        }
      }

      // 4) score + mechanical polish + archive
      const fresh = [...cands, ...extra];
      try {
        const scored = await scoreTexts(fresh.map((c) => c.prose));
        fresh.forEach((c, i) => { c.score = scored[i]; });
      } catch (e) {
        log(`  離線評分失敗（${e.message}），本輪只入檔無分數者跳過`);
      }
      const rankAll = rankCandidates(fresh, { weights, filters });
      for (const c of fresh) {
        if (!c.score) continue;
        for (const pi of Object.keys(c.paras)) {
          const fixed = mechanicalPolish(c.paras[pi], lang);
          if (fixed !== c.paras[pi]) c.paras[pi] = fixed;
        }
        c.prose = targetIdx.map((i) => c.paras[i]).filter(Boolean).join('\n\n');
        archive.push({
          seed: nextSeedId++, round, crossover: !!c.crossover,
          provenance: c.provenance || null,
          sampling: c.sampling || null,
          stats: c.stats, score: c.score,
          grammarDamage: c.grammarDamage ?? null,
          surgeries: (c.surgeries || []).length,
          risk: c.risk ?? null, eligible: rankAll.eligible.includes(c),
          prose: c.prose,
        });
      }

      // 5) prune archive: top by risk + profile diversity
      const byRisk = [...archive].sort((a, b) => (a.risk ?? 9) - (b.risk ?? 9));
      const keep = new Set();
      byRisk.slice(0, 12).forEach((s) => keep.add(s.seed));
      const idealSeeds = archive
        .filter((s) => (s.stats?.cv ?? 0) >= 0.45 && (s.stats?.cv ?? 0) <= 0.65
          && (s.grammarDamage ?? 0) >= 0.03 && (s.grammarDamage ?? 0) <= 0.25)
        .sort((a, b) => (a.risk ?? 9) - (b.risk ?? 9)).slice(0, 8);
      idealSeeds.forEach((s) => keep.add(s.seed));
      const burstSeeds = [...archive].sort((a, b) => (b.stats?.cv ?? 0) - (a.stats?.cv ?? 0)).slice(0, 4);
      burstSeeds.forEach((s) => keep.add(s.seed));
      archive = archive.filter((s) => keep.has(s.seed));
      for (const s of archive) {
        fs.writeFileSync(path.join(seedsDir, `seed-${String(s.seed).padStart(3, '0')}.txt`), s.prose + '\n', 'utf8');
      }
      fs.writeFileSync(archivePath, JSON.stringify(archive), 'utf8');
      const best = byRisk[0];
      log(`  本輪 ${fresh.length} 個變體 → 存檔 ${archive.length}；目前最佳 seed#${best?.seed} risk=${fmt(best?.risk)} CV=${fmt(best?.stats?.cv)} dmg=${fmt(best?.grammarDamage)}（${((Date.now() - t0) / 60000).toFixed(1)} 分/輪）`);
    }
  } finally {
    await closeDetector().catch(() => {});
  }

  // morning report
  const byRisk = [...archive].sort((a, b) => (a.risk ?? 9) - (b.risk ?? 9));
  const ideal = archive.filter((s) => (s.stats?.cv ?? 0) >= 0.45 && (s.stats?.cv ?? 0) <= 0.65 && (s.grammarDamage ?? 0) >= 0.03 && (s.grammarDamage ?? 0) <= 0.25).sort((a, b) => (a.risk ?? 9) - (b.risk ?? 9));
  const rows = (list) => list.slice(0, 15).map((s) => `| ${s.seed} | ${s.round} | ${s.crossover ? 'X' : ''} | ${fmt(s.stats?.cv)} | ${fmt(s.grammarDamage)} | ${fmt(s.score?.p_ai_gen)} | ${fmt(s.score?.p_ai_edit)} | ${fmt(s.score?.perplexity, 1)} | ${fmt(s.risk)} | seeds/seed-${String(s.seed).padStart(3, '0')}.txt |`).join('\n');
  const md = `# 夜間迭代報告（evolve）

- 時間：${new Date().toISOString()}
- 原稿：${input} · 目標 ${target} · 完成 ${round - 1} 輪 · 存檔 ${archive.length} 個種子
- 用時：${((Date.now() - startedAt) / 60000).toFixed(0)} 分鐘

## Balanced 排名前 15（低風險優先）

| seed | 輪 | X | CV | 傷率 | p_ai_gen | p_ai_edit | ppl | risk | 檔案 |
|---|---|---|---|---|---|---|---|---|---|
${rows(byRisk)}

## Ideal 剖面（CV 帶內＋傷率 0.03–0.25，衝 <20 種子庫）

| seed | 輪 | X | CV | 傷率 | p_ai_gen | p_ai_edit | ppl | risk | 檔案 |
|---|---|---|---|---|---|---|---|---|---|
${rows(ideal)}

## 早晨清單

1. 看 Balanced 前 3 與 Ideal 前 3 的全文（seeds/）
2. 挑 1–2 個種子 → \`node v6.mjs <原稿> --humanized <seed docx>\` 走修補＋CV 守門，或直接 \`--skip-polish\` 交打包測試
3. 真實認證：打包（含 5.0/6.0 錨點）一次或 solo 一次
4. 結果回填 pipeline/v6-test/calibration.json
`;
  fs.writeFileSync(path.join(outDir, 'evolve.report.md'), md, 'utf8');
  log(`完成：存檔 ${archive.length} 種子，報告 ${path.join(outDir, 'evolve.report.md')}`);
}

main().catch(async (e) => {
  console.error(e.stack || e.message);
  await closeDetector().catch(() => {});
  process.exit(1);
});
