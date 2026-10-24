'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  running: false,
  mode: 'v6',
  original: '',
  a: '',
  b: '',
  fullA: '',
  fullB: '',
  report: '',
  result: null,
  hz: null,
  auditOnly: false,
  docx: null,
  docxMode: false,
  logLines: 0,
};

// ── small helpers ───────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function showError(msg) {
  const el = $('error');
  el.hidden = false;
  el.textContent = String(msg || '發生錯誤');
}

function clearError() {
  const el = $('error');
  el.hidden = true;
  el.textContent = '';
}

function setRunning(on) {
  state.running = on;
  $('run').disabled = on;
  $('run').textContent = on ? '執行中…' : '開始';
  $('pick').disabled = on;
}

function appendLog(line) {
  const el = $('log');
  state.logLines += 1;
  el.textContent += `${line}\n`;
  if (state.logLines > 600) {
    const lines = el.textContent.split('\n');
    el.textContent = lines.slice(-400).join('\n');
    state.logLines = 400;
  }
  el.scrollTop = el.scrollHeight;
  $('logCount').textContent = `（${state.logLines} 行）`;
}

// 每種做法的用戶可見步驟：label 給人看，keys 對應 server 推來的內部 stage。
const STEP_DEFS = {
  v6: [
    { label: '產生候選版本', keys: ['plan', 'generate'] },
    { label: '選出最好的', keys: ['score'] },
    { label: '逐句修整・檢查', keys: ['surgery', 'deliver'] },
  ],
  classic: [
    { label: '改寫一次', keys: ['humanize'] },
    { label: '修補與檢查', keys: ['polish'] },
  ],
};

function renderSteps() {
  const defs = STEP_DEFS[state.mode] || [];
  $('steps').innerHTML = defs
    .map((d, i) => `<div class="step" data-step="${d.keys[0]}"><span>${i + 1}</span>${esc(d.label)}</div>`)
    .join('');
}

function setStage(stage) {
  const defs = STEP_DEFS[state.mode] || [];
  const stepIdx = (name) => defs.findIndex((d) => d.keys.includes(name));
  const idx = stage === 'done' ? defs.length : stepIdx(stage);
  if (stage !== 'done' && idx < 0) return;
  document.querySelectorAll('#steps .step').forEach((el) => {
    const i = stepIdx(el.dataset.step);
    if (i < 0) return;
    el.classList.toggle('active', i === idx && stage !== 'done');
    el.classList.toggle('done', i < idx || stage === 'done');
  });
  if (stage === 'done') {
    $('progressTitle').textContent = '完成';
    $('progressStep').textContent = '';
  } else {
    $('progressTitle').textContent = '進行中';
    $('progressStep').textContent = `第 ${idx + 1} / ${defs.length} 步 · ${defs[idx] ? defs[idx].label : ''}`;
  }
}

function resetStages() {
  document.querySelectorAll('.step').forEach((el) => el.classList.remove('active', 'done'));
}

// ── word diff ───────────────────────────────────────────────────────────────

function tokenize(s) {
  return String(s).match(/\s+|[\u3400-\u4DBF\u4E00-\u9FFF]|[^\s\u3400-\u4DBF\u4E00-\u9FFF]+/g) || [];
}

function diffPair(a, b) {
  const A = tokenize(a);
  const B = tokenize(b);
  const n = A.length;
  const m = B.length;
  if (!n && !m) return { left: [], right: [] };
  if (n * m > 12_000_000 || n > 6000 || m > 6000) return null;

  const m1 = m + 1;
  const dp = new Uint32Array((n + 1) * m1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i * m1 + j] = A[i - 1] === B[j - 1]
        ? dp[(i - 1) * m1 + (j - 1)] + 1
        : Math.max(dp[(i - 1) * m1 + j], dp[i * m1 + (j - 1)]);
    }
  }

  const left = [];
  const right = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (A[i - 1] === B[j - 1]) {
      left.push({ t: A[i - 1], k: 'same' });
      right.push({ t: B[j - 1], k: 'same' });
      i--; j--;
    } else if (dp[(i - 1) * m1 + j] >= dp[i * m1 + (j - 1)]) {
      left.push({ t: A[i - 1], k: 'del' });
      i--;
    } else {
      right.push({ t: B[j - 1], k: 'ins' });
      j--;
    }
  }
  while (i > 0) { left.push({ t: A[i - 1], k: 'del' }); i--; }
  while (j > 0) { right.push({ t: B[j - 1], k: 'ins' }); j--; }
  left.reverse();
  right.reverse();
  return { left, right };
}

