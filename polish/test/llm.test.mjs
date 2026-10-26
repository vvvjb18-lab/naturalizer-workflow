import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chatJson, extractJson } from '../src/llm.mjs';

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('OpenAI adapter sends key, uses /v1 and parses JSON', async (t) => {
  const seen = [];
  const { server, port } = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '```json\n{"issues":[]}\n```' } }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      }));
    });
  });
  t.after(() => server.close());

  const cfg = {
    provider: 'openai',
    baseUrl: `http://127.0.0.1:${port}`,
    model: 'test-model',
    apiKey: 'test-key',
    temperature: 0,
    timeoutMs: 5000,
    maxOutputTokens: 100,
  };
  const out = await chatJson(cfg, { system: 's', user: 'u', label: 'test' });
  assert.deepEqual(out, { issues: [] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/v1/chat/completions');
  assert.equal(seen[0].auth, 'Bearer test-key');
  assert.equal(seen[0].body.response_format.type, 'json_object');
  assert.equal(seen[0].body.max_tokens, 100);
});

test('OpenAI adapter retries without response_format/temperature on 400', async (t) => {
  const bodies = [];
  const { server, port } = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      bodies.push(parsed);
      if (parsed.response_format) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'response_format unsupported' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"patches":[]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      }));
    });
  });
  t.after(() => server.close());

  const cfg = {
    provider: 'openai',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'test-model',
    apiKey: '',
    temperature: 0,
    timeoutMs: 5000,
  };
  const out = await chatJson(cfg, { system: 's', user: 'u', label: 'test' });
  assert.deepEqual(out, { patches: [] });
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].response_format);
  assert.equal(bodies[1].response_format, undefined);
  assert.equal(bodies[1].temperature, undefined);
});

test('extractJson tolerates fences and surrounding prose', () => {
  assert.deepEqual(extractJson('Here you go:\n```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(extractJson('prefix {"a":1} suffix'), { a: 1 });
  assert.throws(() => extractJson('not json'), /valid JSON/);
});
