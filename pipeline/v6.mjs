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
  mechanicalPolish,
} from './candidates.mjs';
import { detectLang, splitSentences, wordCount } from '../polish/src/text.mjs';
import { factNumbers, citationsIn } from '../polish/src/checks.mjs';

const HERE = import.meta.dirname;
const PIPELINE = path.resolve(HERE, 'pipeline.mjs');
const DOCX_BRIDGE = path.resolve(HERE, 'docx_bridge.py');

const HELP = `v6.mjs — Workflow 7.0（選擇式管線：早停 × 手術 × 段落重組 × NLI 守門）

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
  const useCrossover = cfg.crossover !== false;
  const useAdaptive = cfg.adaptive !== false;
  const gramThreshold = cfg.grammarThreshold ?? 0.5;

  const input = path.resolve(args._[0]);
  if (!fs.existsSync(input)) { console.error(`找不到原稿：${input}`); process.exit(1); }
  const ext = path.extname(input).toLowerCase();
  const isDocx = ext === '.docx';
  const outDir = path.resolve(args.k['out-dir'] || path.dirname(input));
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(input, ext);
  const workDir = path.join(outDir, `.v6-${base}`);
  fs.mkdirSync(workDir, { recursive: true });

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
    const targetIdx = Object.keys(plan.targets);
    if (!targetIdx.length) throw new Error('plan 沒有可改寫的段落（全是標題／引用／短段？）');
    const originalsByPara = {};
    for (const i of targetIdx) originalsByPara[i] = plan.targets[i].units.map((u) => u.text).join(' ');
    const originalProse = targetIdx.map((i) => originalsByPara[i]).join('\n\n');
    fs.writeFileSync(path.join(workDir, 'original.prose.txt'), originalProse + '\n', 'utf8');
    const lang = detectLang(originalProse) === 'zh' ? 'zh' : 'en';
    const docType = detectDocType(plan);
    if (args.k.form) docType.form = true;
    if (args.k.essay) docType.form = false;
    const unitTotal = Object.values(plan.targets).reduce((n, t) => n + t.units.length, 0);
    console.log(`  ${targetIdx.length} 段 · ${unitTotal} unit · lang=${lang}`);
    console.log(`  文件型別：${docType.form ? 'form／模板（V2 配方）' : 'essay（CV 帶選擇）'}（label 率 ${fmt(docType.formScore, 2)}）`);

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

    // 2 ── generate candidates (adaptive early-stop) ───────────────────────
    console.log(`=== 2/7 候選生成（K≤${cfg.candidates}${useAdaptive ? `，先 ${cfg.adaptiveFirst ?? 3} 個早停` : ''}）===`);
    const candidates = [];
    const stopCheck = async () => !useAdaptive
      ? false
      : candidates.length >= (cfg.adaptiveFirst ?? 3)
        && shouldStopEarly(candidates, { formMode: docType.form, target: cfg.target, cvBand: cfg.filters.cvBand });
    for (let k = 0; k < cfg.candidates; k++) {
      const sampling = cfg.samplings[k] || { temperature: 1.0, topP: 0.95 };
      console.log(`  candidate ${k + 1}/${cfg.candidates} (temp ${sampling.temperature}, top_p ${sampling.topP})`);
      const gen = await generateCandidate({
        plan, sampling, retries: cfg.unitRetries ?? 2, lang,
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
      candidates.push(c);
      console.log(`    coverage=${(gen.coverage * 100).toFixed(0)}% sents ${stats.sentencesBefore}->${stats.sentencesAfter} CV=${fmt(stats.cv, 3)} (x${fmt(stats.cvRatio, 2)}) damagePre=${fmt(c.grammarDamagePre)} copy=${fmt(stats.copyRate, 2)}${gen.failures.length ? ' FAIL: ' + gen.failures.map((f) => f.reason).join('; ') : ''}`);
      if (await stopCheck()) {
        console.log(`  早停：已有 ${candidates.length} 個候選且至少一個落在可交付區，跳過剩餘生成`);
        break;
      }
    }

    // 3 ── offline scoring ─────────────────────────────────────────────────
    console.log('=== 3/7 離線評分（daemon：CoLA + tmr/EditLens/perplexity）===');
    const origDamage = await damageOf(originalProse);
    const scores = await scoreFiles([...candidates.map((c) => c.prosePath), path.join(workDir, 'original.prose.txt')]);
    const originalScore = scores[scores.length - 1];
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
    if (!eligible.length) throw new Error('沒有候選通過硬過濾；提高 --candidates 或放寬 v6.config.json');

    let pool = [...candidates];
    let assembled = null;
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
        pool = [...candidates, assembled];
        const froms = Object.values(xo.provenance).join(',');
        console.log(`  重組 X：逐段取自 cand{${froms}} · CV=${fmt(stats.cv, 3)} damage=${fmt(assembled.grammarDamage)}`);
      } else {
        console.log('  重組跳過（可用候選 < 2）');
      }
    }

    ({ eligible, rejected } = rankCandidates(pool, { weights: cfg.weights, filters: { ...cfg.filters, formMode: docType.form } }));

    let chosen = null;
    for (const c of eligible) {
      if (lang === 'zh') {
        // NLI cross-encoder is English-only: on zh input it returns garbage
        // entailment scores and blocks clean candidates (C4 lesson).
        c.nli = null;
        console.log('  zh 文稿：NLI 守門跳過（英文模型不適用）');
        chosen = c;
        break;
      }
      const pairs = targetIdx.map((i) => [originalsByPara[i], c.paras[i] || '']);
      let nli = null;
      try {
        nli = await nliPairs(pairs);
      } catch (e) {
        console.log(`  ${c.id === 'X' ? '重組X' : 'cand' + c.id} NLI 失敗（${e.message}），跳過守門`);
        c.nli = null;
        chosen = c;
        break;
      }
      const worst = nli.reduce((a, b) => (b.contradict > a.contradict ? b : a), { contradict: 0 });
      c.nli = { maxContradict: worst.contradict, meanEntail: nli.reduce((a, b) => a + (b.entail || 0), 0) / Math.max(1, nli.length) };
      console.log(`  ${c.id === 'X' ? '重組X' : 'cand' + c.id} risk=${fmt(c.risk)} NLI: maxContradict=${fmt(worst.contradict)} meanEntail=${fmt(c.nli.meanEntail)}`);
      if (worst.contradict > 0.5) { console.log(`  ${c.id === 'X' ? '重組X' : 'cand' + c.id} NLI 矛盾過高，換下一個`); continue; }
      chosen = c;
      break;
    }
    if (!chosen) throw new Error('所有 eligible 候選都被 NLI 擋下');
    console.log(`  → 選定 ${chosen.crossover ? '重組 X' : `cand${chosen.id}`}`);

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

    const aDocx = path.join(outDir, `${base}.v6-A.docx`);
    const aProse = path.join(outDir, `${base}.v6-A.prose.txt`);
    fs.writeFileSync(aProse, chosen.prose + '\n', 'utf8');
    if (isDocx) {
      const map = {
        indices: Object.keys(chosen.paras).map(Number),
        texts: Object.keys(chosen.paras).map((i) => chosen.paras[i]),
      };
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
      editLensDeltaAdvisory: cfg.editLensDeltaAdvisory ?? 0.1,
      files: { aDocx, aProse, bDocx, bReport },
    };
    const v6Report = path.join(outDir, `${base}.v6.report.json`);
    fs.writeFileSync(v6Report, JSON.stringify(report, null, 1), 'utf8');

    const rows = pool.map((c) => `| ${c.crossover ? 'X' : c.id}${c.crossover ? '（重組）' : ''} | ${(c.stats.coverage * 100).toFixed(0)}% | ${fmt(c.stats.cv, 3)} | ${fmt(c.grammarDamagePre)} | ${fmt(c.grammarDamage)} | ${(c.surgeries || []).length} | ${fmt(c.score?.perplexity, 1)} | ${fmt(c.score?.p_ai_gen)} | ${fmt(c.score?.p_ai_edit)} | ${fmt(c.nli?.maxContradict)} | ${eligible.includes(c) ? fmt(c.risk) : '淘汰'} |`).join('\n');
    const md = `# Workflow 7.0 風險卡