function tokensHtml(tokens) {
  if (!tokens) return '';
  return tokens.map((x) => (x.k === 'same' ? esc(x.t) : `<span class="${x.k}">${esc(x.t)}</span>`)).join('');
}

function renderPanes() {
  const on = $('diff').checked;
  const original = state.original;
  const a = state.a;
  const b = state.b;
  const pO = $('paneOriginal');
  const pA = $('paneA');
  const pB = $('paneB');

  if (!on) {
    pO.textContent = original;
    pA.textContent = a || '（沒有 A）';
    pB.textContent = state.auditOnly ? '（審查模式：未產生 B）' : (b || '（沒有 B；請看執行紀錄）');
    return;
  }

  const d1 = diffPair(original, a);
  const d2 = b ? diffPair(a, b) : null;
  pO.innerHTML = d1 ? tokensHtml(d1.left) : esc(original);
  pA.innerHTML = d1 ? tokensHtml(d1.right) : esc(a || '（沒有 A）');
  pB.innerHTML = state.auditOnly
    ? esc('（審查模式：未產生 B）')
    : (d2 ? tokensHtml(d2.right) : esc(b || '（沒有 B；請看執行紀錄）'));
}

// ── result rendering ────────────────────────────────────────────────────────

function statCard(k, v, sub, cls = '') {
  return `<div class="stat ${cls}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(sub || '')}</div></div>`;
}

function renderSummary(ev) {
  const result = ev.result || {};
  const stats = result.stats || {};
  const unresolved = result.unresolved || [];
  const gates = result.gates || [];
  const failed = gates.filter((g) => !g.ok);
  const applied = stats.applied ?? (result.patches ? result.patches.length : 0);
  const ratio = typeof stats.changedRatio === 'number' ? `${(stats.changedRatio * 100).toFixed(1)}%` : '—';
  const major = unresolved.filter((u) => u.severity !== 'minor').length;

  const hz = ev.hz && ev.hz.summary ? ev.hz.summary : null;
  let hzValue = '—';
  let hzSub = '未執行 hz';
  if (hz) {
    hzValue = `${Math.round(hz.seconds || 0)}s`;
    const copy = typeof hz.copy_rate === 'number' ? `${(hz.copy_rate * 100).toFixed(1)}%` : '—';
    hzSub = `複製率 ${copy} · ${hz.pieces ?? '—'} 段 · ${hz.words_in ?? '—'}→${hz.words_out ?? '—'} 字`;
  } else if (ev.a) {
    const words = result?.metrics?.before?.words;
    hzValue = typeof words === 'number' ? `${words} 字` : `${ev.a.trim().length} 字`;
    hzSub = '沿用既有 Humanizer 輸出';
  }

  const cards = [
    statCard('實際修補', `${applied} 處`, `改動 ${ratio}${stats.rewrites ? ` · 改寫 ${stats.rewrites} 句` : ''}`, 'good'),
    statCard('未解決', `${unresolved.length} 項`, `${major ? `${major} 項 major / critical` : '沒有 major / critical'}${stats.judgeFail ? ` · 品質退回 ${stats.judgeFail}` : ''}${stats.forced ? ` · 強制 ${stats.forced}` : ''}`, unresolved.length ? 'warn' : 'good'),
    statCard('硬性檢查', failed.length ? `${failed.length} 項未通過` : '全部通過', failed.length ? failed.map((g) => g.name).join(', ') : '數字、引用、結構、節奏', failed.length ? 'bad' : 'good'),
    statCard('Humanizer', hzValue, hzSub, ''),
  ];
  $('summary').innerHTML = cards.join('');
}

