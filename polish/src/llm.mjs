// Minimal LLM client. Two adapters:
//   - ollama  : native /api/chat (JSON mode, thinking off, configurable num_ctx)
//   - openai  : any OpenAI-compatible /chat/completions endpoint
// Requires `undici` for optional per-provider HTTP proxy support.

import { fetch as undiciFetch, ProxyAgent } from 'undici';

const PROXY_AGENTS = new Map();
function proxyDispatcher(url) {
  if (!url) return undefined;
  if (!PROXY_AGENTS.has(url)) PROXY_AGENTS.set(url, new ProxyAgent(url));
  return PROXY_AGENTS.get(url);
}

function joinUrl(base, path) {
  return `${base.replace(/\/+$/, '')}${path}`;
}

function openaiBase(baseUrl) {
  const b = baseUrl.replace(/\/+$/, '');
  try {
    const u = new URL(b);
    // Only infer /v1 when the user gave a bare host. Explicit paths (Gemini's
    // /v1beta/openai, OpenRouter's /api/v1, local servers) are used as-is.
    if (!u.pathname || u.pathname === '/') return `${b}/v1`;
  } catch { /* not a URL; let fetch report it */ }
  return b;
}

export function extractJson(text) {
  if (!text || typeof text !== 'string') {
    const e = new Error('empty model response');
    e.isJson = true;
    throw e;
  }
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(s);
  } catch { /* fall through */ }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const body = s.slice(first, last + 1);
    try {
      return JSON.parse(body);
    } catch { /* fall through */ }
  }
  const e = new Error(`model did not return valid JSON: ${s.slice(0, 200)}`);
  e.isJson = true;
  throw e;
}

async function postJson(url, body, headers, timeoutMs, proxyUrl = '') {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctl.signal,
      dispatcher: proxyDispatcher(proxyUrl),
    });
    const raw = await res.text();
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(raw);
        msg = j.error?.message || j.error || j.message || msg;
      } catch { msg = `${msg}: ${raw.slice(0, 300)}`; }
      const err = new Error(msg);
      err.status = res.status;
      err.body = raw;
      throw err;
    }
    return JSON.parse(raw);
  } finally {
    clearTimeout(timer);
  }
}

function ollamaOptions(cfg) {
  return {
    temperature: cfg.temperature ?? 0,
    top_p: cfg.topP ?? 0.9,
    repeat_penalty: cfg.repeatPenalty ?? 1.0,
    num_ctx: cfg.numCtx ?? 8192,
  };
}

function geminiBase(baseUrl) {
  const b = String(baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  if (/\/v1(?:beta|alpha)\d*$/.test(b)) return b;
  if (/\/v1beta\/openai$/.test(b)) return b.replace(/\/openai$/, '');
  return `${b}/v1beta`;
}

async function callGemini(cfg, { system, user }) {
  const base = geminiBase(cfg.baseUrl);
  const url = `${base}/models/${encodeURIComponent(cfg.model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature: cfg.temperature ?? 0,
      maxOutputTokens: cfg.maxOutputTokens ?? 3000,
      responseMimeType: cfg.jsonMode === false ? 'text/plain' : 'application/json',
      ...(cfg.thinkingBudget != null
        ? { thinkingConfig: { thinkingBudget: cfg.thinkingBudget } }
        : {}),
    },
  };
  const headers = {};
  if (cfg.apiKey) headers['X-goog-api-key'] = cfg.apiKey;
  const data = await postJson(url, body, headers, cfg.timeoutMs ?? 300000, cfg.proxyUrl || '');
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const content = parts.map((p) => p?.text || '').join('');
  if (!content) {
    const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || 'empty Gemini response';
    const e = new Error(`Gemini returned no text (${reason})`);
    e.isJson = true;
    throw e;
  }
  return {
    content,
    usage: {
      prompt: data?.usageMetadata?.promptTokenCount ?? null,
      output: data?.usageMetadata?.candidatesTokenCount ?? null,
      totalMs: null,
    },
  };
}

async function callOllama(cfg, { system, user }) {
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
    think: false,
    format: 'json',
    keep_alive: cfg.keepAlive ?? '30m',
    options: {
      ...ollamaOptions(cfg),
      num_predict: cfg.maxOutputTokens ?? 2000,
    },
  };
  const data = await postJson(joinUrl(cfg.baseUrl, '/api/chat'), body, {}, cfg.timeoutMs ?? 900000, '');
  const content = data?.message?.content;
  return {
    content,
    usage: {
      prompt: data?.prompt_eval_count ?? null,
      output: data?.eval_count ?? null,
      totalMs: data?.total_duration ? Math.round(data.total_duration / 1e6) : null,
    },
  };
}

async function callOpenAI(cfg, { system, user }) {
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
    max_tokens: cfg.maxOutputTokens ?? 3000,
    ...(cfg.extraBody || {}),
  };
  if (cfg.temperature != null) body.temperature = cfg.temperature;
  if (cfg.jsonMode !== false) body.response_format = { type: 'json_object' };

  const headers = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const url = joinUrl(openaiBase(cfg.baseUrl), '/chat/completions');

  let data;
  try {
    data = await postJson(url, body, headers, cfg.timeoutMs ?? 300000, cfg.proxyUrl || '');
  } catch (e) {
    if (e.status === 400 || e.status === 422) {
      // Some providers/models reject response_format, temperature or
      // max_tokens. Retry with the minimal body once; the tool's own JSON
      // extraction still works.
      delete body.response_format;
      delete body.temperature;
      delete body.max_tokens;
      data = await postJson(url, body, headers, cfg.timeoutMs ?? 300000, cfg.proxyUrl || '');
    } else {
      throw e;
    }
  }
  return {
    content: data?.choices?.[0]?.message?.content,
    usage: {
      prompt: data?.usage?.prompt_tokens ?? null,
      output: data?.usage?.completion_tokens ?? null,
      totalMs: null,
    },
  };
}

/**
 * Sends one prompt and returns parsed JSON.
 * Retries once on malformed JSON and once on transient network failure.
 */
export async function chatJson(cfg, { system, user, label = '' }, log = () => {}) {
  const adapter = cfg.provider === 'openai' ? callOpenAI : cfg.provider === 'gemini' ? callGemini : callOllama;
  const started = Date.now();
  let lastErr = null;
  let userPrompt = user;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await adapter(cfg, { system, user: userPrompt });
      const parsed = extractJson(res.content);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const tok = res.usage.prompt != null ? `${res.usage.prompt} in / ${res.usage.output ?? '?'} out` : 'tokens n/a';
      log(`  ${label} ok (${secs}s, ${tok})`);
      return parsed;
    } catch (e) {
      lastErr = e;
      if (e.isJson && attempt === 0) {
        log(`  ${label} returned malformed JSON; asking once more`);
        userPrompt = `${user}\n\nIMPORTANT: Return ONLY one valid JSON object. No markdown fence, no preface, no trailing text.`;
        continue;
      }
      const transient = e.name === 'AbortError' || e.name === 'TypeError' || e.status >= 500 || e.status === 429;
      log(`  ${label} attempt ${attempt + 1}/4 failed: ${e.message}`);
      if (!transient) break;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw new Error(`${label || 'model call'} failed: ${lastErr?.message || 'unknown error'}`);
}
