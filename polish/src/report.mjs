// Markdown + JSON report writer.

import { docMetrics } from './checks.mjs';

const GATE_NAMES = {
  language: '語言一致',
  rhythm: '句長節奏未被抹平',
  'ai-phrases': 'AI 套語未增加',
  structure: '沒有新增列表／編號／標題',
  numbers: '數字完整',
  citations: '引用完整',
  'edit-budget': '修改幅度在預算內',
  duplicates: '沒有新增重複句',
  truncation: '結尾完整',
  register: '語域未退步',
};

function esc(s) {
  return String(s ?? '').replace(/\r/g, '');
}

function metricRows(before, after) {
  const rows = [
    ['字數', before.words, after.words],
    ['句數', before.sentences, after.sentences],
    ['平均句長', before.mean, after.mean],
    ['句長標準差', before.sd, after.sd],
    ['句長變異係數（節奏）', before.cv, after.cv],
    ['短句比例', before.shortRatio, after.shortRatio],
    ['長句比例', before.longRatio, after.longRatio],
    ['段落數', before.paragraphs, after.paragraphs],
    ['AI 套語', before.aiPhrases, after.aiPhrases],
    ['口語詞', before.colloquial, after.colloquial],
    ['縮寫（don\'t 等）', before.contractions, after.contractions],
    ['第二人稱', before.secondPerson, after.secondPerson],
    ['問句', before.questions, after.questions],
    ['模糊限制詞', before.hedges, after.hedges],
    ['結構標記', before.structure, after.structure],
    ['數字', before.numbers, after.numbers],
    ['引用標記', before.citations, after.citations],
  ];
  return rows.map(([k, a, b]) => `| ${k} | ${a} | ${b} | ${a === b ? '' : a > b ? '↓' : '↑'} |`).join('\n');
}

function comparisonRows(draftText, humanizedText, outputText, lang) {
  const d = docMetrics(draftText || '', lang);
  const a = docMetrics(humanizedText || '', lang);
  const b = docMetrics(outputText || '', lang);
  const rows = [
    ['字數', d.words, a.words, b.words],
    ['段落', d.paragraphs, a.paragraphs, b.paragraphs],
    ['句數', d.sentences, a.sentences, b.sentences],
    ['平均句長', d.mean, a.mean, b.mean],
    ['句長變異係數', d.cv, a.cv, b.cv],
    ['列表／編號標記', d.structure, a.structure, b.structure],
    ['數字', d.numbers, a.numbers, b.numbers],
    ['引用標記', d.citations, a.citations, b.citations],
    ['口語詞', d.colloquial, a.colloquial, b.colloquial],
    ['縮寫', d.contractions, a.contractions, b.contractions],
    ['第二人稱', d.secondPerson, a.secondPerson, b.secondPerson],
  ];
  return rows.map(([k, x, y, z]) => `| ${k} | ${x} | ${y} | ${z} |`).join('\n');
}