function renderUnresolved(ev) {
  const list = (ev.result && ev.result.unresolved) || [];
  const box = $('unresolved');
  const card = $('unresolvedCard');
  box.textContent = '';
  if (!list.length) { card.hidden = true; return; }
  card.hidden = false;

  const rank = { critical: 0, major: 1, minor: 2 };
  const sorted = [...list].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));

  for (const u of sorted) {
    const el = document.createElement('div');
    el.className = `issue ${u.severity || 'minor'}`;
    const head = document.createElement('div');
    head.className = 'head';
    const badge = document.createElement('span');
    badge.className = `badge ${u.severity || ''}`;
    badge.textContent = u.severity || 'minor';
    head.appendChild(badge);
    const type = document.createElement('span');
    type.textContent = u.type || '';
    head.appendChild(type);
    el.appendChild(head);

    const p = document.createElement('p');
    p.textContent = u.problem || '';
    el.appendChild(p);

    if (u.quote) {
      const q = document.createElement('div');
      q.className = 'quote';
      q.textContent = u.quote;
      el.appendChild(q);
    }
    if (u.reason) {
      const r = document.createElement('div');
      r.className = 'reason';
      r.textContent = u.reason;
      el.appendChild(r);
    }
    box.appendChild(el);
  }
}

function renderReport(ev) {
  $('report').textContent = ev.report || '（沒有報告，請看執行紀錄）';
}

function renderRiskCard(v6) {
  const card = $('riskCard');
  if (!v6) { card.hidden = true; return; }
  card.hidden = false;
  const f = (x, d = 3) => (x == null || !Number.isFinite(x) ? '—' : Number(x).toFixed(d));
  const chosen = v6.candidates?.find((c) => c.id === v6.chosen);
  const chips = [];
  const push = (ok, text) => chips.push(`<span class="chip ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'} ${esc(text)}</span>`);
  if (chosen) {
    const cv = chosen.stats?.cv;
    const cvOk = cv != null && cv >= 0.45 && cv <= 0.65;
    push(true, v6.docType?.form ? '模板類稿件 · 保守處理' : '語句節奏 自然');
    push((chosen.grammarDamage ?? 0) <= 0.08, '文法檢查');
    push((chosen.stats?.coverage ?? 0) >= 1, '全部段落已處理');
    const nli = chosen.nli;
    if (nli) push((nli.maxContradict ?? 0) <= 0.5, '論點與原文一致');
    push((chosen.surgeries ?? 0) > 0, `逐句修正 ${chosen.surgeries ?? 0} 處`);
  }
  const d = v6.deltas || {};
  push(Math.abs(d.p_ai_edit ?? 0) <= 0.05, '修改僅限必要處');
  $('riskChips').innerHTML = chips.join('');

  const rows = (v6.candidates || []).map((c) => {
    const risk = typeof c.risk === 'number' ? f(c.risk) : (c.eligible ? '—' : '淘汰');
    const cls = c.id === v6.chosen ? ' class="chosen"' : '';
    return `<tr${cls}><td>${c.id}</td><td>${Math.round((c.stats?.coverage ?? 0) * 100)}%</td>`
      + `<td>${f(c.stats?.cv)}</td><td>${f(c.grammarDamagePre)}</td><td>${f(c.grammarDamage)}</td>`
      + `<td>${c.surgeries ?? 0}</td><td>${f(c.score?.p_ai_gen)}</td>`
      + `<td>${f(c.nli?.maxContradict)}</td><td>${risk}</td></tr>`;
  }).join('');
  $('riskTable').innerHTML = `<thead><tr><th>#</th><th>覆蓋</th><th>CV</th><th>傷率·前</th><th>傷率·後</th><th>手術</th><th>p_ai_gen</th><th>NLI矛盾</th><th>risk</th></tr></thead><tbody>${rows}</tbody>`;
}

