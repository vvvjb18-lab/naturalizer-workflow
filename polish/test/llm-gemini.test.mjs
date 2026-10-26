import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chatJson } from '../src/llm.mjs';

test('Gemini native adapter sends X-goog-api-key and parses candidates', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, key: req.headers['x-goog-api-key'], body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;

  const cfg = {
    provider: 'gemini',
    baseUrl: `http://127.0.0.1:${port}`,
    model: 'mock',
    apiKey: 'test-key',
    temperature: 0,
    maxOutputTokens: 100,
    jsonMode: true,
    timeoutMs: 5000,
  };
  const out = await chatJson(cfg, { system: 'system text', user: 'user text', label: 'gemini test' });
  assert.deepEqual(out, { ok: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/v1beta/models/mock:generateContent');
  assert.equal(seen[0].key, 'test-key');
  assert.equal(seen[0].body.systemInstruction.parts[0].text, 'system text');
  assert.equal(seen[0].body.contents[0].parts[0].text, 'user text');
  assert.equal(seen[0].body.generationConfig.responseMimeType, 'application/json');
  assert.equal(seen[0].body.generationConfig.maxOutputTokens, 100);
});
