import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runPipeline } from '../src/pipeline.mjs';

const DRAFT = 'The method is fast and cheap. It works on 30 small samples. Results may differ across runs.';
const HUMANIZED = 'The method is fast. (1) It is cheap. (2) It works on 30 small samples. Results differ across runs.';

function mockServer() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let payload;
      try {
        const j = JSON.parse(body);
        const prompt = j.messages?.[1]?.content || '';
        let content;

        if (prompt.includes('# DEFECT TYPES')) {
          content = JSON.stringify({
            issues: [
              {
                type: 'structure', severity: 'critical',
                quote: '(1) It is cheap. (2) It works on 30 small samples.',
                problem: 'Prose was turned into a numbered list.',
                fix: 'Convert the two items back into one prose sentence, keeping 30.',
              },
              {
                type: 'meaning', severity: 'major',
                quote: 'Results differ across runs.',
                problem: 'The hedge from the author draft was removed.',
                fix: 'Restore "may".',
              },
            ],
          });
        } else if (prompt.includes('# ISSUE LIST')) {
          const m = prompt.match(/\n# ISSUE LIST\n([\s\S]*?)\n\n# /);
          const issues = JSON.parse(m[1]);
          const rejected = prompt.includes('# REJECTED ATTEMPTS');
          const patches = issues.map((i) => {
            if (i.type === 'structure') {
              return {
                issue: i.id,
                before: i.quote,
                after: rejected
                  ? 'It is also cheap and works on 30 small samples.'
                  : 'It is cheap and works on many small samples.',
                note: 'converted list to prose',
              };
            }
            return {
              issue: i.id,
              before: i.quote,
              after: 'Results may differ across runs.',
              note: 'restored hedge',
            };
          });
          content = JSON.stringify({ patches, unresolved: [] });
        } else {
          content = '{"issues":[],"patches":[],"unresolved":[]}';
        }
        payload = JSON.stringify({ message: { content }, prompt_eval_count: 100, eval_count: 40 });
      } catch (e) {
        payload = JSON.stringify({ error: e.message });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload);
    });
  });
}

test('pipeline repairs a broken humanized draft without rewriting it', async (t) => {
  const server = mockServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;

  const cfg = {
    provider: 'ollama',
    baseUrl: `http://127.0.0.1:${port}`,
    model: 'mock',
    temperature: 0,
    numCtx: 4096,
    chunkChars: 6000,
    maxDraftChars: 12000,
    maxEditRatio: 0.15,
    minCvRetention: 0.4,
    maxPatchWords: 120,
    maxIssuesPerChunk: 20,
    repairBatch: 12,
    timeoutMs: 10000, judge: false,
  };

  const logs = [];
  const result = await runPipeline({ humanized: HUMANIZED, draft: DRAFT, cfg, log: (m) => logs.push(m) });
  if (result.stats.applied !== 2) console.error(logs.join('\n'));

  assert.equal(result.stats.applied, 2);
  assert.ok(result.stats.rejected >= 1, 'the number-dropping patch should have been rejected first');
  assert.match(result.outputText, /30 small samples/);
  assert.ok(!result.outputText.includes('(1)'));
  assert.match(result.outputText, /Results may differ across runs\./);
  assert.ok(result.unresolved.length <= 1);
  assert.ok(result.unresolved.every((u) => /回退/.test(u.reason || '')));
  assert.equal(result.gates.find((g) => g.name === 'numbers').ok, true);
  assert.equal(result.gates.find((g) => g.name === 'structure').ok, true);
  assert.equal(result.gates.find((g) => g.name === 'rhythm').ok, true);
});