- 生成時間：${report.generatedAt}
- 原稿：${input} · 語言 ${lang} · 型別 **${docType.form ? 'form／模板（V2 配方）' : 'essay（CV 帶）'}**
- 候選 ${candidates.length}${assembled ? ' + 重組 X' : ''} · 手術 ${pool.reduce((n, c) => n + (c.surgeries || []).length, 0)} 處 · 選定 **${chosen.crossover ? '重組 X' : `cand${chosen.id}`}${chosen.crossover ? `（逐段取自 cand{${Object.values(chosen.provenance).join(',')}}）` : ''}**

## 候選對照

| # | 覆蓋 | CV | 傷率(術前) | 傷率(術後) | 手術 | ppl | p_ai_gen | p_ai_edit | NLI矛盾 | risk |
|---|---|---|---|---|---|---|---|---|---|---|
${rows}

原稿基準：ppl ${fmt(originalScore?.perplexity, 1)} · gen ${fmt(originalScore?.p_ai_gen)} · edit ${fmt(originalScore?.p_ai_edit)} · 語法傷率 ${fmt(origDamage)}
${formCheck ? `\n## form 檢查\n\n引用 ${formCheck.citations} 個 / 數字 ${formCheck.numbers} 個：${formCheck.missingCitations.length || formCheck.missingNumbers.length ? `**缺 ${formCheck.missingCitations.length} 引用、${formCheck.missingNumbers.length} 數字，需人工核對**` : '全數保留 ✓'}\n` : ''}
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

    const finalName = args.k['final-name'] || 'final7.0';
    if (fs.existsSync(bDocx)) {
      const finalCopy = path.join(outDir, `${finalName}.docx`);
      fs.copyFileSync(bDocx, finalCopy);
      console.log(`交付檔：${finalCopy}`);
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