function finish(ev) {
  state.a = ev.a || '';
  state.b = ev.b || '';
  state.fullA = ev.fullA || ev.a || '';
  state.fullB = ev.fullB || ev.b || '';
  state.report = ev.report || '';
  state.result = ev.result || null;
  state.hz = ev.hz || null;
  state.auditOnly = !!ev.auditOnly;
  state.docxMode = !!ev.docx;
  if (ev.docx) {
    const texts = (ev.result && ev.result.texts) || {};
    state.original = texts.original || ev.original || ev.fullA || '';
  }

  const note = $('docxNote');
  if (ev.docx) {
    const n = ev.pipeline && ev.pipeline.changedParagraphs;
    const total = ev.pipeline && ev.pipeline.paragraphs;
    note.hidden = false;
    note.textContent = `docx 模式：三欄只顯示 hz 實際改寫的${n ? ` ${n} 段` : '段落'}${total ? `（共 ${total} 段）` : ''}；標題、表格、References 保持原樣。全文請下載 A/B.docx 或 A/B.txt。`;
    $('dlADocx').href = (ev.files && ev.files.aDocx) || '#';
    $('dlADocx').hidden = !(ev.files && ev.files.aDocx);
    $('dlBDocx').href = (ev.files && ev.files.bDocx) || '#';
    $('dlBDocx').hidden = !(ev.files && ev.files.bDocx);
    $('dlA').textContent = '下載 A.txt';
    $('dlB').textContent = '下載 B.txt';
    $('copyB').textContent = '複製 B 段落';
  } else {
    note.hidden = true;
    $('dlADocx').hidden = true;
    $('dlBDocx').hidden = true;
    $('dlA').textContent = '下載 A';
    $('dlB').textContent = '下載 B';
    $('copyB').textContent = '複製 B';
  }

  $('progress').hidden = false;
  $('results').hidden = false;
  setStage('done');
  if (ev.mode === 'v6') {
    renderRiskCard(ev.v6);
    const v6 = ev.v6 || {};
    const chosen = (v6.candidates || []).find((c) => c.id === v6.chosen) || {};
    const totalCands = (v6.candidates || []).length;
    const cards = [
      statCard('稿件類型', v6.docType?.form ? '模板／計劃書' : '文章', v6.docType?.form ? '已按模板類保守處理' : '文章類流程', ''),
      statCard('採用版本', `第 ${v6.chosen ?? '—'} 個（共 ${totalCands} 個）`, '從多個版本中挑選最好', 'good'),
      statCard('逐句修正', `${chosen.surgeries ?? 0} 處`, '只改有問題的句子，保留自然語感', 'good'),
      statCard('品質檢查', '已通過', '節奏・文法・引用與數字・論點一致', 'good'),
    ];
    $('summary').innerHTML = cards.join('');
    $('unresolvedCard').hidden = true;
    $('dlRisk').href = (ev.files && ev.files.report) || '#';
    $('dlRisk').hidden = !(ev.files && ev.files.report);
  } else {
    renderRiskCard(null);
    $('dlRisk').hidden = true;
    renderSummary(ev);
    renderUnresolved(ev);
  }
  renderPanes();
  renderReport(ev);
  setRunning(false);

  if (ev.exitCode === 1 || ev.ok === false) {
    showError('管線沒有完成。看「執行紀錄」與報告的錯誤欄位。');
  }
  window.scrollTo({ top: $('results').offsetTop - 20, behavior: 'smooth' });
}

// ── API ─────────────────────────────────────────────────────────────────────

function dispatch(ev) {
  if (!ev || !ev.type) return;
  if (ev.type === 'start') {
    appendLog(`run ${ev.runId}`);
    return;
  }
  if (ev.type === 'log') {
    appendLog(ev.line);
    return;
  }
  if (ev.type === 'stage') {
    setStage(ev.stage);
    return;
  }
  if (ev.type === 'error') {
    const engine = /fetch failed|47615|ECONNREFUSED|engine/i.test(ev.message || '');
    showError(engine
      ? `${ev.message}

通常的原因：Humanizer 引擎（桌面 App）沒有開啟。開啟 App、等它顯示就緒後再試一次。`
      : ev.message);
    $('progressTitle').textContent = '出錯了';
    $('progressStep').textContent = '';
    setRunning(false);
    return;
  }
  if (ev.type === 'done') finish(ev);
}