test('pipeline keeps A when no safe rewrite is proposed', async (t) => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body);
      const prompt = j.messages?.[1]?.content || '';
      let content;
      if (prompt.includes('# DEFECT TYPES')) {
        content = JSON.stringify({
          issues: [{
            type: 'grammar', severity: 'major',
            quote: 'The method is fast.',
            problem: 'Fragment.',
            fix: 'Make it a full sentence.',
          }],
        });
      } else {
        content = JSON.stringify({
          patches: [{
            issue: 'M1',
            before: 'The method is fast.',
            after: 'The proposed methodological apparatus demonstrates considerable rapidity, and moreover it is characterized by a multifaceted economy.',
          }],
          unresolved: [],
        });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: { content }, prompt_eval_count: 40, eval_count: 30 }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;

  const cfg = {
    provider: 'ollama', baseUrl: `http://127.0.0.1:${port}`, model: 'mock',
    temperature: 0, numCtx: 4096, chunkChars: 6000, maxDraftChars: 12000,
    maxEditRatio: 0.15, minCvRetention: 0.4, maxPatchWords: 120,
    maxIssuesPerChunk: 20, repairBatch: 12, timeoutMs: 10000, judge: false,
  };

  const result = await runPipeline({ humanized: HUMANIZED, draft: DRAFT, cfg, log: () => {} });
  assert.equal(result.stats.applied, 0);
  assert.equal(result.outputText, HUMANIZED);
  assert.ok(result.stats.rejected >= 1);
  assert.ok(result.unresolved.length >= 1);
  assert.ok(result.unresolved.every((u) => /保留 A/.test(u.reason || '')));
});

test('supervision rewrites a sentence the repair could not fix', async (t) => {
  const DRAFT2 = 'The method is fast and cheap. Results may differ across runs.';
  const HUMANIZED2 = 'The method is really fast. Results differ across runs.';

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body);
      const prompt = j.messages?.[1]?.content || '';
      let content;
      if (prompt.includes('# CHOOSE ONE ACTION')) {
        content = JSON.stringify({
          action: 'rewrite',
          before: 'The method is really fast.',
          after: 'The method was quick and inexpensive.',
          reason: 'Rewrite the sentence in a plainer academic voice.',
        });
      } else if (prompt.includes('# DEFECT TYPES')) {
        content = JSON.stringify({
          issues: [{
            type: 'register', severity: 'major',
            quote: 'The method is really fast.',
            problem: 'Colloquial "really" and the draft wording were lost.',
            fix: 'Restore the draft sentence.',
          }],
        });
      } else if (prompt.includes('# ISSUE LIST')) {
        content = JSON.stringify({ patches: [], unresolved: [] });
      } else {
        content = '{"issues":[]}';
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: { content }, prompt_eval_count: 40, eval_count: 30 }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;

  const cfg = {
    provider: 'ollama', baseUrl: `http://127.0.0.1:${port}`, model: 'mock',
    temperature: 0, numCtx: 4096, chunkChars: 6000, maxDraftChars: 12000,
    maxEditRatio: 0.5, minCvRetention: 0.1, maxPatchWords: 120,
    maxIssuesPerChunk: 20, repairBatch: 12, timeoutMs: 10000, judge: false,
    cleanup: true, maxCleanupRounds: 1,
  };

  const result = await runPipeline({ humanized: HUMANIZED2, draft: DRAFT2, cfg, log: () => {} });
  assert.equal(result.stats.rewrites, 1);
  assert.match(result.outputText, /The method was quick and inexpensive\./);
  assert.match(result.outputText, /Results differ across runs\./);
  assert.ok(!result.outputText.includes('really'));
  assert.equal(result.unresolved.length, 0);
});

