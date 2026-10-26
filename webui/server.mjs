#!/usr/bin/env node
// Local web UI for the Humanizer + academic-repair pipeline.
// Binds to 127.0.0.1 only. No dependencies.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE = path.resolve(HERE, '..', 'pipeline', 'pipeline.mjs');
const V6 = path.resolve(HERE, '..', 'pipeline', 'v6.mjs');
const PUBLIC = path.join(HERE, 'public');
const RUNS = path.join(HERE, 'runs');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8790);
const MAX_BODY = 12 * 1024 * 1024;
const STARTED_AT = Date.now();
const WORKFLOW_VERSION = '9.0';
const MAX_RUNTIME_MS = 60 * 60 * 1000;

fs.mkdirSync(RUNS, { recursive: true });
pruneRuns();

function pruneRuns() {
  try {
    const dirs = fs.readdirSync(RUNS, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const p = path.join(RUNS, d.name);
        return { p, m: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.m - a.m);
    for (let i = 0; i < dirs.length; i++) {
      if (i >= 30 || Date.now() - dirs[i].m > 2 * 86400000) {
        fs.rmSync(dirs[i].p, { recursive: true, force: true });
      }
    }
  } catch { /* housekeeping is best effort */ }
}

function readIf(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function send(res, obj) {
  if (res.writableEnded) return;
  try { res.write(`${JSON.stringify(obj)}\n`); } catch { /* client gone */ }
}

function lineReader(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  };
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

function serveStatic(req, res) {
  const hit = STATIC.get(req.url.split('?')[0]);
  if (!hit) { json(res, 404, { error: 'not found' }); return; }
  const file = path.join(PUBLIC, hit[0]);
  try {
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': hit[1],
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    json(res, 500, { error: `missing ${hit[0]}` });
  }
}

function handleRun(req, res) {
  let body = '';
  let size = 0;
  let aborted = false;

  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    if (size > MAX_BODY) {
      aborted = true;
      json(res, 413, { error: '稿子太大（上限 2 MB）' });
      req.destroy();
      return;
    }
    body += c;
  });

  req.on('end', () => {
    if (aborted) return;
    let payload;
    try { payload = JSON.parse(body || '{}'); } catch {
      json(res, 400, { error: 'JSON 格式錯誤' });
      return;
    }

    const original = String(payload.original || '').replace(/\r\n?/g, '\n').trim();
    const providedA = String(payload.humanized || '').replace(/\r\n?/g, '\n').trim();
    const docxB64 = typeof payload.docxBase64 === 'string' ? payload.docxBase64.trim() : '';
    const docxName = String(payload.docxName || 'original.docx');
    if (!original && !docxB64) { json(res, 400, { error: '缺少原始草稿（文字或 .docx）' }); return; }
    if (docxB64 && !/\.docx$/i.test(docxName)) { json(res, 400, { error: 'docx 檔名必須是 .docx' }); return; }
    if (docxB64 && providedA) { json(res, 400, { error: 'docx 模式不支援同時提供文字 A；請用 CLI 的 --humanized 處理既有 A.docx。' }); return; }
    const mode = payload.mode === 'v6' ? 'v6' : 'classic';
    const target = payload.target === 'ideal' ? 'ideal' : 'balanced';
    if (mode === 'v6' && providedA) { json(res, 400, { error: '自助模式不支援既有 A；請用進階模式或 CLI。' }); return; }
    const verify = ['audit', 'repair', 'off'].includes(payload.verify) ? payload.verify : 'audit';
    const lang = ['auto', 'en', 'zh'].includes(payload.lang) ? payload.lang : 'auto';
    const auditOnly = !!payload.auditOnly;

    const runId = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const runDir = path.join(RUNS, runId);
    fs.mkdirSync(runDir, { recursive: true });

    let inputPath;
    if (docxB64) {
      const buf = Buffer.from(docxB64, 'base64');
      if (!buf.length || buf.length > MAX_BODY) { json(res, 400, { error: 'docx 是空的或太大（上限 12 MB）。' }); return; }
      inputPath = path.join(runDir, 'original.docx');
      fs.writeFileSync(inputPath, buf);
    } else {
      inputPath = path.join(runDir, 'original.txt');
      fs.writeFileSync(inputPath, original.endsWith('\n') ? original : `${original}\n`, 'utf8');
    }
    const providedAPath = providedA ? path.join(runDir, 'humanized.txt') : null;
    if (providedA) {
      fs.writeFileSync(providedAPath, providedA.endsWith('\n') ? providedA : `${providedA}\n`, 'utf8');
    }

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    send(res, { type: 'start', runId });

    let args;
    if (mode === 'v6') {
      args = [V6, inputPath, '--out-dir', runDir, '--target', target, '--final-name', 'original.final'];
      if (Number.isInteger(payload.candidates) && payload.candidates >= 1) {
        args.push('--candidates', String(payload.candidates));
      }
      // 8.0: grind is on by default inside v6; word budget is opt-in per run
      if (Number.isInteger(payload.maxWords) && payload.maxWords >= 100) {
        args.push('--max-words', String(payload.maxWords));
        if (Number.isInteger(payload.floorWords) && payload.floorWords >= 50) {
          args.push('--floor-words', String(payload.floorWords));
        }
      }
      // 9.0: layered architecture opt-in (router / veto gates / ledger)
      if (payload.arch90) args.push('--arch90');
      // 9.0: course quality gate (B+) against the built-in HKU SPACE anchor
      if (payload.anchor) args.push('--anchor', path.join(HERE, '..', 'pipeline', 'anchors'));
      // 9.0 tiers (interface-layer mapping): fast = fewer candidates, no grind,
      // hard wall-clock budget. Engine flags already exist; nothing new.
      if (payload.noGrind) args.push('--no-grind');
      if (Number.isInteger(payload.timeBudget) && payload.timeBudget >= 1) {
        args.push('--time-budget', String(payload.timeBudget));
      }
      console.log(`[run] v6 argv: ${args.slice(1).join(' ')}`);
    } else {
      args = [PIPELINE, inputPath, '--out-dir', runDir, '--verify', verify, '--lang', lang];
      if (providedA) args.push('--humanized', providedAPath);
      if (auditOnly) args.push('--audit-only');
    }

    const child = spawn(process.execPath, args, {
      cwd: path.dirname(args[0]),
      env: process.env,
      windowsHide: true,
    });

    let stage = '';
    const setStage = (s) => {
      if (s === stage) return;
      stage = s;
      send(res, { type: 'stage', stage: s });
    };

    const onLine = (stream) => lineReader((line) => {
      send(res, { type: 'log', stream, line });
      if (mode === 'v6') {
        if (line.includes('=== 1/7')) setStage('plan');
        else if (line.includes('=== 2/7')) setStage('generate');
        else if (line.includes('=== 3/7')) setStage('score');
        else if (line.includes('=== 4/7')) setStage('surgery');
        else if (line.includes('=== 5/7') || line.includes('=== 5.5/7')) setStage('grind');
        else if (line.includes('=== 6/7') || line.includes('=== 7/7')) setStage('deliver');
        else if (line.includes('交付檔')) setStage('done');
      } else {
        if (line.includes('=== 1/2')) setStage('humanize');
        else if (line.includes('=== 2/2')) setStage('polish');
        else if (line.includes('=== 完成')) setStage('done');
      }
    });

    child.stdout.on('data', onLine('out'));
    child.stderr.on('data', onLine('err'));

    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      send(res, { type: 'error', message: '執行超時（60 分鐘）' });
      child.kill();
    }, MAX_RUNTIME_MS);

    child.on('error', (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      send(res, { type: 'error', message: `無法啟動管線：${e.message}` });
      res.end();
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      pruneRuns();

      if (mode === 'v6') {
        const v6Final = path.join(runDir, 'original.final.docx');
        const v6A = path.join(runDir, 'original.v6-A.docx');
        const v6AProse = readIf(path.join(runDir, 'original.v6-A.prose.txt'));
        const fullB6 = readIf(path.join(runDir, 'original.final.txt')) || v6AProse;
        let v6 = null;
        try { v6 = JSON.parse(readIf(path.join(runDir, 'original.v6.report.json'))); } catch { /* ignore */ }
        const files = {
          aDocx: fs.existsSync(v6A) ? `/api/run/${runId}/va.docx` : null,
          bDocx: fs.existsSync(v6Final) ? `/api/run/${runId}/b.docx` : (fs.existsSync(v6A) ? `/api/run/${runId}/va.docx` : null),
          aTxt: `/api/run/${runId}/va.txt`,
          bTxt: fs.existsSync(path.join(runDir, 'original.final.txt')) ? `/api/run/${runId}/b.txt` : `/api/run/${runId}/va.txt`,
          report: `/api/run/${runId}/risk.md`,
          riskJson: `/api/run/${runId}/risk.json`,
        };
        setStage('done');
        send(res, {
          type: 'done',
          runId,
          exitCode: code,
          ok: code === 0,
          mode: 'v6',
          docx: true,
          original: readIf(path.join(runDir, '.v6-original', 'original.prose.txt')),
          a: v6AProse,
          b: fullB6,
          fullA: v6AProse,
          fullB: fullB6,
          files,
          report: readIf(path.join(runDir, 'original.v6.report.md')),
          v6,
        });
        res.end();
        return;
      }

      const docx = fs.existsSync(path.join(runDir, 'original.humanized.docx'));
      const fullA = readIf(path.join(runDir, 'original.humanized.txt'));
      const fullB = readIf(path.join(runDir, 'original.final.txt'));
      const report = readIf(path.join(runDir, 'original.final.report.md'));
      let result = null;
      try { result = JSON.parse(readIf(path.join(runDir, 'original.final.report.json'))); } catch { /* ignore */ }
      const hz = readIf(path.join(runDir, 'original.humanized.json'));
      let hzStats = null;
      try { hzStats = hz ? JSON.parse(hz) : null; } catch { /* ignore */ }
      let pipeline = null;
      try { pipeline = JSON.parse(readIf(path.join(runDir, 'original.pipeline.json'))); } catch { /* ignore */ }

      const textA = (result && result.texts && result.texts.humanized) || providedA || fullA;
      const textB = (result && result.texts && result.texts.output) || fullB;
      const finalDocx = path.join(runDir, 'original.final.docx');
      const files = docx ? {
        aDocx: `/api/run/${runId}/a.docx`,
        bDocx: fs.existsSync(finalDocx) ? `/api/run/${runId}/b.docx` : null,
        aTxt: `/api/run/${runId}/a.txt`,
        bTxt: fs.existsSync(path.join(runDir, 'original.final.txt')) ? `/api/run/${runId}/b.txt` : null,
        report: `/api/run/${runId}/report.md`,
      } : null;

      setStage('done');
      send(res, {
        type: 'done',
        runId,
        exitCode: code,
        ok: code === 0 || code === 2,
        auditOnly,
        docx,
        a: textA,
        b: textB,
        fullA,
        fullB,
        files,
        pipeline,
        report,
        result,
        hz: hzStats,
      });
      res.end();
    });

    res.on('close', () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        child.kill();
      }
    });
  });
}