export function buildReport({ inputName, draftName, outputName, cfg, result, generatedAt, draftText = '', humanizedText = '' }) {
  const s = result.stats;
  const failedGates = result.gates.filter((g) => !g.ok);
  const critical = result.unresolved.filter((u) => u.severity === 'critical');
  const major = result.unresolved.filter((u) => u.severity === 'major');
  const isAudit = !!result.auditOnly;
  const verdict = isAudit
    ? `審查模式：發現 ${s.found} 項缺陷，未修改任何文字`
    : failedGates.length === 0 && critical.length === 0
      ? (major.length
        ? `可交付，但仍有 ${major.length} 項 major 建議人工覆核`
        : '通過：所有硬性檢查正常')
      : `不建議交付：${failedGates.length} 項硬性檢查未通過、${critical.length} 項嚴重問題未解決`;

  const patchBlocks = result.patches.map((p, i) => `### ${i + 1}. [${p.type}] ${p.severity} · ${p.round === 'cleanup' ? '監督輪' : p.round === 2 ? '驗證輪' : '第一輪'} · 第 ${p.chunk} 段 · issue ${p.id}
${p.note ? `> ${p.note}\n` : ''}
**修改前**
~~~text
${esc(p.before)}
~~~
**修改後**
~~~text
${esc(p.after)}
~~~`).join('\n\n');

  const unresolvedBlocks = result.unresolved.length
    ? result.unresolved.map((u) => `- **[${u.type}/${u.severity}]** ${u.problem || ''}\n  - 原文：\`${esc(u.quote).slice(0, 220)}\`\n  - 原因：${u.reason}`).join('\n')
    : '（無）';

  const manual = result.manual.length
    ? result.manual.map((m) => `- [ ] ${m}`).join('\n')
    : '- [ ] 無需額外處理';

  const errors = result.errors.length
    ? result.errors.map((e) => `- ${e}`).join('\n')
    : '（無）';

  const gateLines = result.gates.length
    ? result.gates.map((g) => `| ${GATE_NAMES[g.name] || g.name} | ${g.ok ? '✅' : '⚠️'} | ${g.detail} |`).join('\n')
    : '| — | — | 審查模式，未執行修補校驗 |';

  return `# 學術性修補報告

- 生成時間：${generatedAt}
- Humanizer 輸出：${inputName}
- 原始草稿：${draftName || '（未提供，無法比對事實與引用）'}
- 輸出檔：${outputName}
- 模型：${cfg.preset || cfg.provider} / ${cfg.model}
- 語言：${result.lang}
- 耗時：${(result.elapsedMs / 1000).toFixed(0)} 秒

## 結論

**${verdict}**

共發現 ${s.found} 項缺陷${s.verificationFound ? `（驗證輪另發現 ${s.verificationFound} 項）` : ''}${isAudit
    ? `，未套用任何修改（審查模式）。`
    : `，實際修補 **${s.applied}** 處${s.cleanupActions ? `（監督輪 ${s.cleanupActions} 處${s.rewrites ? `，改寫 ${s.rewrites} 句` : ''}${s.forced ? `，強制 ${s.forced} 處` : ''}）` : ''}，改動 **${(s.changedRatio * 100).toFixed(1)}%** 的字詞（${s.changedWords} 字；本次預算 ${s.budgetWords ?? '—'} 字），仍有 **${result.unresolved.length}** 項未自動處理。Humanizer 原有的句長節奏保留率為 ${result.metrics.before.cv ? ((result.metrics.after.cv / result.metrics.before.cv) * 100).toFixed(0) : '—'}%。`}

## 硬性檢查

| 檢查 | 結果 | 說明 |
|---|---|---|
${gateLines}

## 三稿對照（格式核對）

| 指標 | 原文 | Humanizer（A） | 修補後（B） |
|---|---:|---:|---:|
${comparisonRows(draftText, humanizedText, result.outputText, result.lang)}

> 段落數、句數不同是正常的：Humanizer 會重組句子，修補層不重排段落。要看的是數字、引用、列表／編號標記，以及節奏指標有沒有異常。

**格式核對**
- [ ] 沒有新增 \`(1)(2)(3)\`、項目符號、Markdown 標題
- [ ] 數字、日期、人名、單位與原文一致
- [ ] 引用標記數量與位置合理
- [ ] 段落沒有被意外合併或拆成清單
- [ ] 句長節奏沒有明顯被抹平（看上面的變異係數）
- [ ] A → B 的每一處改動都能在「修補明細」找到

### 原始草稿
~~~text
${draftText ? esc(draftText) : '（未提供原始草稿）'}
~~~

### Humanizer 輸出（A）
~~~text
${esc(humanizedText || '（未提供 Humanizer 輸出）')}
~~~

### 修補後（B）
~~~text
${esc(result.outputText)}
~~~${isAudit ? '\n\n（審查模式：B 同 A，未套用修改。）' : ''}

## 指標對照（A → B）

| 指標 | Humanizer 輸出 | 修補後 | 變化 |
|---|---:|---:|---|
${metricRows(result.metrics.before, result.metrics.after)}

## 修補明細（${result.patches.length} 處）

${patchBlocks || '（沒有套用任何修改）'}

## 未自動處理（${result.unresolved.length} 項）

${unresolvedBlocks}

## 人工覆核清單

${manual}

## 執行紀錄與錯誤

${errors}

---

### 使用提醒

1. 這一步只做「外科修補」，不會重寫未被標記的句子；句長節奏指標若明顯下降，代表模型越界了，請把該次結果退回。
2. 引用與數字以原始草稿為準。工具不會發明引用；未找回的引用列在人工清單。
3. 任何修改都可能改變 Turnitin 分數。交付前請務必重新跑一次正式報告，不要沿用修改前的截圖。
4. 模型編輯具有隨機性；同一份稿件連跑兩次可能得到不同的小修補，屬正常現象。
`;
}

export function buildJsonReport({ inputName, draftName, cfg, result, generatedAt, draftText = '', humanizedText = '' }) {
  return {
    generatedAt,
    input: inputName,
    draft: draftName || null,
    model: { provider: cfg.preset || cfg.provider, name: cfg.model, baseUrl: cfg.baseUrl },
    lang: result.lang,
    elapsedMs: result.elapsedMs,
    stats: result.stats,
    gates: result.gates,
    metrics: result.metrics,
    texts: {
      original: draftText,
      humanized: humanizedText,
      output: result.outputText,
    },
    patches: result.patches.map((p) => ({
      id: p.id, type: p.type, severity: p.severity,
      before: p.before, after: p.after, note: p.note, chunk: p.chunk,
    })),
    unresolved: result.unresolved,
    manual: result.manual,
    errors: result.errors,
    context: result.context,
  };
}
