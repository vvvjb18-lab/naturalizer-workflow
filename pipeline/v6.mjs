#!/usr/bin/env node
// v6.mjs — Workflow 7.0: selection pipeline with grammar surgery, paragraph
// crossover, adaptive early-stop, and a persistent detector daemon.
//
//   plan → K candidates (early-stop when one is already in the deliverable
//        zone) → offline scoring (CoLA/tmr/EditLens/ppl via daemon)
//        → grammar surgery (hz regen + duplicate gate)
//        → ranking → paragraph-level crossover → NLI gate
//        → essay: minimal polish · form: deliver A untouched (V2 recipe)
//        → risk card
//
// Usage:
//   node v6.mjs <draft.docx|txt> [--out-dir DIR] [--candidates N] [--skip-polish]
//        [--target balanced|ideal] [--final-name NAME] [--form|--essay]
//        [--no-crossover] [--no-adaptive]

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

import {
  generateCandidate, candidateStats, rankCandidates,
  grammarScores, nliPairs, scoreFiles, closeDetector,
  detectDocType, surgicalRepair, assembleCrossover, shouldStopEarly,
  mechanicalPolish, applyWordBudget, scoreTexts, citationConsistency, cloakNumbers, completeUnit, validateUnit, mechanicalBurstify,
  burstifyCandidate, cvOf,
} from './candidates.mjs';
import { grindParas, rescueContradictions, similarityPolish, styleGuard as styleGuardText, repetitionReorg } from './grind.mjs';
import { createLedger, diffSummary } from './ledger.mjs';
import { evaluateText } from './verify_gates.mjs';
import { classifyDraft, ROUTE_EXIT } from './router.mjs';
import { diagnoseText } from './diagnostics.mjs';
import { buildArgumentMap, skeletonSurvived } from './argument_map.mjs';
import { detectLang, splitSentences, wordCount, tokenSet, jaccard } from '../polish/src/text.mjs';
import { factNumbers, citationsIn } from '../polish/src/checks.mjs';

const HERE = import.meta.dirname;
const PIPELINE = path.resolve(HERE, 'pipeline.mjs');
const DOCX_BRIDGE = path.resolve(HERE, 'docx_bridge.py');

const HELP = `v6.mjs — Workflow 8.0（選擇式管線：早停 × 手術 × 段落重組 × NLI 守門 × 自動研磨 × 字數預算）

用法：node v6.mjs <draft.docx|txt> [選項]

  1. plan              hz planner ＋文件型別偵測
  2. K 候選            自適應早停：已有帶內零傷候選即停；採樣含 0.9/1.1 多樣化
  3. 離線評分          CoLA 語法（每句）＋ tmr/EditLens/perplexity（常駐 daemon）
  4. 語法手術          hz 局部重生成 ＋ 重複句閘門
  5. 選擇＋段落重組     整體排名 → 逐段擇優（黏性 tie-break）→ NLI 守門
  6. 交付              預設 A＋機械標點＋LT 語法層；--polish 才走 API 修補
  7. 風險卡            含重組來源（每段取自哪個候選）與 form 引用/數字檢查

選項：
  --out-dir <dir>      輸出資料夾（預設與原稿同目錄）
  --candidates N       候選數上限（預設 6；早停可能少於此數）
  --target MODE        balanced（預設）｜ideal（衝 <20：傷率帶 0.05–0.2）
  --no-crossover       停用段落重組
  --no-adaptive         停用早停
  --polish             品質優先：A 之後跑 API 最小修補（會升高 Turnitin 風險）
  --no-lt              停用 LanguageTool 確定性語法層
  --final-name N       交付副本檔名（預設 final7.0）
  --form / --essay     強制文件型別
  --no-grind           停用 8.0 自動段級研磨（預設開：gen>0.10 觸發，NLI 守門）
  --max-words N        7.6 字數預算：交付上限 N 詞（刪除優先，超 30% 削幅需 --force-budget）
  --floor-words N      字數下限（作業最少字數；低於即報錯不交付）
  --force-budget       允許超過 30% 的刪減幅度（建議先人工確認內容取捨）
  --style-guide <json> 8.16 風格引導：注入 style_vector.py 的風格向量 JSON
  --seed <txt|json>    8.16 人類種子：語音轉錄 txt（自動抽特徵）或已抽好的 JSON
  --mcts               8.17 MCTS 離散搜索取代 K 候選＋擇優
  --mcts-iterations N  MCTS 迭代數（預設 20，報告建議上限 50）
  --mcts-k N           每次擴展的分支數（預設 3）
  --mcts-generator G   app（12B，預設）｜stub（無 LLM，測試用）
  --mcts-unit U        paragraph（預設）｜sentence（對齊 8.4 句級研磨）
  --zmq                8.17 啟用 ZMQ ROUTER/DEALER 異步評分橋
  --arch90             9.0 分層架構：L0 五狀態路由＋L3 三環否決＋L4 版本帳本＋L1 診斷＋L2 骨架檢查
  --time-budget MIN    9.0 週轉保護：超過 N 分鐘即跳過研磨/查重打磨（增益層），交付最佳已驗證候選
  --shred              8.18 前置粉碎：先用 shredder.py 打散句法（事實守衛）
  --shred-rate R       粉碎觸發率（預設 0.5）
`;

function parseArgs(argv) {
  const out = { _: [], k: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('--')) { out.k[key] = v; i++; }
      else out.k[key] = true;
    } else out._.push(a);
  }
  return out;
}

function runBridge(args) {
  const r = spawnSync('python', [DOCX_BRIDGE, ...args], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`docx_bridge ${args[0]} failed: ${String(r.stderr).slice(0, 400)}`);
  return r.stdout.trim();
}

const LT_FIX = path.resolve(HERE, '..', 'polish', 'lt_fix.py');

function runLtFix(args) {
  const r = spawnSync('python', [LT_FIX, ...args], { encoding: 'utf8', timeout: 300000 });
  if (r.status !== 0) throw new Error(`lt_fix ${args[0]} failed: ${String(r.stderr).slice(0, 400)}`);
  return r.stdout.trim();
}