const RUN_FILE_MAP = {
  'va.docx': ['original.v6-A.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'v6-A.docx'],
  'va.txt': ['original.v6-A.prose.txt', 'text/plain; charset=utf-8', 'v6-A.txt'],
  'risk.md': ['original.v6.report.md', 'text/markdown; charset=utf-8', 'v6-risk-card.md'],
  'risk.json': ['original.v6.report.json', 'application/json; charset=utf-8', 'v6-risk-card.json'],
  'a.docx': ['original.humanized.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'humanized.docx'],
  'b.docx': ['original.final.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'final.docx'],
  'a.txt': ['original.humanized.txt', 'text/plain; charset=utf-8', 'humanized.txt'],
  'b.txt': ['original.final.txt', 'text/plain; charset=utf-8', 'final.txt'],
  'report.md': ['original.final.report.md', 'text/markdown; charset=utf-8', 'report.md'],
};

function serveRunFile(res, runId, name) {
  const entry = RUN_FILE_MAP[name];
  if (!entry) { json(res, 404, { error: 'not found' }); return; }
  const p = path.join(RUNS, runId, entry[0]);
  if (!fs.existsSync(p)) { json(res, 404, { error: 'not found' }); return; }
  const body = fs.readFileSync(p);
  res.writeHead(200, {
    'Content-Type': entry[1],
    'Content-Length': body.length,
    'Content-Disposition': `attachment; filename="${entry[2]}"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function fileMtime(p) {
  try { return new Date(fs.statSync(p).mtimeMs).toISOString(); } catch { return null; }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/api/health')) {
    json(res, 200, { ok: true, pipeline: PIPELINE, workflow: WORKFLOW_VERSION });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/api/version')) {
    const files = {
      server: fileMtime(path.join(HERE, 'server.mjs')),
      ui: fileMtime(path.join(PUBLIC, 'app.js')),
      pipeline: fileMtime(PIPELINE),
      polish: fileMtime(path.join(HERE, '..', 'polish', 'polish.mjs')),
      polishPipeline: fileMtime(path.join(HERE, '..', 'polish', 'src', 'pipeline.mjs')),
    };
    const serverStale = files.server
      ? new Date(files.server).getTime() > STARTED_AT + 1000
      : false;
    json(res, 200, {
      workflow: WORKFLOW_VERSION,
      startedAt: new Date(STARTED_AT).toISOString(),
      files,
      serverStale,
    });
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/api/run')) {
    handleRun(req, res);
    return;
  }
  const fm = req.url.match(/^\/api\/run\/([a-z0-9-]+)\/([a-z]+\.(?:docx|txt|md|json))$/);
  if (req.method === 'GET' && fm) {
    serveRunFile(res, fm[1], fm[2]);
    return;
  }
  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }
  json(res, 405, { error: 'method not allowed' });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log(`  Humanizer + 學術修補 UI`);
  console.log(`  http://${HOST}:${PORT}`);
  console.log('');
  console.log('  Ctrl+C 停止。所有資料只留在本機。');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} 已被佔用。用 PORT=8791 node server.mjs 換一個。`);
  } else {
    console.error(e.message);
  }
  process.exit(1);
});