async function run() {
  if (state.running) return;
  clearError();

  const docx = state.docx;
  const original = $('original').value.replace(/\r\n?/g, '\n').trim();
  const hasA = !docx && $('hasA').checked;
  const humanized = hasA ? $('humanized').value.replace(/\r\n?/g, '\n').trim() : '';
  if (!docx && !original) { showError('請先貼上原始草稿，或選擇一個 .docx。'); $('original').focus(); return; }
  if (!docx && hasA && !humanized) { showError('勾選了「已有 Humanizer 輸出」，但內容是空的。'); $('humanized').focus(); return; }

  state.original = docx ? '' : original;
  state.a = '';
  state.b = '';
  state.fullA = '';
  state.fullB = '';
  state.report = '';
  state.result = null;
  state.hz = null;
  state.logLines = 0;
  $('log').textContent = '';
  $('logCount').textContent = '';
  $('results').hidden = true;
  $('progress').hidden = false;
  resetStages();
  setStage(state.mode === 'v6' ? 'plan' : 'humanize');
  setRunning(true);
  appendLog('送出…');

  let res;
  try {
    res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.mode === 'v6'
        ? (docx
            ? { mode: 'v6', target: $('lowAi').checked ? 'ideal' : 'balanced', docxName: docx.name, docxBase64: docx.base64 }
            : { mode: 'v6', target: $('lowAi').checked ? 'ideal' : 'balanced', original })
        : (docx
            ? {
                docxName: docx.name,
                docxBase64: docx.base64,
                verify: $('verify').value,
                lang: $('lang').value,
                auditOnly: $('auditOnly').checked,
              }
            : {
                original,
                humanized,
                verify: $('verify').value,
                lang: $('lang').value,
                auditOnly: $('auditOnly').checked,
              })),
    });
  } catch (e) {
    setRunning(false);
    showError(`連不上本機服務：${e.message}`);
    return;
  }

  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try {
      const t = await res.text();
      try { msg = JSON.parse(t).error || t; } catch { msg = t || msg; }
    } catch { /* ignore */ }
    setRunning(false);
    showError(msg);
    return;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try { dispatch(JSON.parse(line)); } catch { appendLog(line); }
      }
    }
    if (buf.trim()) {
      try { dispatch(JSON.parse(buf.trim())); } catch { appendLog(buf.trim()); }
    }
  } catch (e) {
    setRunning(false);
    showError(`讀取結果時出錯：${e.message}`);
  }
}

// ── downloads / clipboard ───────────────────────────────────────────────────

function download(name, text) {
  if (!text) { showError(`沒有 ${name} 可下載。`); return; }
  const blob = new Blob([text.endsWith('\n') ? text : `${text}\n`], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function copyB() {
  if (!state.b) { showError('沒有 B 可複製。'); return; }
  try {
    await navigator.clipboard.writeText(state.b);
    const btn = $('copyB');
    const old = btn.textContent;
    btn.textContent = '已複製';
    setTimeout(() => { btn.textContent = old; }, 1200);
  } catch {
    showError('瀏覽器不允許剪貼簿；請用下載 B。');
  }
}

// ── input wiring ────────────────────────────────────────────────────────────

function clearDocx() {
  state.docx = null;
  $('fileChip').hidden = true;
  $('fileName').textContent = '';
  $('original').disabled = false;
  $('original').placeholder = '貼上原始草稿，或把 .txt / .md / .docx 拖進來…';
  $('hasAWrap').hidden = false;
}

function readFile(file) {
  if (!file) return;
  if (/\.docx$/i.test(file.name)) {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      state.docx = { name: file.name, base64: url.split(',')[1] || '' };
      $('fileName').textContent = file.name;
      $('fileChip').hidden = false;
      $('original').value = '';
      $('original').disabled = true;
      $('original').placeholder = '已選擇 docx；伺服器會解析段落，只修補 Humanizer 改寫的段落。';
      $('hasAWrap').hidden = true;
      $('hasA').checked = false;
      $('aWrap').hidden = true;
      clearError();
    };
    reader.onerror = () => showError('讀不到 docx。');
    reader.readAsDataURL(file);
    return;
  }
  if (!/\.(txt|md)$/i.test(file.name) && !/^text\//.test(file.type)) {
    showError('只支援 .txt / .md / .docx。');
    return;
  }
  clearDocx();
  const reader = new FileReader();
  reader.onload = () => {
    $('original').value = String(reader.result || '');
    clearError();
  };
  reader.onerror = () => showError('讀不到檔案。');
  reader.readAsText(file, 'utf-8');
}

$('pick').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  readFile(f);
  e.target.value = '';
});
$('fileClear').addEventListener('click', () => {
  clearDocx();
  $('original').focus();
});