function fmt(x, digits = 3) {
  return x == null || !Number.isFinite(x) ? '—' : Number(x).toFixed(digits);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args._.length) { console.log(HELP); process.exit(args.help ? 0 : 1); }

  const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'v6.config.json'), 'utf8'));
  if (args.k.target) cfg.target = String(args.k.target);
  if (args.k.candidates) {
    const n = Math.max(1, parseInt(args.k.candidates, 10));
    cfg.candidates = n;
    cfg.samplings = Array.from({ length: n }, () => ({ temperature: 1.0, topP: 0.95 }));
  }
  if (args.k.crossover === false || String(args.k.crossover) === 'false') cfg.crossover = false;
  if (args.k.adaptive === false || String(args.k.adaptive) === 'false') cfg.adaptive = false;
  if (cfg.target === 'ideal') {
    const p = cfg.presets?.ideal || {};
    if (p.grammarThreshold != null) cfg.grammarThreshold = p.grammarThreshold;
    if (p.minGrammarDamage != null) cfg.filters = { ...cfg.filters, minGrammarDamage: p.minGrammarDamage };
    if (p.maxGrammarDamage != null) cfg.filters = { ...cfg.filters, maxGrammarDamage: p.maxGrammarDamage };
    console.log(`目標模式：ideal（手術門檻 ${cfg.grammarThreshold}，殘餘傷率帶 ${cfg.filters.minGrammarDamage}–${cfg.filters.maxGrammarDamage}）`);
  } else {
    const p = cfg.pressets?.balanced || cfg.presets?.balanced || {};
    if (p.grammarThreshold != null) cfg.grammarThreshold = p.grammarThreshold;
  }
  // 8.17 opt-in modes
  const mctsMode = !!args.k.mcts;
  const useShred = !!args.k.shred;
  const arch90 = !!args.k.arch90;
  const timeBudgetMin = args.k['time-budget'] ? Number(args.k['time-budget']) : (arch90 ? 15 : 0); // 9.0: turnaround protection, arch90 default 15min
  const useZmq = !!args.k.zmq;
  const useCrossover = cfg.crossover !== false;
  const useAdaptive = cfg.adaptive !== false;
  const gramThreshold = cfg.grammarThreshold ?? 0.5;

  // 7.6 word budget: config block or CLI flags (CLI wins)
  const wb = { ...(cfg.wordBudget || {}) };
  if (args.k['max-words']) { wb.enabled = true; wb.maxWords = parseInt(args.k['max-words'], 10); }
  if (args.k['floor-words']) wb.floorWords = parseInt(args.k['floor-words'], 10);
  if (args.k['force-budget']) wb.force = true;

  // 8.0 paragraph grind: on by default for essays; --no-grind disables
  const gc = {
    enabled: cfg.grind?.enabled !== false,
    genGate: cfg.grind?.genGate ?? 0.10,
    rounds: cfg.grind?.rounds ?? 3,
    worst: cfg.grind?.worst ?? 3,
    gain: cfg.grind?.gain ?? 0.02,
  };
  if (args.k.grind === false || String(args.k.grind) === 'false') gc.enabled = false;

  const input = path.resolve(args._[0]);
  if (!fs.existsSync(input)) { console.error(`找不到原稿：${input}`); process.exit(1); }
  const T0 = Date.now();
  const ext = path.extname(input).toLowerCase();
  const isDocx = ext === '.docx';
  const outDir = path.resolve(args.k['out-dir'] || path.dirname(input));
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(input, ext);
  const workDir = path.join(outDir, `.v6-${base}`);
  fs.mkdirSync(workDir, { recursive: true });

  // 8.16 opt-in style guidance (default: empty → prompt stays byte-exact)
  let styleGuide = '';
  let styleMeta = null;
  if (args.k['style-guide'] || args.k.seed) {
    try {
      let styleJson;
      if (args.k.seed) {
        const seedPath = path.resolve(String(args.k.seed));
        if (seedPath.toLowerCase().endsWith('.json')) {
          styleJson = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
        } else {
          const outPath = path.join(workDir, 'seed.json');
          const r = spawnSync('python', [path.join(HERE, 'seed_extractor.py'), seedPath, '--out', outPath], { encoding: 'utf8', timeout: 120000 });
          if (r.status !== 0) throw new Error(`seed_extractor: ${String(r.stderr).slice(0, 300)}`);
          styleJson = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        }
      } else {
        styleJson = JSON.parse(fs.readFileSync(path.resolve(String(args.k['style-guide'])), 'utf8'));
      }
      const { buildStyleGuidance } = await import('./prompt_injector.mjs');
      const built = buildStyleGuidance(styleJson);
      styleGuide = built.guide;
      styleMeta = built.meta;
      console.log(`=== 8.16 風格引導（${built.meta.source}，${built.meta.chars} 字元，rhythm μ=${built.meta.mean ?? '—'}）===`);
    } catch (e) {
      throw new Error(`風格引導載入失敗：${e.message}`);
    }
  }

  try {
    // 1 ── plan + doc type ─────────────────────────────────────────────────
    console.log('=== 1/7 規劃（hz planner）===');
    let plan;
    if (isDocx) {
      const planPath = path.join(workDir, 'plan.json');
      console.log(runBridge(['plan', input, planPath]));
      plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    } else {
      const text = fs.readFileSync(input, 'utf8').trim();
      plan = { paragraphs: [text], targets: { 0: { units: [{ id: 1, text }], joiner: ' ' } }, kept: {} };
    }
    // 8.2: titles are never rewritten — hz turns a short title into a glued
    // "Title + invented thesis" line (run9: "The Case ... Beverages Taxing
    // sugary drinks is a good idea."). A target paragraph of ≤9 words with
    // no sentence-ending punctuation and no citations is a title: deliver it
    // untouched.
    const droppedTitles = [];
    const langPre = detectLang(Object.values(plan.targets).map((t) => t.units.map((u) => u.text).join(' ')).join('\n')) === 'zh' ? 'zh' : 'en';
    if (langPre === 'en') {
      const targetKeys = Object.keys(plan.targets);
      for (const i of targetKeys) {
        const t = plan.targets[i].units.map((u) => u.text).join(' ');
        const wc = wordCount(t, 'en');
        const shortTitle = wc <= 14 && !/[.!?]["']?\s*$/.test(t.trim()) && !citationsIn(t).length;
        // 8.6: first paragraph = title + assignment prompt glued ("...which do
        // you think is more efficient?") — hz mangles it; deliver untouched.
        const headerPrompt = i === targetKeys[0] && wc <= 45 && t.includes('?') && !citationsIn(t).length;
        if (shortTitle || headerPrompt) {
          droppedTitles.push(i);
          delete plan.targets[i];
        }
      }
      if (droppedTitles.length) console.log(`  標題保護：${droppedTitles.map((i) => `p${i}`).join(',')} 不改寫`);
    }
    // 8.18: --shred — deterministic dependency-tree perturbation as a PRE step.
    // Runs on plan units (one Python process for the whole document).
    let shredStats = null;
    if (useShred) {
      const units = [];
      for (const [pi, tgt] of Object.entries(plan.targets)) {
        for (const u of tgt.units) units.push({ id: `${pi}:${u.id}`, text: u.text });
      }
      const inPath = path.join(workDir, 'shred-in.json');
      const outPath = path.join(workDir, 'shred-out.json');
      fs.writeFileSync(inPath, JSON.stringify({ units, rate: Number(args.k['shred-rate'] ?? 0.5) }), 'utf8');
      console.log('=== 8.18 前置粉碎（shredder.py，事實守衛開啟）===');
      const r = spawnSync('python', [path.join(HERE, 'shred_batch.py'), inPath, outPath,
        '--rate', String(args.k['shred-rate'] ?? 0.5)], { encoding: 'utf8', timeout: 300000 });
      if (r.status !== 0) throw new Error(`shred_batch failed: ${String(r.stderr).slice(0, 300)}`);
      const sd = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      const byId = new Map(sd.units.map((u) => [u.id, u.text]));
      for (const [pi, tgt] of Object.entries(plan.targets)) {
        for (const u of tgt.units) {
          const v = byId.get(`${pi}:${u.id}`);
          if (typeof v === 'string' && v.trim()) u.text = v;
        }
      }
      shredStats = { ...sd.stats, fact_loss: sd.fact_loss };
      console.log(`  粉碎完成：${sd.stats.ops_total} ops（voice ${sd.stats.ops.voice}／split ${sd.stats.ops.split}／`
        + `merge ${sd.stats.ops.merge}／reorder ${sd.stats.ops.reorder}）· CV ${sd.stats.cv_before} → ${sd.stats.cv_after}`
        + ` · 事實丟失 ${sd.fact_loss}`);
    }

    const targetIdx = Object.keys(plan.targets);
    if (!targetIdx.length) throw new Error('plan 沒有可改寫的段落（全是標題／引用／短段？）');
    const originalsByPara = {};
    for (const i of targetIdx) originalsByPara[i] = plan.targets[i].units.map((u) => u.text).join(' ');
    let originalProse = targetIdx.map((i) => originalsByPara[i]).join('\n\n');
    fs.writeFileSync(path.join(workDir, 'original.prose.txt'), originalProse + '\n', 'utf8');
    const lang = detectLang(originalProse) === 'zh' ? 'zh' : 'en';
    const docType = detectDocType(plan);
    if (args.k.form) docType.form = true;
    if (args.k.essay) docType.form = false;
    const unitTotal = Object.values(plan.targets).reduce((n, t) => n + t.units.length, 0);
    console.log(`  ${targetIdx.length} 段 · ${unitTotal} unit · lang=${lang}`);
    console.log(`  文件型別：${docType.form ? 'form／模板（V2 配方）' : 'essay（CV 帶選擇）'}（label 率 ${fmt(docType.formScore, 2)}）`);

    // 9.0 arch90 — L4 帳本建立＋L0 路由（文本期：S5 停改令／S3 警告）
    let ledger = null, route = null, archFullText = null, archOrigCv = null;
    if (arch90) {
      ledger = createLedger(workDir, { docId: base });
      archFullText = Array.isArray(plan.paragraphs) && plan.paragraphs.length
        ? plan.paragraphs.map((p) => String(p || '')).join('\n\n')
        : originalProse;
      archOrigCv = cvOf(originalProse, lang);
      ledger.append({ stage: 'original', before: archFullText, after: originalProse, verdict: { pass: true, vetoes: [], dimensions: {} }, meta: { note: '原稿入帳（回退基準）' } });
      route = classifyDraft({ text: archFullText, gen: null, cv: archOrigCv, lang });
      console.log(`  9.0 路由（文本期）：${route.state} —— ${route.advice}`);
      if (route.state === 'S5') {
        ledger.append({ stage: 'route', before: archFullText, after: archFullText, verdict: { pass: false, vetoes: [{ ring: 0, rule: 'routeS5', detail: route.advice }], dimensions: {} } });
        console.error(`9.0 停改令（S5）：${route.advice}`);
        await closeDetector().catch(() => {});
        process.exit(ROUTE_EXIT.S5);
      }
      if (route.state === 'S3') console.log('  ⚠ S3：論證骨架將於交付時檢查（L2 重組本版僅記錄）');
    }
    // 9.0 S3 前置去重（確定性，零模型）：重複論證文檔會讓 hz 輸出自帶重複句
    // 而被單元驗證器整體殺死（實測 repeats-a-sentence 全滅）——先在 plan 層
    // 刪近重複句（token containment ≥0.85 保首個），重建事實基準。重複句不
    // 攜帶獨有事實，validateUnit 依然成立。ROADMAP：「先重組論證，再進語言處理」。
    if (arch90 && route?.state === 'S3') {
      let removed = 0;
      for (const t of Object.values(plan.targets)) {
        for (const u of t.units) {
          const sents = splitSentences(u.text, lang);
          const kept = [], sets = [];
          for (const s of sents) {
            const ts = tokenSet(s.text, lang);
            const dup = ts.size && sets.some((k) => { let inter = 0; for (const w of ts) if (k.has(w)) inter++; return inter / ts.size >= 0.85; });
            if (dup) { removed++; continue; }
            kept.push(s.text); sets.push(ts);
          }
          if (kept.length !== sents.length) u.text = kept.join(' ');
        }
      }
      if (removed) {
        for (const i of targetIdx) originalsByPara[i] = plan.targets[i].units.map((u) => u.text).join(' ');
        originalProse = targetIdx.map((i) => originalsByPara[i]).join('\n\n');
        fs.writeFileSync(path.join(workDir, 'original.prose.txt'), originalProse + '\n', 'utf8');
        archOrigCv = cvOf(originalProse, lang);
        ledger?.append({ stage: 's3-dedupe', before: archFullText, after: originalProse, verdict: { pass: true, vetoes: [], dimensions: {} }, meta: { removedSentences: removed } });
        console.log(`  9.0 S3 前置去重：移除 ${removed} 個重複句，事實基準已重建`);
      }
    }

    // sentence-level memo on the warm daemon
    const sentMemo = new Map();
    const scoreSents = async (sents) => {
      const idx = [];
      const missing = [];
      for (const s of sents) {
        if (sentMemo.has(s)) idx.push(sentMemo.get(s));
        else { idx.push(null); missing.push(s); }
      }
      if (missing.length) {
        const got = await grammarScores(missing);
        missing.forEach((s, i) => sentMemo.set(s, got[i]));
        for (let i = 0, j = 0; i < idx.length; i++) if (idx[i] === null) idx[i] = got[j++];
      }
      return idx;
    };

    // 8.7: document profile at plan time — one daemon call decides the whole
    // run's shape. Extreme docs (original ≈ pure LM) skip the candidate
    // ceremony: 3 candidates, sentence-mode-first grind, convergence stop.
    // This is the runtime budget for the 99% self-service flow.
    const tProfile0 = Date.now();
    const [origProfile] = await scoreTexts([originalProse]);
    const profile = {
      gen: origProfile?.p_ai_gen ?? null,
      extreme: (origProfile?.p_ai_gen ?? 0) > 0.8,
      mid: (origProfile?.p_ai_gen ?? 0) > 0.4 && (origProfile?.p_ai_gen ?? 0) <= 0.8,
    };
    let candidatesN = cfg.candidates;
    // 9.0 arch90 — L0 路由（評分期：S4 退回作者／S1 保守編輯）
    if (arch90) {
      route = classifyDraft({ text: archFullText, gen: profile.gen, cv: archOrigCv, lang });
      console.log(`  9.0 路由（評分期）：${route.state} —— ${route.advice}`);
      if (route.state === 'S4') {
        ledger.append({ stage: 'route', before: archFullText, after: archFullText, verdict: { pass: false, vetoes: [{ ring: 0, rule: 'routeS4', detail: route.advice }], dimensions: {} } });
        console.error(`9.0 停改令（S4）：${route.advice}`);
        await closeDetector().catch(() => {});
        process.exit(ROUTE_EXIT.S4);
      }
      if (route.state === 'S1') {
        console.log('=== 9.0 路由：S1 保守編輯（跳過候選生成）===');
        const parasC = {};
        for (const i of targetIdx) parasC[i] = mechanicalPolish(originalsByPara[i], lang);
        if (isDocx && !args.k['no-lt']) {
          try {
            const ltIn = path.join(workDir, 'ltmap-in.json'), ltOut = path.join(workDir, 'ltmap-out.json');
            fs.writeFileSync(ltIn, JSON.stringify({ indices: targetIdx.map(Number), texts: targetIdx.map((i) => parasC[i]) }), 'utf8');
            runLtFix(['fixmap', ltIn, ltOut, lang === 'zh' ? 'zh' : 'en-GB']);
            if (fs.existsSync(ltOut)) {
              const fm = JSON.parse(fs.readFileSync(ltOut, 'utf8'));
              (fm.texts || []).forEach((t, j) => { if (targetIdx[j] != null) parasC[targetIdx[j]] = t; });
            }
          } catch (e) { console.log(`  LT 跳過：${e.message.slice(0, 60)}`); }
        }
        const proseC = targetIdx.map((i) => parasC[i]).filter(Boolean).join('\n\n');
        const [scC] = await scoreTexts([proseC]);
        const vC = evaluateText({ draft: originalProse, prose: proseC, lang, cvDraft: archOrigCv, cvProse: candidateStats({ originalProse, prose: proseC, lang }).cv });
        ledger.append({ stage: 'conservative-delivery', before: originalProse, after: proseC, checks: { score: scC }, verdict: vC, meta: { route: 'S1', paras: parasC } });
        fs.writeFileSync(path.join(outDir, `${base}.v6-A.prose.txt`), proseC + '\n', 'utf8');
        if (isDocx) {
          const mapPath = path.join(workDir, 'amap.json');
          fs.writeFileSync(mapPath, JSON.stringify({ indices: targetIdx.map(Number), texts: targetIdx.map((i) => parasC[i]) }), 'utf8');
          console.log(runBridge(['apply', input, mapPath, path.join(outDir, `${base}.v6-A.docx`)]));
        }
        const dC = diffSummary(originalProse, proseC, lang);
        fs.writeFileSync(path.join(outDir, `${base}.v6.report.md`), `# 9.0 S1 保守編輯風險卡\n\n- 路由：**S1**（論證完整、語言可信：gen=${fmt(profile.gen)} · CV=${fmt(archOrigCv, 3)}）\n- 干預：機械標點＋LT 層；**不進候選生成、不研磨**\n- 改動：${dC.words.before} → ${dC.words.after} 詞（句 ${dC.sentences.before} → ${dC.sentences.after}，改寫 ${dC.changed}／新增 ${dC.added}／丟失 ${dC.removed}）\n- 三環否決：${vC.pass ? '全綠 ✓' : JSON.stringify(vC.vetoes)}\n- 帳本：${ledger.file}\n`);
        console.log(`  S1 交付完成：改動 ${dC.words.before} → ${dC.words.after} 詞，否決環 ${vC.pass ? '全綠' : '有否決（見報告）'}`);
        await closeDetector().catch(() => {});
        process.exit(vC.pass ? 0 : 2);
      }
    }
    if (profile.extreme) {
      candidatesN = Math.min(cfg.candidates, cfg.extremePath?.candidates ?? 4);
      cfg.grind = { ...cfg.grind, roundsExtreme: cfg.extremePath?.rounds ?? 15 };
      console.log(`  文檔畫像：極端（原稿 gen ${fmt(profile.gen, 2)}）→ 極速路徑（${candidatesN} 候選、句級優先研磨 15 輪、收斂即停）`);
    } else if (profile.mid) {
      candidatesN = Math.min(cfg.candidates, cfg.extremePath?.candidatesMid ?? 4);
      console.log(`  文檔畫像：中度（原稿 gen ${fmt(profile.gen, 2)}）→ 4 候選`);
    }
    profile.elapsedMs = Date.now() - tProfile0;

    // per-paragraph stats for crossover (uses memo → cheap)
    const paraStatsFor = async (cands) => {
      const out = {};
      for (const c of cands) {
        for (const [pi, text] of Object.entries(c.paras || {})) {
          const sents = splitSentences(text, lang).map((s) => s.text);
          const sc = await scoreSents(sents);
          const damaged = sc.filter((p) => p < gramThreshold).length;
          const lens = sents.map((s) => wordCount(s, lang));
          const mean = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
          const va = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, lens.length);
          const e = (out[pi] ||= []);
          e.push({ candId: c.id, damage: sents.length ? damaged / sents.length : 0, damaged, sentCount: sents.length, cv: mean > 0 ? Math.sqrt(va) / mean : 0 });
        }
      }
      return out;
    };
    const damageOf = async (prose) => {
      const sents = splitSentences(prose, lang).map((s) => s.text);
      if (!sents.length) return 0;
      const sc = await scoreSents(sents);
      return sc.filter((p) => p < gramThreshold).length / sents.length;
    };

    // 8.17: --mcts — run the CPU discrete search instead of K candidates.
    const runMctsMode = async ({ iterations }) => {
      const planPath = path.join(workDir, 'mcts-plan.json');
      const targets = {};
      for (const i of targetIdx) targets[i] = { units: plan.targets[i].units, joiner: plan.targets[i].joiner || ' ' };
      fs.writeFileSync(planPath, JSON.stringify({ targets }), 'utf8');
      const mctsOut = path.join(workDir, 'mcts-result.json');
      const argv = [path.join(HERE, 'mcts_searcher.py'), '--plan', planPath, '--out', mctsOut,
        '--iterations', String(iterations), '--generator', String(args.k['mcts-generator'] || 'app')];
      if (useZmq) argv.push('--zmq');
      const unit = String(args.k['mcts-unit'] || 'paragraph');
      argv.push('--unit', unit);
      console.log(`=== 8.17 MCTS 搜索（${iterations} 迭代，k=${args.k['mcts-k'] || 3}，generator=${args.k['mcts-generator'] || 'app'}${useZmq ? '，ZMQ' : ''}）===`);
      const code = await new Promise((resolve) => {
        const child = spawn(process.execPath === '' ? 'python' : 'python', argv, { cwd: HERE, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const fwd = (s) => { let b = ''; s.on('data', (c) => { b += c.toString('utf8'); const ls = b.split(/\r?\n/); b = ls.pop(); for (const l of ls) if (l.trim()) console.log(`  ${l}`); }); };
        fwd(child.stdout); fwd(child.stderr);
        child.on('error', (e) => { console.error(String(e.message)); resolve(1); });
        child.on('close', (c) => resolve(c ?? 1));
      });
      if (code !== 0) throw new Error(`mcts_searcher exited ${code}`);
      const res = JSON.parse(fs.readFileSync(mctsOut, 'utf8'));
      const paras = {};
      targetIdx.forEach((i, j) => { paras[i] = res.paras[j]; });
      const prose = targetIdx.map((i) => paras[i]).filter(Boolean).join("\n\n");
      const prosePath = path.join(workDir, 'candMCTS.prose.txt');
      fs.writeFileSync(prosePath, prose + "\n", 'utf8');
      const stats = candidateStats({ originalProse, prose, lang });
      stats.coverage = 1;
      const [sc] = await scoreTexts([prose]);
      const dmg = await damageOf(prose);
      const [origSc] = await scoreTexts([originalProse]);
      const node = {
        id: 'MCTS', crossover: false, paras, prose, prosePath, stats, score: sc,
        grammarDamage: dmg, grammarDamagePre: dmg, surgeries: [], failures: [],
        mcts: { iterations: res.iterations, visited: res.visited, elapsed_s: res.elapsed_s,
                reward: res.score?.reward, root_reward: res.root_score?.reward,
                median_iter_ms: res.per_iter_ms ? res.per_iter_ms.slice().sort((a, b) => a - b)[Math.floor(res.per_iter_ms.length / 2)] : null,
                generator: res.generator, unit: res.unit, rejected: res.tree?.rejected },
      };
      console.log(`  MCTS 完成：reward ${fmt(res.root_score?.reward)} → ${fmt(res.score?.reward)} · `
        + `gen ${fmt(sc?.p_ai_gen)} · CV ${fmt(stats.cv)} · ${res.elapsed_s}s（${node.mcts.median_iter_ms} ms/iter 中位）`);
      return { chosen: node, originalScore: origSc || null, origDamage: await damageOf(originalProse) };
    };

    // 2 ── generate candidates (adaptive early-stop) ───────────────────────
    // 8.17: --mcts replaces the K-candidate + selection logic. Containers are
    // declared here so the reporting section works in both modes.
    const candidates = [];
    let chosen = null;
    let pool = [];
    let assembled = null;
    let eligible = [];
    let rejected = [];
    let originalScore = null;
    let origDamage = 0;
    let bandFallback = null;
    if (mctsMode) {
      const iters = Math.max(1, parseInt(args.k['mcts-iterations'] ?? cfg.mcts?.iterations ?? 20, 10));
      ({ chosen, originalScore, origDamage } = await runMctsMode({ iterations: iters }));
      pool = [chosen];
      eligible = [chosen];
    } else {
    console.log(`=== 2/7 候選生成（K≤${candidatesN}${useAdaptive ? `，先 ${cfg.adaptiveFirst ?? 3} 個早停` : ''}）===`);
    const stopCheck = async () => !useAdaptive
      ? false
      : candidates.length >= (cfg.adaptiveFirst ?? 3)
        && shouldStopEarly(candidates, { formMode: docType.form, target: cfg.target, cvBand: cfg.filters.cvBand, genGate: gc.genGate });
    for (let k = 0; k < candidatesN; k++) {
      const sampling = cfg.samplings[k] || { temperature: 1.0, topP: 0.95 };
      console.log(`  candidate ${k + 1}/${cfg.candidates} (temp ${sampling.temperature}, top_p ${sampling.topP})`);
      const gen = await generateCandidate({
        plan, sampling, retries: cfg.unitRetries ?? 2, lang, styleGuide,
        log: (m) => console.log(`    ${m}`),
      });
      const prose = Object.keys(gen.paras).length
        ? targetIdx.map((i) => gen.paras[i]).filter(Boolean).join('\n\n')
        : '';
      const prosePath = path.join(workDir, `cand${k + 1}.prose.txt`);
      fs.writeFileSync(prosePath, prose + '\n', 'utf8');
      const stats = candidateStats({ originalProse, prose, lang });
      stats.coverage = gen.coverage;
      const c = { id: k + 1, sampling, prosePath, prose, stats, failures: gen.failures, paras: gen.paras };
      c.grammarDamagePre = await damageOf(prose);
      // 8.1: score during generation so the early-stop can gate on gen
      const [earlyScore] = await scoreTexts([prose]);
      if (earlyScore) c.score = earlyScore;
      candidates.push(c);
      console.log(`    coverage=${(gen.coverage * 100).toFixed(0)}% sents ${stats.sentencesBefore}->${stats.sentencesAfter} CV=${fmt(stats.cv, 3)} (x${fmt(stats.cvRatio, 2)}) damagePre=${fmt(c.grammarDamagePre)} copy=${fmt(stats.copyRate, 2)}${gen.failures.length ? ' FAIL: ' + gen.failures.map((f) => f.reason).join('; ') : ''}`);
      if (await stopCheck()) {
        console.log(`  早停：已有 ${candidates.length} 個候選且至少一個落在可交付區，跳過剩餘生成`);
        break;
      }
    }

    // 3 ── offline scoring ─────────────────────────────────────────────────
    console.log('=== 3/7 離線評分（daemon：CoLA + tmr/EditLens/perplexity）===');
    origDamage = await damageOf(originalProse);
    const scores = await scoreFiles([...candidates.map((c) => c.prosePath), path.join(workDir, 'original.prose.txt')]);
    originalScore = scores[scores.length - 1];
    for (const s of scores.slice(0, -1)) {
      const c = candidates.find((x) => path.resolve(x.prosePath) === path.resolve(s.file));
      if (c) c.score = s;
    }
    for (const c of candidates) {
      console.log(`  cand${c.id}: damagePre=${fmt(c.grammarDamagePre)} CV=${fmt(c.stats.cv, 3)} ppl=${fmt(c.score?.perplexity, 1)} gen=${fmt(c.score?.p_ai_gen)} edit=${fmt(c.score?.p_ai_edit)} | 原稿 damage=${fmt(origDamage)} gen=${fmt(originalScore?.p_ai_gen)}`);
    }

    // 4 ── grammar surgery ─────────────────────────────────────────────────
    console.log('=== 4/7 語法手術（hz 局部重生成 + 重複句閘門）===');
    const dropThreshold = cfg.grammarDamageDrop ?? 0.3;
    for (const c of candidates) {
      if (c.grammarDamagePre > dropThreshold) {
        console.log(`  cand${c.id} 跳過手術（damagePre ${fmt(c.grammarDamagePre)} > ${dropThreshold}）`);
        c.grammarDamage = c.grammarDamagePre;
        c.surgeries = [];
        continue;
      }
      if (c.grammarDamagePre === 0) {
        console.log(`  cand${c.id} 無受傷句`);
        c.grammarDamage = 0;
        c.surgeries = [];
        continue;
      }
      let repaired = null;
      try {
        repaired = await surgicalRepair({
          paras: c.paras, originalsByPara, lang, cfg: { ...cfg, grammarThreshold: gramThreshold },
          scorer: scoreSents, log: (m) => console.log(`    cand${c.id} ${m}`),
        });
      } catch (e) {
        console.log(`  cand${c.id} 手術中斷（${e.message}）→ 保留未手術版本繼續`);
        c.grammarDamage = c.grammarDamagePre;
        c.surgeries = [];
        continue;
      }
      c.paras = repaired.paras;
      c.surgeries = repaired.surgeries;
      c.prose = targetIdx.map((i) => c.paras[i]).filter(Boolean).join('\n\n');
      const newStats = candidateStats({ originalProse, prose: c.prose, lang });
      newStats.coverage = c.stats.coverage;
      c.stats = newStats;
      const totalSents = splitSentences(c.prose, lang).length;
      c.grammarDamage = totalSents ? repaired.residualDamaged / totalSents : 0;
      fs.writeFileSync(path.join(workDir, `cand${c.id}.repaired.prose.txt`), c.prose + '\n', 'utf8');
      console.log(`  cand${c.id} 手術 ${repaired.surgeries.length} 處，殘餘 damage=${fmt(c.grammarDamage)}，術後 CV=${fmt(newStats.cv, 3)}`);
    }

    // 5 ── ranking → crossover → NLI gate ─────────────────────────────────
    console.log('=== 5/7 選擇 + 段落重組 + NLI 守門 ===');
    let { eligible, rejected } = rankCandidates(candidates, {
      weights: cfg.weights,
      filters: { ...cfg.filters, formMode: docType.form },
    });
    rejected.forEach((c) => console.log(`  cand${c.id} 淘汰（damage=${fmt(c.grammarDamage)} CV=${fmt(c.stats.cv)} cvRatio=${fmt(c.stats.cvRatio, 2)} coverage=${fmt(c.stats.coverage, 2)}）`));
    rejected.forEach((c) => console.log(`  cand${c.id} 淘汰（damage=${fmt(c.grammarDamage)} CV=${fmt(c.stats.cv)} cvRatio=${fmt(c.stats.cvRatio, 2)} coverage=${fmt(c.stats.coverage, 2)}）`));

    // 8.3: flat document family — every candidate culled ONLY by the CV band
    // floor (their original CV sits far below the E2-calibrated 0.45). Two
    // rescue stages before giving up: (a) burstiness rebuild on the two best
    // rejected candidates, re-rank; (b) still nothing → deliver the best
    // available with a loud uncalibrated-band warning instead of dying.
    bandFallback = null;
    if (!eligible.length && !docType.form && cfg.lowCvFallback?.enabled !== false) {
      const bandLo = (cfg.filters?.cvBand?.[0] ?? 0.45) * 0.9;
      const bandCulled = rejected.filter((c) => (c.stats?.coverage ?? 0) >= 1
        && (c.grammarDamage ?? 1) <= (cfg.filters?.maxGrammarDamage ?? 0.08)
        && (c.stats?.cv ?? 0) > 0 && c.stats.cv < bandLo);
      if (bandCulled.length === rejected.length && bandCulled.length) {
        console.log(`⚠ 全部候選 CV < ${fmt(bandLo, 3)}——此文檔族（原稿 CV ${fmt(cvOf(originalProse, lang), 3)}）低於 E2 校準帶，啟動 burstiness 重造（8.3）`);
        const seeds = [...bandCulled].sort((a, b) => (a.score?.p_ai_gen ?? 1) - (b.score?.p_ai_gen ?? 1)).slice(0, 2);
        for (let bi = 0; bi < seeds.length; bi++) {
          const seed = seeds[bi];
          console.log(`  burstify 自 cand${seed.id}（gen ${fmt(seed.score?.p_ai_gen)}）`);
          const { paras: burst, moves } = await burstifyCandidate({
            c: seed, originalsByPara, targetIdx, lang,
            rounds: cfg.lowCvFallback?.rounds ?? 2, worst: cfg.lowCvFallback?.worst ?? 3,
            log: (m) => console.log(`    ${m}`),
          });
          seed.paras = burst;
          seed.prose = targetIdx.map((i) => burst[i]).filter(Boolean).join('\n\n');
          const st = candidateStats({ originalProse, prose: seed.prose, lang });
          st.coverage = seed.stats.coverage;
          seed.stats = st;
          seed.grammarDamage = await damageOf(seed.prose);
          const [bs] = await scoreTexts([seed.prose]);
          if (bs) seed.score = { ...seed.score, ...bs };
          fs.writeFileSync(path.join(workDir, `cand${seed.id}.burst.prose.txt`), seed.prose + '\n', 'utf8');
          console.log(`  cand${seed.id} burst 後：CV ${fmt(st.cv, 3)} gen ${fmt(seed.score?.p_ai_gen)} damage ${fmt(seed.grammarDamage)}（${moves.length} 段重造）`);
        }
        ({ eligible, rejected } = rankCandidates(pool, { weights: cfg.weights, filters: { ...cfg.filters, formMode: docType.form } }));
      }
    }
    if (!eligible.length) {
      // deliver-with-warning: best rejected = full coverage, clean, lowest gen
      const fallbackPool = rejected.filter((c) => (c.stats?.coverage ?? 0) >= 1 && (c.grammarDamage ?? 1) <= (cfg.filters?.maxGrammarDamage ?? 0.08));
      if (fallbackPool.length && !docType.form && cfg.lowCvFallback?.deliver !== false) {
        chosen = fallbackPool.sort((a, b) => (a.score?.p_ai_gen ?? 1) - (b.score?.p_ai_gen ?? 1))[0];
        bandFallback = {
          cv: chosen.stats.cv, band: cfg.filters?.cvBand ?? [0.45, 0.65],
          reason: 'CV 低於交付線 0.5（九點校準：CV<0.37 實測 41-98%）——burstify 後仍不足',
        };
        console.log(`⚠ 帶外交付：選 CV/分數最佳的 cand${chosen.id}（CV ${fmt(chosen.stats.cv, 3)} gen ${fmt(chosen.score?.p_ai_gen)}）——此文檔族的 CV 帶未經 Turnitin 校準，交付前請知悉風險`);
      } else if (arch90) {
        // 9.0: even hard filters killed everything — the ledger #0 (deduped
        // original) is deterministic-green by definition; deliver it and let
        // the delivery verdict + risk card speak.
        chosen = { id: 'orig', paras: { ...originalsByPara }, prose: originalProse, stats: candidateStats({ originalProse, prose: originalProse, lang }), score: originalScore, grammarDamage: 0, surgeries: [], failures: [], archFrozen: true };
        console.log(`⚠ 9.0：無候選通過硬過濾——以去重後原稿交付（帳本 #0）`);
      } else {
        throw new Error('沒有候選通過硬過濾；提高 --candidates 或放寬 v6.config.json');
      }
    }

    if (!chosen) {
      // 9.0 arch90 — L3 否決環：第一/二環（內容正確性＋格式）一票否決，
      // 在 NLI 守門之前過濾；第三環品質維度只記錄不否決。
      if (arch90 && eligible.length) {
        for (const c of eligible) {
          c.archVerdict = evaluateText({ draft: originalProse, prose: c.prose, lang, nli: null, cvDraft: archOrigCv, cvProse: c.stats?.cv, paragraphs: plan.paragraphs });
          ledger.append({ stage: 'candidate', label: `cand${c.id}`, before: originalProse, after: c.prose, checks: { score: c.score, stats: c.stats }, verdict: c.archVerdict, meta: { paras: c.paras, risk: c.risk ?? null } });
        }
        const vetoFree = eligible.filter((c) => c.archVerdict.pass);
        if (vetoFree.length < eligible.length) console.log(`  9.0 否決制：${eligible.length - vetoFree.length} 個候選被第一/二環否決（${eligible.filter((c) => !c.archVerdict.pass).map((c) => `cand${c.id}:${c.archVerdict.vetoes[0].rule}`).join('、')}）`);
        if (vetoFree.length) eligible = vetoFree;
        else console.log('  ⚠ 9.0：全部候選被否決——保留原排名續走 NLI，交付前最終否決會回退原稿');
      }
      if (useCrossover) {
      const poolOk = candidates.filter((c) => (c.stats?.coverage ?? 0) >= 1);
      if (poolOk.length >= 2) {
        const rankAll = rankCandidates(candidates, { weights: cfg.weights, filters: { ...cfg.filters, formMode: docType.form } });
        const paraStats = await paraStatsFor(poolOk);
        const xo = assembleCrossover({ cands: poolOk, paraStats, cvBand: cfg.filters.cvBand });
        const prose = targetIdx.map((i) => xo.paras[i]).filter(Boolean).join('\n\n');
        const stats = candidateStats({ originalProse, prose, lang });
        stats.coverage = 1;
        const dmg = Object.entries(xo.provenance).reduce((n, [pi, candId]) => {
          const st = paraStats[pi].find((x) => x.candId === candId);
          return n + (st ? st.damaged : 0);
        }, 0);
        const totalSents = splitSentences(prose, lang).length;
        const scored = await import('./detector_client.mjs').then((m) => m.scoreTexts([prose]));
        assembled = {
          id: 'X', crossover: true, provenance: xo.provenance,
          paras: xo.paras, prose,
          prosePath: path.join(workDir, 'candX.prose.txt'),
          stats, grammarDamage: totalSents ? dmg / totalSents : 0,
          grammarDamagePre: null, surgeries: 0, failures: [],
          score: scored[0],
        };
        fs.writeFileSync(assembled.prosePath, prose + '\n', 'utf8');
        // 9.0: the X must pass the same ring-1/2 as candidates — a structurally
        // polluted crossover is dropped here instead of at delivery time.
        if (arch90) {
          const xv = evaluateText({ draft: originalProse, prose, lang, cvDraft: archOrigCv, cvProse: stats?.cv, paragraphs: plan.paragraphs });
          if (!xv.pass) {
            console.log(`  ⚠ 9.0：重組 X 未過否決環（${xv.vetoes.map((v) => v.rule).join('、')}）——本次不採用 X`);
            pool = [...candidates];
            assembled = null;
          } else {
            pool = [...candidates, assembled];
          }
        } else {
          pool = [...candidates, assembled];
        }
        const froms = Object.values(xo.provenance).join(',');
        console.log(`  重組 X：逐段取自 cand{${froms}} · CV=${fmt(stats.cv, 3)} damage=${fmt(assembled.grammarDamage)}`);
      } else {
        console.log('  重組跳過（可用候選 < 2）');
      }
    }

    ({ eligible, rejected } = rankCandidates(pool, { weights: cfg.weights, filters: { ...cfg.filters, formMode: docType.form } }));

    // 8.2: evaluate every eligible candidate (NLI + rescues), then choose by
    // risk with a ppl tie-break — among equal-risk candidates the higher
    // perplexity one uses less stock phrasing, the offline proxy for Turnitin
    // similarity (13% @ ppl 30.5 vs 22% @ ppl 24.9, E2 family).
    const minEntail = cfg.filters?.minEntail ?? 0.6;
    const passing = [];
    const nliFallback = [];   // 9.0: deterministic-green candidates NLI killed — L3 hierarchy fallback
    for (const c of eligible) {
      const cid = c.crossover ? '重組X' : `cand${c.id}`;
      // 9.0: tiny docs — the cross-encoder is unreliable on short paragraph
      // pairs (3-sentence essays false-kill every candidate); evaluateText's
      // deterministic rings carry the load instead.
      if (arch90 && splitSentences(originalProse, lang).length < 6) {
        c.nli = null;
        console.log(`  ${cid} NLI 跳過（短文檔 <6 句，9.0 由否決環把關）`);
        passing.push(c);
        continue;
      }
      if (lang === 'zh') {
        // NLI cross-encoder is English-only: on zh input it returns garbage
        // entailment scores and blocks clean candidates (C4 lesson).
        c.nli = null;
        console.log('  zh 文稿：NLI 守門跳過（英文模型不適用）');
        passing.push(c);
        continue;
      }
      const pairs = targetIdx.map((i) => [originalsByPara[i], c.paras[i] || '']);
      let nli = null;
      try {
        nli = await nliPairs(pairs);
      } catch (e) {
        console.log(`  ${cid} NLI 失敗（${e.message}），跳過守門`);
        c.nli = null;
        passing.push(c);
        continue;
      }
      const worst = nli.reduce((a, b) => (b.contradict > a.contradict ? b : a), { contradict: 0 });
      c.nli = { maxContradict: worst.contradict, meanEntail: nli.reduce((a, b) => a + (b.entail || 0), 0) / Math.max(1, nli.length) };
      console.log(`  ${cid} risk=${fmt(c.risk)} NLI: maxContradict=${fmt(worst.contradict)} meanEntail=${fmt(c.nli.meanEntail)}`);
      const badContradict = nli.map((x, j) => ({ x, j })).filter((o) => o.x.contradict > 0.5).map((o) => o.j);
      const badEntail = nli.map((x, j) => ({ x, j })).filter((o) => (o.x.entail ?? 1) < minEntail).map((o) => o.j);
      if (badContradict.length || badEntail.length) {
        // 8.1/8.2: targeted rescue — regen only the offending paragraphs
        // (contradiction or content loss), then re-verify the whole candidate.
        const badIdx = [...new Set([...badContradict, ...badEntail])];
        const badNames = badIdx.map((j) => `p${targetIdx[j]}${badContradict.includes(j) ? '(矛盾)' : '(內容損失)'}`).join(',');
        console.log(`  ${cid} NLI 未過（${badNames}）→ 定向重生重試`);
        const origParasR = targetIdx.map((i) => originalsByPara[i] || '');
        const parasR = targetIdx.map((i) => c.paras[i] || originalsByPara[i] || '');
        const { paras: rescued, fixed } = await rescueContradictions({
          origParas: origParasR, paras: parasR, badIdx, lang, minEntail,
          log: (m) => console.log(`    ${m}`),
        });
        if (Object.keys(fixed).length === badIdx.length) {
          const nli2 = await nliPairs(targetIdx.map((_, j) => [origParasR[j], rescued[j]]));
          const worst2 = nli2.reduce((a, b) => (b.contradict > a.contradict ? b : a), { contradict: 0 });
          const weak2 = nli2.some((x) => (x.entail ?? 1) < minEntail);
          if (worst2.contradict <= 0.5 && !weak2) {
            targetIdx.forEach((i, j) => { c.paras[i] = rescued[j]; });
            c.prose = targetIdx.map((i) => c.paras[i]).filter(Boolean).join('\n\n');
            const newStats = candidateStats({ originalProse, prose: c.prose, lang });
            newStats.coverage = c.stats.coverage;
            c.stats = newStats;
            c.grammarDamage = await damageOf(c.prose);
            const [rs] = await scoreTexts([c.prose]);
            if (rs) c.score = { ...c.score, p_ai_gen: rs.p_ai_gen, p_ai_edit: rs.p_ai_edit, perplexity: rs.perplexity };
            c.nli = { maxContradict: worst2.contradict, meanEntail: nli2.reduce((a, b) => a + (b.entail || 0), 0) / Math.max(1, nli2.length) };
            c.rescued = badIdx.map((j) => targetIdx[j]);
            console.log(`  ${cid} 救援成功：maxContradict ${fmt(worst.contradict)} → ${fmt(worst2.contradict)}，gen=${fmt(c.score?.p_ai_gen)}`);
            passing.push(c);
            continue;
          }
          console.log(`  ${cid} 救援後仍未過（maxContradict ${fmt(worst2.contradict)}），淘汰`);
        } else {
          console.log(`  ${cid} 救援未修復全部問題段，淘汰`);
        }
        if (arch90 && c.archVerdict?.pass) nliFallback.push(c);
        continue;
      }
      passing.push(c);
    }
    if (!passing.length && nliFallback.length) {
      console.log('  ⚠ 9.0：NLI 擋下全部候選，但確定性否決環全綠——按 L3 階層採用（NLI 矛盾保留在風險卡為警示）');
      passing.push(...nliFallback);
    }
    if (!passing.length) {
      if (arch90) {
        console.log('  ⚠ 9.0：無候選通過（硬過濾/否決環/NLI）——以去重後原稿交付（帳本 #0 為最後綠點）');
        chosen = { id: 'orig', paras: { ...originalsByPara }, prose: originalProse, stats: candidateStats({ originalProse, prose: originalProse, lang }), score: originalScore, grammarDamage: 0, surgeries: [], failures: [], archFrozen: true };
      } else throw new Error('所有 eligible 候選都被 NLI 擋下');
    } else {
      passing.sort((a, b) => a.risk - b.risk);
      const bestRisk = passing[0];
      const tie = passing.filter((c) => c.risk - bestRisk.risk <= 0.02);
      chosen = tie.length > 1
        ? tie.reduce((a, b) => ((b.score?.perplexity ?? 0) > (a.score?.perplexity ?? 0) ? b : a))
        : bestRisk;
      if (tie.length > 1) console.log(`  平手抉選（risk 差 ≤0.02，${tie.length} 候選）：選 ppl 較高者壓查重`);
      console.log(`  → 選定 ${chosen.crossover ? '重組 X' : `cand${chosen.id}`}`);
    }
    }
    }


    // 8.2: citation/reference year consistency — the pipeline preserves
    // citations verbatim, including the DRAFT's own in-text vs References
    // year mismatches. References is the authority; align when unambiguous,
    // flag for manual review otherwise.
    let citeCheck = null;
    if (lang === 'en') {
      citeCheck = citationConsistency({ paragraphs: plan.paragraphs, prose: chosen.prose, fix: true });
      if (citeCheck.fixes.length) {
        for (const f of citeCheck.fixes) {
          for (const i of Object.keys(chosen.paras)) {
            if (chosen.paras[i].includes(f.from)) { chosen.paras[i] = chosen.paras[i].split(f.from).join(f.to); break; }
          }
        }
        chosen.prose = targetIdx.map((i) => chosen.paras[i]).filter(Boolean).join('\n\n');
        console.log(`  引用年份對齊：${citeCheck.fixes.map((f) => `${f.from} → ${f.to}`).join('、')}（以 References 為準）`);
      } else if (citeCheck.mismatches.length) {
        console.log(`  ⚠ 引用年份不一致（需人工核對）：${citeCheck.mismatches.map((m) => `${m.inText} vs [${m.refYears.join('/')}]`).join('、')}`);
      }
    }

    // 5.5 ── 8.0: automatic paragraph grind ─────────────────────────────────
    // Calibration: gen ≤ 0.05 → <20%; ≤0.10 is the submission gate. If the
    // chosen candidate is already there, skip. Otherwise grind the worst
    // paragraphs (delete is not an option here — the prose must stay whole),
    // then accept only if the whole-text score improved AND the grammar
    // damage stayed inside the delivery band; otherwise revert to pre-grind.
    // 9.0 turnaround: grind & similarity polish are GAIN stages, not
    // correctness stages — a wall-clock budget cuts them, delivering the best
    // verified candidate. Veto-carrying chosen candidates skip grind too
    // (delivery will reject them regardless; grinding a doomed draft wastes
    // 20+ minutes — 2026-10-27 graduation-run lesson).
    const overdue = arch90 && timeBudgetMin > 0 && (Date.now() - T0) > timeBudgetMin * 60000;
    const doomedChosen = arch90 && chosen.archVerdict && !chosen.archVerdict.pass;
    if (overdue) console.log(`  ⚠ 9.0 週轉保護：已超 ${timeBudgetMin} 分鐘——跳過研磨/查重打磨，交付最佳已驗證候選`);
    if (doomedChosen) console.log('  ⚠ 9.0：選中候選帶否決票（NLI 最後手段）——跳過研磨，交付階段將回退綠點');
    let grindInfo = null;
    if (docType.form || (arch90 && (chosen.archFrozen || overdue || doomedChosen))) {
      console.log('=== 5.5/7 段級研磨：跳過（' + (docType.form ? 'form 模式' : overdue ? '時間預算' : doomedChosen ? '帶否決票' : '凍結交付') + '）===');
      grindInfo = docType.form ? { action: 'skipped', reason: 'form mode (V2 recipe)' } : { action: 'skipped', reason: (arch90 && chosen.archFrozen) ? 'arch90 frozen last-green delivery' : overdue ? 'time budget' : doomedChosen ? 'veto-carrying chosen' : 'arch90' };
    } else if (mctsMode) {
      console.log('=== 5.5/7 段級研磨：--mcts 模式跳過（搜索已內含評估）===');
      grindInfo = { action: 'skipped', reason: 'mcts mode' };
    } else if (!gc.enabled) {
      console.log('=== 5.5/7 段級研磨：停用（--no-grind）===');
      grindInfo = { action: 'disabled' };
    } else if ((chosen.score?.p_ai_gen ?? 1) <= gc.genGate) {
      console.log(`=== 5.5/7 段級研磨：gen ${fmt(chosen.score?.p_ai_gen)} 已 ≤ 門檻 ${gc.genGate}，跳過 ===`);
      grindInfo = { action: 'skipped', reason: `gen ${fmt(chosen.score?.p_ai_gen)} ≤ gate ${gc.genGate}` };
    } else {
      // 8.4: extreme document family (original ≈ pure LM, gen > 0.8) —
      // escalate grind rounds and rebuild sentence-length structure first.
      const extreme = (chosen.score?.p_ai_gen ?? 0) > 0.8;
      const roundsN = extreme ? (cfg.grind?.roundsExtreme ?? 15) : gc.rounds;
      const worstN = extreme ? (cfg.grind?.worstExtreme ?? 4) : gc.worst;
      const dryStop = extreme ? 2 : 1;
      const bandLo = (cfg.filters?.cvBand?.[0] ?? 0.45) * 0.9;
      console.log(`=== 5.5/7 段級研磨（gen ${fmt(chosen.score?.p_ai_gen)} > ${gc.genGate}${extreme ? '，極端文檔：句級降級＋CV 主導' : ''}，NLI 守門）===`);
      // 8.13: mechanical burstify FIRST — deterministic split/merge, zero
      // model involvement, zero quality risk (client QA: model restructure
      // degraded quality below the original). Model burstify only as
      // fallback if CV still short of 0.5.
      let mechOps = 0;
      if (extreme && chosen.stats?.cv > 0 && chosen.stats.cv < 0.5) {
        console.log(`  8.13 攻堅：CV ${fmt(chosen.stats.cv, 3)} 低於交付線 0.5——機械節奏手術（原詞保留）`);
        for (const i of targetIdx) {
          const r = mechanicalBurstify(chosen.paras[i] || '', lang);
          if (r.ops) { chosen.paras[i] = r.text; mechOps += r.ops; }
        }
        if (mechOps) {
          chosen.prose = targetIdx.map((i) => chosen.paras[i]).filter(Boolean).join('\n\n');
          const stM = candidateStats({ originalProse, prose: chosen.prose, lang });
          stM.coverage = chosen.stats.coverage;
          chosen.stats = stM;
          chosen.grammarDamage = await damageOf(chosen.prose);
          const [scM] = await scoreTexts([chosen.prose]);
          if (scM) chosen.score = { ...chosen.score, ...scM };
          console.log(`  機械手術後：CV ${fmt(stM.cv, 3)} gen ${fmt(chosen.score?.p_ai_gen)}（${mechOps} ops）`);
        }
      }
      if (extreme && chosen.stats?.cv > 0 && chosen.stats.cv < bandLo) {
        console.log(`  8.4 攻堅：CV ${fmt(chosen.stats.cv, 3)} 仍低於帶——模型結構重造（備援）`);
        const { moves } = await burstifyCandidate({
          c: chosen, originalsByPara, targetIdx, lang,
          rounds: cfg.lowCvFallback?.rounds ?? 3, worst: cfg.lowCvFallback?.worst ?? 4,
          cvTarget: 0.5,
          log: (m) => console.log(`  ${m}`),
        });
        chosen.prose = targetIdx.map((i) => chosen.paras[i]).filter(Boolean).join('\n\n');
        const stB = candidateStats({ originalProse, prose: chosen.prose, lang });
        stB.coverage = chosen.stats.coverage;
        chosen.stats = stB;
        chosen.grammarDamage = await damageOf(chosen.prose);
        const [scB] = await scoreTexts([chosen.prose]);
        if (scB) chosen.score = { ...chosen.score, ...scB };
        console.log(`  結構重造後：CV ${fmt(stB.cv, 3)} gen ${fmt(chosen.score?.p_ai_gen)}（${moves.length} 段）`);
      }
      // 8.13: quality-preserving gate — with CV ≥ 0.5 and gen ≤ 0.85 the
      // delivery ships WITHOUT gen grinding (calibration: 0.749/0.539 → 0%,
      // 0.762/0.393 → 8%); every model mutation avoided is quality preserved.
      if (extreme && (chosen.stats?.cv ?? 0) >= 0.5 && (chosen.score?.p_ai_gen ?? 1) <= 0.85) {
        grindInfo = { action: 'skipped', reason: 'CV ≥ 0.5 且 gen ≤ 0.85——質量保持模式' };
        console.log('  CV ≥ 0.5 且 gen ≤ 0.85 → 跳過研磨（質量保持模式）');
      } else {
      const idxList = targetIdx;
      const origParas = idxList.map((i) => originalsByPara[i] || '');
      const parasIn = idxList.map((i) => chosen.paras[i] || originalsByPara[i] || '');
      const { paras: ground, stats: gstats } = await grindParas({
        origParas, paras: parasIn, lang,
        rounds: roundsN, worst: worstN, gain: gc.gain, dryStop,
        extreme: profile.extreme,
        log: (m) => console.log(`  ${m}`),
      });
      const newProse = ground.join('\n\n');
      const postDamage = await damageOf(newProse);
      const [postScore] = await scoreTexts([newProse]);
      const preGen = chosen.score?.p_ai_gen ?? null;
      const postGen = postScore?.p_ai_gen ?? null;
      const preDamage = chosen.grammarDamage ?? 0;
      const maxDmg = cfg.filters?.maxGrammarDamage ?? 0.08;
      if (postDamage > maxDmg) {
        grindInfo = { action: 'reverted', reason: `grind 後語法傷率 ${fmt(postDamage)} > ${maxDmg}`, preGen, postGen, postDamage, stats: gstats };
        console.log(`  ⚠ grind 後傷率 ${fmt(postDamage)} 超上限 ${maxDmg} → 回退研磨前文本`);
      } else if (preGen != null && postGen != null && postGen > preGen) {
        grindInfo = { action: 'reverted', reason: `整份 gen 不升反降（${fmt(preGen)} → ${fmt(postGen)}）`, preGen, postGen, postDamage, stats: gstats };
        console.log(`  ⚠ 整份 gen 未改善（${fmt(preGen)} → ${fmt(postGen)}）→ 回退研磨前文本`);
      } else if (!gstats.accepted) {
        grindInfo = { action: 'no-op', reason: '0 段改善', preGen, postGen, postDamage, stats: gstats };
        console.log('  grind 無段改善，文本不變');
      } else {
        idxList.forEach((i, j) => { chosen.paras[i] = ground[j]; });
        chosen.prose = newProse;
        chosen.grammarDamage = postDamage;
        chosen.score = { ...chosen.score, p_ai_gen: postGen, p_ai_edit: postScore?.p_ai_edit ?? chosen.score?.p_ai_edit, perplexity: postScore?.perplexity ?? chosen.score?.perplexity };
        const newStats = candidateStats({ originalProse, prose: newProse, lang });
        newStats.coverage = chosen.stats.coverage;
        chosen.stats = newStats;
        grindInfo = { action: 'applied', preGen, postGen, preDamage, postDamage, stats: gstats };
        console.log(`  grind 採用：整份 gen ${fmt(preGen)} → ${fmt(postGen)}，傷率 ${fmt(postDamage)}`);
      }
      }
    }

    // 5.6 ── 8.2: similarity polish — regen the most stock (lowest per-
    // sentence ppl) sentences to raise their unpredictability. Turnitin
    // similarity is n-gram overlap with the web; surprising wording breaks
    // the fingerprint while the guards keep facts, citations and meaning.
    // Whole-text acceptance: stay inside the delivery band, else revert.
    let simInfo = null;
    const sp = { enabled: cfg.similarityPolish?.enabled !== false, worst: cfg.similarityPolish?.worst ?? 3 };
    if (docType.form || !sp.enabled || lang !== 'en' || (arch90 && (chosen.archFrozen || overdue || doomedChosen))) {
      simInfo = { action: 'skipped', reason: docType.form ? 'form mode' : (!sp.enabled ? 'disabled' : (arch90 && chosen.archFrozen) ? 'arch90 frozen' : 'lang') };
    } else {
      console.log(`=== 5.6/7 查重打磨（重生最 stock 的 ${sp.worst} 句，帶內驗收）===`);
      const preScore = chosen.score;
      const idxList = targetIdx;
      const origParas = idxList.map((i) => originalsByPara[i] || '');
      const parasIn = idxList.map((i) => chosen.paras[i] || originalsByPara[i] || '');
      const { paras: polished, stats: sstats } = await similarityPolish({
        origParas, paras: parasIn, lang, worst: sp.worst,
        log: (m) => console.log(`  ${m}`),
      });
      if (!sstats.accepted) {
        simInfo = { action: 'no-op', reason: '0 句改善', stats: sstats };
        console.log('  查重打磨無句改善，文本不變');
      } else {
        const newProse = polished.join('\n\n');
        const [sc2] = await scoreTexts([newProse]);
        const dmg2 = await damageOf(newProse);
        const st2 = candidateStats({ originalProse, prose: newProse, lang });
        const bandLo = (cfg.filters?.cvBand?.[0] ?? 0.45) * 0.9;
        const maxDmg2 = cfg.filters?.maxGrammarDamage ?? 0.08;
        const bandOk = (sc2?.p_ai_gen ?? 1) <= gc.genGate && dmg2 <= maxDmg2 && (st2.cv === 0 || st2.cv >= bandLo)
          && citationsIn(newProse).length >= citationsIn(chosen.prose).length;
        if (!bandOk) {
          simInfo = { action: 'reverted', reason: '帶外（gen/傷率/CV/引用）', stats: sstats };
          console.log('  ⚠ 查重打磨後出帶 → 回退');
        } else {
          idxList.forEach((i, j) => { chosen.paras[i] = polished[j]; });
          chosen.prose = newProse;
          chosen.grammarDamage = dmg2;
          chosen.score = { ...chosen.score, p_ai_gen: sc2?.p_ai_gen, p_ai_edit: sc2?.p_ai_edit ?? chosen.score?.p_ai_edit, perplexity: sc2?.perplexity ?? chosen.score?.perplexity };
          st2.coverage = chosen.stats.coverage;
          chosen.stats = st2;
          simInfo = { action: 'applied', pplBefore: preScore?.perplexity ?? null, pplAfter: sc2?.perplexity ?? null, stats: sstats };
          console.log(`  查重打磨採用：${sstats.accepted} 句，整份 ppl ${fmt(preScore?.perplexity, 1)} → ${fmt(sc2?.perplexity, 1)}，gen ${fmt(chosen.score?.p_ai_gen)}`);
        }
      }
    }

    // form-mode citation/number summary (7.0: 四維承諾補全)
    let formCheck = null;
    if (docType.form) {
      const oc = citationsIn(originalProse);
      const cc = citationsIn(chosen.prose);
      const on = factNumbers(originalProse);
      const cn = factNumbers(chosen.prose);
      formCheck = {
        missingCitations: oc.filter((c) => !cc.includes(c)),
        missingNumbers: on.filter((n) => !cn.includes(n)),
        citations: cc.length,
        numbers: cn.length,
      };
      if (formCheck.missingCitations.length || formCheck.missingNumbers.length) {
        console.log(`  form 檢查：缺引用 ${JSON.stringify(formCheck.missingCitations)} 缺數字 ${JSON.stringify(formCheck.missingNumbers)}`);
      } else {
        console.log(`  form 檢查：引用 ${formCheck.citations} 個、數字 ${formCheck.numbers} 個全數保留`);
      }
    }

    // 7.6: word budget — delete-first (pure cuts carry zero AI-edit signal),
    // targeted hz compression only for target paragraphs still over quota,
    // everything behind validateUnit + NLI. Runs before mech/LT so the final
    // grammar passes see the budgeted text (both are word-neutral).
    let budgetStats = null;
    let budgetKeptEdits = [];
    if (wb.enabled && wb.maxWords) {
      console.log(`=== 7.6 字數預算（上限 ${wb.maxWords}${wb.floorWords ? `，下限 ${wb.floorWords}` : ''} 詞）===`);
      const res = await applyWordBudget({
        plan, chosenParas: chosen.paras, originalsByPara, lang,
        budget: {
          maxWords: wb.maxWords,
          floorWords: wb.floorWords ?? null,
          maxCutRatio: wb.maxCutRatio ?? 0.3,
          force: !!wb.force,
        },
        log: (m) => console.log(`  ${m}`),
      });
      budgetStats = res.stats;
      if (!res.ok) throw new Error(`字數預算無法安全達成：${res.stats.reason || 'unknown'}`);
      budgetKeptEdits = res.keptEdits || [];
      chosen.prose = targetIdx.map((i) => chosen.paras[i]).filter(Boolean).join('\n\n');
      const newStats = candidateStats({ originalProse, prose: chosen.prose, lang });
      newStats.coverage = chosen.stats.coverage;
      chosen.stats = newStats;
      // compression smooths — if the budget pass pushed CV under the band the
      // delivery is no longer calibrated; surface it instead of shipping blind
      const cvFloor = (cfg.filters?.cvBand?.[0] ?? 0.45) * 0.9;
      if (!docType.form && newStats.cv > 0 && newStats.cv < cvFloor) {
        budgetStats.cvWarn = Number(newStats.cv.toFixed(3));
        console.log(`  ⚠ 壓縮後 CV ${fmt(newStats.cv, 3)} 低於安全帶下限 ${fmt(cvFloor, 3)}——交付前建議人工覆核節奏`);
      }
    }

    // 5.7 ── 8.2: tier-2 quality surgery — sentences CoLA passes at 0.5 but
    // fails at 0.7 read awkward ("massive amount of free sugars" class).
    // Regenerate the worst few from their original sentences (same machinery
    // as step 4), then NLI-guard each changed paragraph and revert any drift.
    let qFix = null;
    const q = cfg.qualitySurgery ?? {};
    if (!docType.form && q.threshold && !(arch90 && chosen.archFrozen)) {
      console.log(`=== 5.7/7 二級品質手術（CoLA < ${q.threshold}，最多 ${q.maxSentences ?? 4} 句）===`);
      const preT2 = { ...chosen.paras };
      const repaired = await surgicalRepair({
        paras: chosen.paras, originalsByPara, lang,
        cfg: { grammarThreshold: q.threshold, surgeryTries: 2, maxSurgeries: q.maxSentences ?? 4 },
        scorer: scoreSents, log: (m) => console.log(`  ${m}`),
      });
      const changed = Object.keys(repaired.paras).filter((i) => repaired.paras[i] !== chosen.paras[i]);
      const reverted = [];
      for (const i of changed) {
        const [pair] = await nliPairs([[originalsByPara[i] || '', repaired.paras[i]]]);
        if (pair && pair.contradict > 0.5) { repaired.paras[i] = preT2[i]; reverted.push(i); }
      }
      if (changed.length > reverted.length) {
        // 8.9: whole-text band check — tier-2 regens are fresh hz output and
        // on extreme docs they carried the offline score 0.573 -> 0.849 (the
        // real detector forgave it once; the instrument drift is not
        // acceptable — same guard pattern as register surgery).
        const t2Prose = targetIdx.map((i) => repaired.paras[i]).filter(Boolean).join('\n\n');
        const [t2Score] = await scoreTexts([t2Prose]);
        const t2Gen = t2Score?.p_ai_gen ?? null;
        const preGenT2 = chosen.score?.p_ai_gen ?? null;
        if (preGenT2 != null && t2Gen != null && t2Gen > preGenT2 + 0.05) {
          console.log(`  ⚠ 二級手術推高整份 gen（${fmt(preGenT2)} → ${fmt(t2Gen)}）→ 全部回退`);
          qFix = { threshold: q.threshold, surgeries: 0, revertedAll: true, preGen: preGenT2, postGen: t2Gen };
        } else {
          chosen.paras = repaired.paras;
          chosen.prose = t2Prose;
          chosen.grammarDamage = await damageOf(chosen.prose);
          const st3 = candidateStats({ originalProse, prose: chosen.prose, lang });
          st3.coverage = chosen.stats.coverage;
          chosen.stats = st3;
          if (t2Score) chosen.score = { ...chosen.score, ...t2Score };
        }
      }
      if (!qFix) qFix = {
        threshold: q.threshold, surgeries: repaired.surgeries.filter((s) => !reverted.includes(String(s.para))).length,
        list: repaired.surgeries.filter((s) => !reverted.includes(String(s.para))).map((s) => ({ before: s.before.slice(0, 60), after: s.after.slice(0, 60) })),
        reverted,
      };
      console.log(`  二級手術：${qFix.surgeries} 句修正${reverted.length ? `（${reverted.length} 句 NLI 回退）` : ''}`);
    }

    // 7.1: deterministic punctuation/quote pass (citation period placement,
    // mixed quotes, missing period before labels) — the classes CoLA cannot
    // see and the user's QA caught in 7.0.
    let mechFixes = 0;
    for (const pi of Object.keys(chosen.paras)) {
      const fixed = mechanicalPolish(chosen.paras[pi], lang);
      if (fixed !== chosen.paras[pi]) { chosen.paras[pi] = fixed; mechFixes++; }
    }
    if (mechFixes) {
      chosen.prose = targetIdx.map((i) => chosen.paras[i]).filter(Boolean).join('\n\n');
      console.log(`  機械標點修正：${mechFixes} 段（引用句點／引號統一）`);
    }

    // 7.3: deterministic grammar repair (LanguageTool safe rules). Fixes the
    // reader-visible errors CoLA cannot see (agreement, casing, spelling)
    // with zero AI-edit signal — offline probes show p_ai_gen/ppl unmoved.
    // Citations, proper nouns and the References list stay protected.
    let ltFixCount = 0;
    if (!args.k['no-lt']) {
      const ltIn = path.join(workDir, 'ltmap-in.json');
      const ltOut = path.join(workDir, 'ltmap-out.json');
      fs.writeFileSync(ltIn, JSON.stringify({
        indices: Object.keys(chosen.paras).map(Number),
        texts: Object.keys(chosen.paras).map((i) => chosen.paras[i]),
      }), 'utf8');
      const ltLang = lang === 'zh' ? 'zh' : 'en-GB';
      const ltSummary = runLtFix(['fixmap', ltIn, ltOut, ltLang]);
      if (fs.existsSync(ltOut)) {
        const fixedMap = JSON.parse(fs.readFileSync(ltOut, 'utf8'));
        const fixes = fixedMap.fixes || [];
        if (fixes.length) {
          const keys = Object.keys(chosen.paras);
          fixedMap.texts.forEach((t, i) => { chosen.paras[keys[i]] = t; });
          chosen.prose = targetIdx.map((i) => chosen.paras[i]).filter(Boolean).join('\n\n');
          ltFixCount = fixes.length;
          console.log(ltSummary.split('\n')[0]);
        } else {
          console.log('  LT 語法層：0 處（文本已乾淨或語言不支援）');
        }
      }
    }

    // 7.35 ── 8.8: register surgery (post-LT: scans the true final text) — second person, contractions and spoken
    // fillers that CoLA passes but academic QA rejects (compare-stores QA:
    // "you get to have face-to-face interaction"). The whole candidate is
    // scanned, offending sentences are regenerated from their mapped ORIGINAL
    // sentence (academic register instruction), every change behind
    // styleGuard + per-sentence NLI; whole-text band check reverts on drift.
    let regFix = null;
    if (!docType.form && lang === 'en' && cfg.registerSurgery?.enabled !== false && !(arch90 && chosen.archFrozen)) {
      const regRe = [
        /\b(you|your)\b/i,
        /\b(it's|they're|don't|can't|won't|isn't|you'll|we'll)\b/i,
        /\b(in a nutshell|pretty much|a whole lot)\b/i,
      ];
      const offending = [];
      for (const i of targetIdx) {
        const sents = splitSentences(chosen.paras[i] || '', lang);
        sents.forEach((s) => {
          if (wordCount(s.text, lang) >= 8 && regRe.some((re) => re.test(s.text))) offending.push({ i, s });
        });
      }
      const budget = cfg.registerSurgery?.maxSentences ?? 8;
      const targets = offending.slice(0, budget);
      if (targets.length) {
        console.log(`=== 5.8/7 語域手術（${offending.length} 句冒犯語域，處理前 ${targets.length} 句）===`);
        const preReg = { paras: { ...chosen.paras }, prose: chosen.prose, score: chosen.score, damage: chosen.grammarDamage, stats: chosen.stats };
        let done = 0;
        for (const t of [...targets].sort((a, b) => b.s.start - a.s.start)) {
          const origSents = splitSentences(originalsByPara[t.i] || '', lang).map((s) => s.text);
          let origSent = null, bestSim = 0;
          for (const os of origSents) {
            const sim = jaccard(tokenSet(t.s.text, lang), tokenSet(os, lang));
            if (sim > bestSim) { bestSim = sim; origSent = os; }
          }
          let ok = false;
          for (let attempt = 0; attempt < 2 && !ok; attempt++) {
            try {
              const { cloaked, restore } = cloakNumbers(origSent || t.s.text);
              const cand = restore(await completeUnit({ text: cloaked, sampling: { temperature: 0.9, topP: 0.95 }, instruction: 'Rewrite this sentence in an academic register: no contractions, no second person, no rhetorical questions, no sentence fragments, no spoken fillers. Keep the original meaning and all facts exactly.' }));
              const v = validateUnit(origSent || t.s.text, cand, lang);
              if (!v.ok) { console.log(`  regen rejected (${v.reason})`); continue; }
              const restSents = splitSentences(chosen.paras[t.i], lang).filter((x) => x.start !== t.s.start).map((x) => x.text);
              const guard = styleGuardText(origSent || t.s.text, cand, restSents, lang);
              if (guard) { console.log(`  regen rejected (${guard})`); continue; }
              const candSents = splitSentences(cand, lang).map((s) => s.text);
              const cgrams = await grammarScores(candSents);
              if (cgrams.some((g) => g < 0.7)) { console.log('  regen ungrammatical'); continue; }
              if (origSent) {
                const [pair] = await nliPairs([[origSent, cand]]);
                if (pair && pair.contradict > 0.5) { console.log('  regen NLI reject'); continue; }
              }
              chosen.paras[t.i] = chosen.paras[t.i].slice(0, t.s.start) + cand + chosen.paras[t.i].slice(t.s.end);
              ok = true; done++;
            } catch (e) {
              console.log(`  regen failed: ${e.message.slice(0, 60)}`);
            }
          }
        }
        if (done) {
          chosen.prose = targetIdx.map((i) => chosen.paras[i]).filter(Boolean).join('\n\n');
          const stR = candidateStats({ originalProse, prose: chosen.prose, lang });
          stR.coverage = chosen.stats.coverage;
          const dmgR = await damageOf(chosen.prose);
          const [scR] = await scoreTexts([chosen.prose]);
          const bandLoR = (cfg.filters?.cvBand?.[0] ?? 0.45) * 0.9;
          const bandOkR = (scR?.p_ai_gen ?? 1) <= Math.max(gc.genGate, (preReg.score?.p_ai_gen ?? 1) + 0.05)
            && dmgR <= (cfg.filters?.maxGrammarDamage ?? 0.08)
            && (stR.cv === 0 || stR.cv >= bandLoR);
          if (bandOkR) {
            chosen.stats = stR;
            chosen.grammarDamage = dmgR;
            if (scR) chosen.score = { ...chosen.score, ...scR };
            regFix = { offending: offending.length, fixed: done };
            console.log(`  語域手術：${done}/${targets.length} 句修正，gen ${fmt(chosen.score?.p_ai_gen)}`);
          } else {
            chosen.paras = preReg.paras; chosen.prose = preReg.prose; chosen.score = preReg.score;
            chosen.grammarDamage = preReg.damage; chosen.stats = preReg.stats;
            regFix = { offending: offending.length, fixed: 0, reverted: true };
            console.log('  ⚠ 語域手術後出帶 → 全部回退');
          }
        } else regFix = { offending: offending.length, fixed: 0 };
      } else regFix = { offending: 0, fixed: 0 };
    }


    // 9.0 arch90 — 交付前最終否決（L3）＋骨架存活檢查（L2）＋回退（L4）
    let archFinal = null, archRolledBack = false, archKeptFailing = false, archSkeleton = null, archReorg = null;
    if (arch90) {
      // L2: S3 路由——重複論證重組（先於最終否決，讓否決環覆蓋重組後文本）
      if (route?.state === 'S3') {
        const beforeProse = chosen.prose;
        const beforeParas = { ...chosen.paras };
        const beforeScore = chosen.score, beforeStats = chosen.stats;
        try {
          archReorg = await repetitionReorg({ paras: chosen.paras, originalsByPara, targetIdx, lang, log: (m) => console.log(`  重組：${m}`) });
          if (archReorg.action === 'applied') {
            chosen.prose = targetIdx.map((i) => chosen.paras[i]).filter(Boolean).join('\n\n');
            const stR = candidateStats({ originalProse, prose: chosen.prose, lang });
            stR.coverage = chosen.stats?.coverage ?? 1;
            chosen.stats = stR;
            const [scR] = await scoreTexts([chosen.prose]);
            if (scR) chosen.score = { ...(chosen.score || {}), ...scR };
            // 重組文本也要過第一環（事實基準），不過即整體回退
            const reorgV = evaluateText({ draft: originalProse, prose: chosen.prose, lang, cvDraft: archOrigCv, cvProse: chosen.stats?.cv, paragraphs: plan.paragraphs });
            if (!reorgV.pass) {
              console.log(`  ⚠ 9.0 重組未過否決環（${reorgV.vetoes.map((v) => v.rule).join('、')}）→ 回退重組`);
              chosen.paras = beforeParas; chosen.prose = beforeProse; chosen.score = beforeScore; chosen.stats = beforeStats;
              archReorg = { ...archReorg, reverted: true, vetoes: reorgV.vetoes };
            }
            console.log(`  9.0 重組：${archReorg.moves}/${archReorg.pairs} 段對消除重複${archReorg.reverted ? '（已回退）' : ''}`);
          }
        } catch (e) { console.log(`  9.0 重組跳過：${e.message.slice(0, 60)}`); archReorg = { action: 'failed', error: e.message.slice(0, 80) }; }
        const reorgClean = !(archReorg?.vetoes?.length);
        ledger.append({ stage: 'reorg', before: beforeProse, after: chosen.prose, verdict: reorgClean ? { pass: true, vetoes: [], dimensions: {} } : { pass: false, vetoes: archReorg.vetoes, dimensions: {} }, meta: { ...archReorg, paras: { ...chosen.paras } } });
      }
      archFinal = evaluateText({ draft: originalProse, prose: chosen.prose, lang, nli: chosen.nli || null, cvDraft: archOrigCv, cvProse: chosen.stats?.cv, paragraphs: plan.paragraphs });
      ledger.append({ stage: 'delivery', before: originalProse, after: chosen.prose, verdict: archFinal, meta: { chosen: chosen.crossover ? 'X' : chosen.id, route: route?.state } });
      if (!archFinal.pass) {
        const greens = ledger.greenCandidates();
        const green = greens.length ? greens.reduce((a, b) => ((b.meta?.risk ?? 9) < (a.meta?.risk ?? 9) ? b : a)) : null;
        if (!green) {
          console.log(`  ⚠ 9.0 交付否決（${archFinal.vetoes.map((v) => v.rule).join('、')}）→ 回退至原稿（帳本 #0）`);
          chosen.paras = {};
          for (const i of targetIdx) chosen.paras[i] = originalsByPara[i];
          chosen.prose = originalProse;
          chosen.stats = candidateStats({ originalProse, prose: originalProse, lang });
          archRolledBack = true;
        } else if (green?.meta?.paras && Object.keys(green.meta.paras).length) {
          console.log(`  ⚠ 9.0 交付否決（${archFinal.vetoes.map((v) => v.rule).join('、')}）→ 回退至最佳綠候選（${green.label || green.stage}，risk ${green.meta?.risk ?? '—'}）`);
          chosen.paras = { ...green.meta.paras };
          chosen.prose = green.after;
          const stG = candidateStats({ originalProse, prose: chosen.prose, lang });
          stG.coverage = chosen.stats?.coverage ?? 1;
          chosen.stats = stG;
          chosen.crossover = false;
          chosen.id = (green.label || '').replace(/^cand/, '') || chosen.id;
          archRolledBack = true;
        } else {
          console.log(`  ⚠ 9.0 交付否決（${archFinal.vetoes.map((v) => v.rule).join('、')}）——綠點無段落映射，保留現版並標記人工覆核（exit 2）`);
          archRolledBack = true;
          archKeptFailing = true;
        }
      }
      const skBefore = buildArgumentMap(originalProse, lang);
      const skAfter = buildArgumentMap(chosen.prose, lang);
      archSkeleton = skeletonSurvived(skBefore, skAfter);
      if (!archSkeleton.ok) console.log(`  ⚠ 9.0 骨架檢查：${archSkeleton.problems.join('；')}`);
      ledger.append({ stage: 'skeleton', before: originalProse, after: chosen.prose, verdict: { pass: archSkeleton.ok, vetoes: archSkeleton.problems.map((p) => ({ ring: 0, rule: 'skeleton', detail: p })), dimensions: {} } });
    }

    const aDocx = path.join(outDir, `${base}.v6-A.docx`);
    const aProse = path.join(outDir, `${base}.v6-A.prose.txt`);
    fs.writeFileSync(aProse, chosen.prose + '\n', 'utf8');
    if (isDocx) {
      const mapIdx = Object.keys(chosen.paras).map(Number);
      const mapTxt = Object.keys(chosen.paras).map((i) => chosen.paras[i]);
      for (const e of budgetKeptEdits) {          // 7.6: deletions in kept paragraphs
        if (!mapIdx.includes(e.idx)) { mapIdx.push(e.idx); mapTxt.push(e.text); }
      }
      const map = { indices: mapIdx, texts: mapTxt };
      const mapPath = path.join(workDir, 'amap.json');
      fs.writeFileSync(mapPath, JSON.stringify(map), 'utf8');
      console.log(runBridge(['apply', input, mapPath, aDocx]));
    }

    // 6 ── deliver ─────────────────────────────────────────────────────────
    // 7.3: API 潤飾改為 opt-in（--polish）。校準集第 13 點：潤飾度每升一級
    // Turnitin 約升 10-15%（final6.1 零傷+潤飾=29% vs H2 無潤飾=<20%）。
    // 預設交付 A＋機械標點＋LT 語法層；品質優先模式才走 API 修補。
    let bDocx = aDocx, bScores = chosen.score, bReport = null;
    let deltaEdit = 0, deltaGen = 0;
    if (!docType.form && args.k.polish) {
      console.log('=== 6/7 最小修補（pipeline.mjs）===');
      const code = await new Promise((resolve) => {
        const cvRetention = cfg.polishCvRetention ?? 1.0;
        const child = spawn(process.execPath, [PIPELINE, input, '--humanized', aDocx, '--out-dir', outDir, '--min-cv-retention', String(cvRetention)], {
          cwd: path.dirname(PIPELINE), env: process.env, windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const fwd = (stream) => {
          let buf = '';
          stream.on('data', (c) => {
            buf += c.toString('utf8');
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i).replace(/\r$/, '');
              buf = buf.slice(i + 1);
              if (line.trim()) process.stdout.write(line + '\n');
            }
          });
        };
        fwd(child.stdout);
        fwd(child.stderr);
        child.on('error', (e) => { console.error(String(e.message)); resolve(1); });
        child.on('close', (c) => resolve(c ?? 1));
      });
      if (code !== 0 && code !== 2) throw new Error(`pipeline.mjs exited ${code}`);
      if (code === 2) console.log('  pipeline 退出碼 2：有 major/critical 待覆核（非失敗），見修補報告');
      bDocx = path.join(outDir, `${base}.final.docx`);
      bReport = path.join(outDir, `${base}.final.report.json`);
    } else {
      console.log(docType.form ? '=== 6/7 form 模式（V2 配方）：A 直接交付（已過機械＋LT 層）===' : '=== 6/7 預設配方（7.3）：A＋機械標點＋LT 語法層直接交付 ===');
    }

    // 7 ── risk card ───────────────────────────────────────────────────────
    console.log('=== 7/7 風險卡 ===');
    let cvGuard = null;
    if (!docType.form && args.k.polish) {
      const bWork = path.join(outDir, `.${base}.pipeline`, 'polished.prose.txt');
      if (fs.existsSync(bWork)) {
        const bProseText = fs.readFileSync(bWork, 'utf8');
        bScores = (await scoreFiles([bWork]))[0];
        deltaEdit = (bScores?.p_ai_edit ?? 0) - (chosen.score?.p_ai_edit ?? 0);
        deltaGen = (bScores?.p_ai_gen ?? 0) - (chosen.score?.p_ai_gen ?? 0);
        // CV guard (7.0): polish must not flatten the rhythm past the safe
        // zone. Calibration: ratio < 1.05 vs the AI draft scored 56%.
        const { docMetrics } = await import('../polish/src/checks.mjs');
        const bCv = docMetrics(bProseText, lang).cv;
        const origCv = docMetrics(originalProse, lang).cv;
        const aClean = (chosen.grammarDamage ?? 0) <= (cfg.filters?.maxGrammarDamage ?? 0.08);
        if (bCv > 0 && origCv > 0 && bCv / origCv < 1.05) {
          if (aClean) {
            cvGuard = { bCv, ratio: bCv / origCv, action: 'reverted-to-A' };
            console.log(`  CV 守門：B 的 CV ${bCv.toFixed(3)}（ratio ${(bCv / origCv).toFixed(2)}）低於安全線，A 本身零傷 → 回退交付 A`);
            bDocx = aDocx;
            bScores = chosen.score;
            deltaEdit = 0; deltaGen = 0;
          } else {
            cvGuard = { bCv, ratio: bCv / origCv, action: 'warn' };
            console.log(`  CV 守門警告：B 的 CV ${bCv.toFixed(3)}（ratio ${(bCv / origCv).toFixed(2)}）低於安全線，但 A 有殘餘傷率 ${fmt(chosen.grammarDamage)}，保留 B 並標記人工覆核`);
          }
        }
      }
    }

    const report = {
      generatedAt: new Date().toISOString(), input, lang,
      docType: { form: docType.form, formScore: docType.formScore },
      candidates: pool.map((c) => ({
        id: c.id, crossover: !!c.crossover, provenance: c.provenance || null,
        sampling: c.sampling || null, eligible: eligible.includes(c), risk: c.risk ?? null,
        stats: c.stats, score: c.score,
        grammarDamagePre: c.grammarDamagePre ?? null, grammarDamage: c.grammarDamage ?? null,
        surgeries: (c.surgeries || []).length, nli: c.nli ?? null, failures: c.failures,
      })),
      chosen: chosen.id,
      ltFixes: ltFixCount,
      mechFixes,
      originalScore, origGrammarDamage: origDamage, chosenScore: chosen.score,
      bScore: bScores, deltas: { p_ai_edit: deltaEdit, p_ai_gen: deltaGen },
      cvGuard, formCheck,
      budget: budgetStats,
      grind: grindInfo,
      styleGuide: styleMeta,
      mcts: mctsMode ? chosen.mcts : null,
      shred: shredStats,
      similarityPolish: simInfo,
      citationCheck: citeCheck ? { checked: citeCheck.checked, references: citeCheck.references, mismatches: citeCheck.mismatches, fixes: citeCheck.fixes } : null,
      qualitySurgery: qFix,
      editLensDeltaAdvisory: cfg.editLensDeltaAdvisory ?? 0.1,
      files: { aDocx, aProse, bDocx, bReport },
    };
    const v6Report = path.join(outDir, `${base}.v6.report.json`);
    // 9.0 arch90 — 風險卡素材（在 report 寫入前宣告，供 JSON 與 md 共用）
    let archSection = '';
    let diag90 = null;
    if (arch90) {
      // 9.0 L1 作者錨定：--seed 為 txt 時視為作者真實寫作樣本
      let authorSampleText = null;
      if (args.seed) {
        try {
          const sp = path.resolve(String(args.seed));
          if (fs.existsSync(sp) && /\.txt$/i.test(sp)) authorSampleText = fs.readFileSync(sp, 'utf8');
          else if (fs.existsSync(sp) && /\.json$/i.test(sp)) authorSampleText = JSON.parse(fs.readFileSync(sp, 'utf8')).text || null;
        } catch { /* seed 讀取失敗不擋診斷 */ }
      }
      diag90 = diagnoseText(originalProse, lang, { authorSample: authorSampleText });
    }
    if (arch90) {
      report.arch90 = {
        route: route?.state ?? null, routeAdvice: route?.advice ?? null,
        diagnostics: diag90 ? { issues: diag90.issues, metrics: diag90.metrics } : null,
        finalVerdict: archFinal, rolledBack: archRolledBack,
        skeleton: archSkeleton, ledger: ledger?.file ?? null,
      };
    }
    fs.writeFileSync(v6Report, JSON.stringify(report, null, 1), 'utf8');

    const rows = pool.map((c) => `| ${c.crossover ? 'X' : c.id}${c.crossover ? '（重組）' : ''} | ${(c.stats.coverage * 100).toFixed(0)}% | ${fmt(c.stats.cv, 3)} | ${fmt(c.grammarDamagePre)} | ${fmt(c.grammarDamage)} | ${(c.surgeries || []).length} | ${fmt(c.score?.perplexity, 1)} | ${fmt(c.score?.p_ai_gen)} | ${fmt(c.score?.p_ai_edit)} | ${fmt(c.nli?.maxContradict)} | ${eligible.includes(c) ? fmt(c.risk) : '淘汰'} |`).join('\n');
    if (arch90) {
      const rep = ledger.report();
      archSection = `\n## 9.0 分層架構（--arch90）\n\n- 路由：**${route?.state || '—'}** —— ${route?.advice || ''}\n- L1 診斷（原稿）：${diag90.issues.length ? diag90.issues.map((x) => `${x.id}〔${x.severity}〕`).join('、') : '無高/中問題'}\n- L3 否決紀錄：${rep.vetoes.length ? rep.vetoes.map((v) => `${v.rule}＠#${v.at}`).join('、') : '無'}\n- 交付否決：${archFinal ? (archFinal.pass ? '全綠 ✓' : `**未過**（${archFinal.vetoes.map((v) => v.rule).join('、')}）`) : '—'}${archRolledBack ? ' · **已回退**' : ''}\n- L2 重複論證重組：${archReorg ? `${archReorg.action}（段對 ${archReorg.pairs ?? 0}，消除 ${archReorg.moves || 0}）` : '—（非 S3 路由）'}\n- L2 骨架存活：${archSkeleton ? (archSkeleton.ok ? '✓' : `✗ ${archSkeleton.problems.join('；')}`) : '—'}\n- L4 帳本：${ledger.file}（${rep.entries} 筆 · 回退點 #${rep.rollbackPoint}）\n`;
    }
    const md = `# Workflow 8.1 風險卡

- 生成時間：${report.generatedAt}
- 原稿：${input} · 語言 ${lang} · 型別 **${docType.form ? 'form／模板（V2 配方）' : 'essay（CV 帶）'}**${bandFallback ? `\n- ⚠ **帶外交付**：${bandFallback.reason}——CV ${fmt(bandFallback.cv, 3)} 低於校準帶 ${fmt(bandFallback.band[0], 2)}–${fmt(bandFallback.band[1], 2)}，此文檔族未經 Turnitin 驗證，建議先送檢一次確認再批量` : ''}
- 候選 ${candidates.length}${assembled ? ' + 重組 X' : ''} · 手術 ${pool.reduce((n, c) => n + (c.surgeries || []).length, 0)} 處 · 選定 **${chosen.crossover ? '重組 X' : `cand${chosen.id}`}${chosen.crossover ? `（逐段取自 cand{${Object.values(chosen.provenance).join(',')}}）` : ''}**

## 候選對照

| # | 覆蓋 | CV | 傷率(術前) | 傷率(術後) | 手術 | ppl | p_ai_gen | p_ai_edit | NLI矛盾 | risk |
|---|---|---|---|---|---|---|---|---|---|---|
${rows}

原稿基準：ppl ${fmt(originalScore?.perplexity, 1)} · gen ${fmt(originalScore?.p_ai_gen)} · edit ${fmt(originalScore?.p_ai_edit)} · 語法傷率 ${fmt(origDamage)}
${budgetStats ? `\n## 字數預算（7.6）\n\n- 上限 ${budgetStats.maxWords}${budgetStats.floorWords != null ? ` · 下限 ${budgetStats.floorWords}` : ''}：**${budgetStats.beforeWords} → ${budgetStats.afterWords} 詞**\n- 刪句 ${budgetStats.deletedSentences}（-${budgetStats.deletedWords} 詞） · 定向壓縮 ${budgetStats.compressedParas} 段${budgetStats.failedCompressions ? ` · 壓縮失敗 ${budgetStats.failedCompressions} 段` : ''}${budgetStats.cutRatio != null ? ` · 削幅 ${(budgetStats.cutRatio * 100).toFixed(0)}%` : ''}\n${budgetStats.cvWarn ? `- ⚠ 壓縮後 CV ${budgetStats.cvWarn} 低於安全帶——建議人工覆核節奏\n` : ''}` : ''}${grindInfo ? `\n## 段級研磨（8.0）\n\n- 動作：**${grindInfo.action === 'applied' ? '採用' : grindInfo.action === 'reverted' ? `回退（${grindInfo.reason}）` : grindInfo.action === 'skipped' ? `跳過（${grindInfo.reason || 'form 模式'}）` : grindInfo.action === 'no-op' ? '無段改善（文本不變）' : '停用'}**\n${grindInfo.preGen != null ? `- 整份 gen：${fmt(grindInfo.preGen)} → ${fmt(grindInfo.postGen)} · 語法傷率：${fmt(grindInfo.postDamage)}\n` : ''}${grindInfo.stats && grindInfo.stats.attempts ? `- 嘗試 ${grindInfo.stats.attempts}＝採用 ${grindInfo.stats.accepted}＋no-gain ${grindInfo.stats.noGain}＋拒收 ${grindInfo.stats.rejected}${grindInfo.stats.failed ? `＋失敗 ${grindInfo.stats.failed}` : ''} · ${grindInfo.stats.roundsRun} 輪\n` : ''}` : ''}${simInfo ? `\n## 查重打磨（8.2）\n\n- 動作：**${simInfo.action === 'applied' ? '採用' : simInfo.action === 'reverted' ? `回退（${simInfo.reason}）` : '無變化'}**\n${simInfo.pplBefore != null ? `- 整份 ppl：${fmt(simInfo.pplBefore, 1)} → ${fmt(simInfo.pplAfter, 1)}（較高＝較少通用措辭）\n` : ''}${simInfo.stats && simInfo.stats.moves && simInfo.stats.moves.length ? `- 改寫句：${simInfo.stats.moves.map((m) => `p${m.para + 1}s${m.sent + 1} ppl ${m.pplBefore}→${m.pplAfter}`).join('、')}\n` : ''}` : ''}${citeCheck && (citeCheck.mismatches.length || citeCheck.checked) ? `\n## 引用一致性（8.2）\n\n- 內文引用 ${citeCheck.checked} 個 · References 條目 ${citeCheck.references} 筆\n${citeCheck.fixes.length ? `- 已自動對齊：${citeCheck.fixes.map((f) => `${f.from} → ${f.to}`).join('、')}\n` : ''}${citeCheck.mismatches.filter((m) => !m.fixed).length ? `- ⚠ 需人工核對：${citeCheck.mismatches.filter((m) => !m.fixed).map((m) => `${m.inText} vs [${m.refYears.join('/')}]`).join('、')}\n` : ''}` : ''}${qFix && qFix.surgeries ? `\n## 二級品質手術（8.2，CoLA < ${qFix.threshold}）\n\n${qFix.list.map((s) => `- 「${s.before}」→「${s.after}」`).join('\n')}\n` : ''}
${formCheck ? `\n## form 檢查\n\n引用 ${formCheck.citations} 個 / 數字 ${formCheck.numbers} 個：${formCheck.missingCitations.length || formCheck.missingNumbers.length ? `**缺 ${formCheck.missingCitations.length} 引用、${formCheck.missingNumbers.length} 數字，需人工核對**` : '全數保留 ✓'}\n` : ''}${arch90 ? archSection : ''}
## A → B

| 指標 | A（${chosen.crossover ? '重組X' : `cand${chosen.id}`}） | B | 變化 |
|---|---:|---:|---:|
| perplexity | ${fmt(chosen.score?.perplexity, 1)} | ${fmt(bScores?.perplexity, 1)} | — |
| p_ai_gen | ${fmt(chosen.score?.p_ai_gen)} | ${fmt(bScores?.p_ai_gen)} | ${fmt(deltaGen)} |
| p_ai_edit | ${fmt(chosen.score?.p_ai_edit)} | ${fmt(bScores?.p_ai_edit)} | **${fmt(deltaEdit)}** |

> EditLens delta 參考門檻 ${cfg.editLensDeltaAdvisory ?? 0.1}（歷史：5.1 失敗值 +0.09；5.0/6.0 安全值 +0.001）。

## 檔案

- A：${aDocx}
- 交付：${bDocx}
- v6 JSON：${v6Report}${bReport ? `\n- 修補報告：${bReport}` : ''}
`;
    fs.writeFileSync(path.join(outDir, `${base}.v6.report.md`), md, 'utf8');
    console.log(md);

    const finalName = args.k['final-name'] || 'final8.0';
    if (fs.existsSync(bDocx)) {
      const finalCopy = path.join(outDir, `${finalName}.docx`);
      fs.copyFileSync(bDocx, finalCopy);
      console.log(`交付檔：${finalCopy}`);
    // 8.10: final rescore — the delivery label must be post-ALL-steps (the
    // canary caught pre-surgery labels being 0.1-0.2 stale-low).
    const [finScore] = await scoreTexts([chosen.prose]);
    if (finScore) console.log(`交付終評：gen ${fmt(finScore.p_ai_gen)} ppl ${fmt(finScore.perplexity, 1)} edit ${fmt(finScore.p_ai_edit)}`);
    }
    console.log(`總耗時：${Math.round((Date.now() - T0) / 1000)}s（畫像 ${Math.round((profile.elapsedMs || 0) / 1000)}s）`);
    if (arch90 && archFinal && !archFinal.pass) {
      if (archKeptFailing) {
        console.log('9.0：交付未過三環否決且無綠點可回退（人工覆核）——exit 2');
        process.exitCode = 2;
      } else {
        console.log('9.0：交付否決已回退至最後綠點——exit 0（風險卡記錄否決與回退）');
      }
    }
  } finally {
    await closeDetector().catch(() => {});
  }
}

main().catch(async (e) => {
  console.error(e.stack || e.message);
  await closeDetector().catch(() => {});
  process.exit(1);
});