test('quality judge accepts or rejects a supervision rewrite', async (t) => {
  const DRAFT3 = 'The method is fast and cheap. Results may differ across runs.';
  const HUMANIZED3 = 'The method is really fast. Results differ across runs.';
  let mode = 'accept';

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body);
      const prompt = j.messages?.[1]?.content || '';
      let content;
      if (prompt.includes('# RUBRIC')) {
        if (mode === 'accept') {
          content = JSON.stringify({ scores: { meaning: 5, academic: 5, facts: 5, naturalness: 5, register: 5 }, total: 25, verdict: 'accept', problems: [], fix: '' });
        } else if (mode === 'force') {
          content = JSON.stringify({ scores: { meaning: 5, academic: 4, facts: 5, naturalness: 2, register: 2 }, total: 18, verdict: 'reject', problems: ['naturalness below threshold'], fix: '' });
        } else {
          content = JSON.stringify({ scores: { meaning: 2, academic: 4, facts: 5, naturalness: 3, register: 4 }, total: 18, verdict: 'reject', problems: ['changed the meaning of the first sentence'], fix: '' });
        }
      } else if (prompt.includes('# CHOOSE ONE ACTION')) {
        content = JSON.stringify({
          action: 'rewrite',
          before: 'The method is really fast.',
          after: 'The method was quick and inexpensive.',
          reason: 'Rewrite the sentence in a plainer academic voice.',
        });
      } else if (prompt.includes('# DEFECT TYPES')) {
        content = JSON.stringify({
          issues: [{
            type: 'register', severity: 'major',
            quote: 'The method is really fast.',
            problem: 'Colloquial "really"; the draft wording was lost.',
            fix: 'Restore the draft sentence.',
          }],
        });
      } else if (prompt.includes('# ISSUE LIST')) {
        content = JSON.stringify({ patches: [], unresolved: [] });
      } else {
        content = '{"issues":[]}';
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: { content }, prompt_eval_count: 40, eval_count: 30 }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;

  const cfg = {
    provider: 'ollama', baseUrl: `http://127.0.0.1:${port}`, model: 'mock',
    temperature: 0, numCtx: 4096, chunkChars: 6000, maxDraftChars: 12000,
    maxEditRatio: 0.5, minCvRetention: 0.1, maxPatchWords: 120,
    maxIssuesPerChunk: 20, repairBatch: 12, timeoutMs: 10000, judge: true,
    judgeMinScore: 18, judgeMinDimension: 3, cleanup: true, maxCleanupRounds: 1,
  };

  const accepted = await runPipeline({ humanized: HUMANIZED3, draft: DRAFT3, cfg, log: () => {} });
  assert.equal(accepted.stats.rewrites, 1);
  assert.equal(accepted.stats.judgePass, 1);
  assert.equal(accepted.unresolved.length, 0);

  mode = 'reject';
  const rejected = await runPipeline({ humanized: HUMANIZED3, draft: DRAFT3, cfg, log: () => {} });
  assert.equal(rejected.stats.applied, 0);
  assert.ok(rejected.stats.judgeFail >= 1);
  assert.equal(rejected.outputText, HUMANIZED3);
  assert.ok(rejected.unresolved.length >= 1);
  assert.ok(rejected.unresolved.every((u) => /保留 A/.test(u.reason || '')));

  mode = 'force';
  const cfgForce = { ...cfg, mode: 'strong', forceFix: true, forceMinScore: 16, strongAttempts: 2 };
  const forced = await runPipeline({ humanized: HUMANIZED3, draft: DRAFT3, cfg: cfgForce, log: () => {} });
  assert.equal(forced.stats.forced, 1);
  assert.equal(forced.stats.rewrites, 1);
  assert.match(forced.outputText, /The method was quick and inexpensive\./);
});

test('pipeline works through the OpenAI-compatible adapter', async (t) => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body);
      const prompt = j.messages?.[1]?.content || '';
      let content;
      if (prompt.includes('# DEFECT TYPES')) {
        content = JSON.stringify({
          issues: [{
            type: 'structure', severity: 'critical',
            quote: '(1) It is cheap. (2) It works on 30 small samples.',
            problem: 'numbered list added',
            fix: 'prose',
          }],
        });
      } else if (prompt.includes('# ISSUE LIST')) {
        const m = prompt.match(/\n# ISSUE LIST\n([\s\S]*?)\n\n# /);
        const issues = JSON.parse(m[1]);
        content = JSON.stringify({
          patches: issues.map((i) => ({
            issue: i.id,
            before: i.quote,
            after: 'It is cheap and works on 30 small samples.',
          })),
          unresolved: [],
        });
      } else {
        content = '{"issues":[]}';
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 80, completion_tokens: 30 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;

  const cfg = {
    provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock',
    apiKey: 'test', temperature: 0, chunkChars: 6000, maxDraftChars: 12000,
    maxEditRatio: 0.15, minCvRetention: 0.4, maxPatchWords: 120,
    maxIssuesPerChunk: 20, repairBatch: 12, timeoutMs: 10000, judge: false, maxOutputTokens: 500,
  };

  const result = await runPipeline({ humanized: HUMANIZED, draft: DRAFT, cfg, log: () => {} });
  assert.equal(result.stats.applied, 1);
  assert.equal(result.outputText, 'The method is fast. It is cheap and works on 30 small samples. Results differ across runs.');
  assert.equal(result.unresolved.find((u) => u.type === 'structure'), undefined);
});