const ta = $('original');
['dragenter', 'dragover'].forEach((ev) => ta.addEventListener(ev, (e) => { e.preventDefault(); ta.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((ev) => ta.addEventListener(ev, (e) => { e.preventDefault(); ta.classList.remove('dragging'); }));
ta.addEventListener('drop', (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  readFile(f);
});

$('hasA').addEventListener('change', () => {
  $('aWrap').hidden = !$('hasA').checked;
  if ($('hasA').checked) $('humanized').focus();
});

$('run').addEventListener('click', run);
$('clear').addEventListener('click', () => {
  $('original').value = '';
  $('humanized').value = '';
  $('hasA').checked = false;
  $('aWrap').hidden = true;
  $('results').hidden = true;
  $('progress').hidden = true;
  $('log').textContent = '';
  $('logCount').textContent = '';
  $('report').textContent = '';
  $('summary').innerHTML = '';
  $('unresolved').textContent = '';
  $('unresolvedCard').hidden = true;
  state.original = '';
  state.a = '';
  state.b = '';
  state.fullA = '';
  state.fullB = '';
  state.report = '';
  state.result = null;
  state.hz = null;
  clearDocx();
  state.docxMode = false;
  $('docxNote').hidden = true;
  $('dlADocx').hidden = true;
  $('dlBDocx').hidden = true;
  $('dlA').textContent = '下載 A';
  $('dlB').textContent = '下載 B';
  $('copyB').textContent = '複製 B';
  clearError();
  resetStages();
  $('original').focus();
});

// ── mode switch (自助 6.1 / 進階 2.0) ────────────────────────────────────────
function applyMode() {
  const v6 = state.mode === 'v6';
  $('v6Options').hidden = !v6;
  $('classicOptions').hidden = v6;
  $('hasAWrap').hidden = v6;
  if (v6 && $('hasA').checked) $('hasA').checked = false;
  $('aWrap').hidden = true;
  document.querySelectorAll('.mode').forEach((el) => {
    el.classList.toggle('selected', el.querySelector('input').value === state.mode);
  });
  renderSteps();
  resetStages();
}
document.querySelectorAll('input[name="mode"]').forEach((el) => {
  el.addEventListener('change', () => { state.mode = el.value; applyMode(); });
});
applyMode();

$('diff').addEventListener('change', renderPanes);
$('copyB').addEventListener('click', copyB);
$('dlA').addEventListener('click', () => download('humanized.txt', state.docxMode ? state.fullA : state.a));
$('dlB').addEventListener('click', () => download('final.txt', state.docxMode ? state.fullB : state.b));
$('dlR').addEventListener('click', () => download('report.md', state.report));

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if (!state.running) run();
  }
});

async function loadVersion() {
  const el = $('version');
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const v = await res.json();
    el.textContent = `Workflow ${v.workflow} · ${v.serverStale ? '伺服器需重啟' : '已同步'}`;
    el.classList.toggle('ok', !v.serverStale);
    el.classList.toggle('warn', !!v.serverStale);
    el.title = [
      `伺服器啟動：${v.startedAt}`,
      `UI：${v.files.ui || '—'}`,
      `pipeline：${v.files.pipeline || '—'}`,
      `polish：${v.files.polish || '—'}`,
      `polish pipeline：${v.files.polishPipeline || '—'}`,
    ].join(String.fromCharCode(10));
  } catch {
    el.textContent = 'Workflow 版本未知（請重新載入）';
    el.classList.add('warn');
    el.title = '無法讀取 /api/version';
  }
}

loadVersion();

$('original').focus();
