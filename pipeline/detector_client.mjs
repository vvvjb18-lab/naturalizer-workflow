// detector_client.mjs — persistent detector process for Workflow 7.0.
//
// Spawns `python detector_daemon.py` once and keeps it alive; every scoring
// call is one stdin/stdout JSON round-trip instead of a fresh 30-60s model
// load. Crashes are transparent: pending calls reject and the next call
// respawns the daemon.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const DAEMON = path.resolve(import.meta.dirname, '..', 'polish', 'detector_daemon.py');

let proc = null;
let seq = 0;
let buf = '';
const pending = new Map();
let crashed = false;

// 8.10: stale-daemon pre-kill — leaked daemons (~7.5GB each) from crashed
// parents trigger os error 1455 (pagefile exhaustion) on the next spawn.
// Kills only processes whose command line contains detector_daemon.py.
export function killStaleDaemons() {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*detector_daemon.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { timeout: 20000 });
    return r.status === 0;
  } catch { return false; }
}

function start() {
  killStaleDaemons();
  proc = spawn('python', [DAEMON], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  crashed = false;
  buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id == null) continue;   // ready banner
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || 'daemon error'));
    }
  });
  proc.stderr.on('data', (c) => {
    const s = String(c);
    if (!/Xet|warning|Warning|Tqdm|it\/s/.test(s)) process.stderr.write(`[detector] ${s}`);
  });
  proc.on('exit', () => {
    crashed = true;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('daemon exited'));
    }
    pending.clear();
    proc = null;
  });
}

export async function detectorCall(op, payload, { timeoutMs = 900000 } = {}) {
  if (!proc || crashed) start();
  const id = ++seq;
  const p = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`detector ${op} timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
  });
  try {
    proc.stdin.write(JSON.stringify({ id, op, ...payload }) + '\n');
  } catch (e) {
    pending.delete(id);
    throw e;
  }
  return p;
}

export async function closeDetector() {
  if (!proc) return;
  try { proc.stdin.end(); } catch { /* already gone */ }
  const dying = proc;
  await new Promise((r) => { dying.on('exit', r); setTimeout(r, 3000); });
}

// ── typed wrappers (signatures match the old spawn-per-call helpers) ──────
export async function gramScores(sents) {
  const clean = sents.map((s) => String(s).replace(/[\r\n]+/g, ' '));
  if (!clean.length) return [];
  return detectorCall('gram', { sents: clean });
}

export async function nliPairs(pairs) {
  if (!pairs.length) return [];
  return detectorCall('nli', { pairs });
}

export async function scoreTexts(texts) {
  if (!texts.length) return [];
  return detectorCall('score_many', { texts });
}

export async function scoreFiles(files) {
  const texts = files.map((f) => fs.readFileSync(f, 'utf8'));
  return scoreTexts(texts).then((rs) => rs.map((r, i) => ({ ...r, file: files[i] })));
}
