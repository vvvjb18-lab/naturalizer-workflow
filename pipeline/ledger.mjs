// ledger.mjs — 9.0 L4 版本帳本：每次改動的前後、內容差、檢查結果、回退點。
// 北極星四問的數據來源：改善了什麼（維度 delta）、改壞了什麼（否決紀錄）、
// 哪些結論有證據（檢查引用）、什麼情況下停止（rollbackPoint）。
// 持久化為 <workDir>/.ledger.jsonl，逐行 append（崩潰安全）。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { splitSentences, wordCount, tokenSet } from '../polish/src/text.mjs';

const sha = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 10);

function maxContainment(set, sets) {
  if (!sets.length || !set.size) return 0;
  let best = 0;
  for (const s of sets) {
    let inter = 0;
    for (const t of set) if (s.has(t)) inter++;
    const c = inter / set.size;
    if (c > best) best = c;
  }
  return best;
}

/** 句級內容差：kept（保留）/ changed（改寫）/ added（新增）/ removed（丟失）。 */
export function diffSummary(before, after, lang = 'en') {
  const wb = wordCount(before, lang);
  const wa = wordCount(after, lang);
  const sb = splitSentences(before, lang).map((s) => s.text);
  const sa = splitSentences(after, lang).map((s) => s.text);
  const bt = sb.map((s) => tokenSet(s, lang));
  let kept = 0, changed = 0;
  for (const s of sa) {
    const c = maxContainment(tokenSet(s, lang), bt);
    if (c >= 0.9) kept++;
    else if (c >= 0.35) changed++;  // 0.35：實質改寫（內容詞重疊的 paraphrase）也算 changed
  }
  const added = Math.max(0, sa.length - kept - changed);
  const removed = Math.max(0, sb.length - kept - changed);
  return {
    words: { before: wb, after: wa, delta: wa - wb },
    sentences: { before: sb.length, after: sa.length },
    kept, changed, added, removed,
  };
}

/** 建立或恢復一個帳本。workDir 通常為 .v6-* 工作目錄。 */
export function createLedger(workDir, { docId = '' } = {}) {
  const file = path.join(workDir, '.ledger.jsonl');
  const entries = [];
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim();
      if (t) { try { entries.push(JSON.parse(t)); } catch { /* 壞行跳過 */ } }
    }
  }
  const flush = (e) => fs.appendFileSync(file, JSON.stringify(e) + '\n', 'utf8');

  return {
    file,
    get size() { return entries.length; },
    /** id=0 慣例為 original（stage:'original'）。 */
    append({ stage, label = '', before, after, checks = null, verdict = null, meta = null }) {
      const e = {
        id: entries.length,
        ts: new Date().toISOString(),
        stage, label,
        hashBefore: sha(before), hashAfter: sha(after),
        summary: diffSummary(before, after),
        checks, verdict, meta,
        before, after,
      };
      entries.push(e);
      flush(e);
      return e;
    },
    textAt(id) {
      const e = entries[id];
      if (!e) return null;
      return id === 0 ? (e.after ?? e.before) : e.after;
    },
    entryAt(id) {
      return entries[id] || null;
    },
    /** 全部「第一/二環綠且可回退」的候選條目（含 meta.paras 與 risk）。 */
    greenCandidates() {
      return entries.filter((e) => e.stage === 'candidate' && e.verdict?.pass === true && e.meta?.paras && Object.keys(e.meta.paras).length);
    },
    /** 最後一個「三環全綠且可回退」的版本（有段落映射或為 #0 原稿）；
     *  skeleton/reorg 等檢查類條目不攜帶段落映射，不作為回退點。 */
    rollbackPoint() {
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.verdict?.pass !== true) continue;
        if (i === 0) return 0;
        if (e.meta?.paras && Object.keys(e.meta.paras).length) return i;
      }
      return 0;
    },
    /** 給交付報告的四問數據。 */
    report() {
      const first = entries[0], last = entries[entries.length - 1];
      const vetoes = entries.flatMap((e) => (e.verdict?.vetoes || []).map((v) => ({ at: e.id, stage: e.stage, ...v })));
      const dimFirst = first?.verdict?.dimensions || null;
      const dimLast = last?.verdict?.dimensions || null;
      return {
        entries: entries.length,
        rollbackPoint: this.rollbackPoint(),
        improved: { words: last && first ? last.summary.words.after - first.summary.words.after : 0, dimensionsFirst: dimFirst, dimensionsLast: dimLast },
        vetoes,
        stages: entries.map((e) => ({ id: e.id, stage: e.stage, label: e.label, pass: e.verdict?.pass ?? null })),
      };
    },
  };
}
