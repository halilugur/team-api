// AI provider adapter for TeamAPI chat.
// Maps one unified request to OpenAI / Claude (Anthropic) / Gemini (Google) / Ollama
// and streams text deltas back via callbacks. All HTTP runs in the main process
// (no CORS) via the built-in http-client (no axios).
const { request } = require('./http-client');

// Actionable error for the "fetch models" button (best-effort feature).
function modelsError(label, status, url) {
  if (status === 401 || status === 403) {
    return new Error(`${label}: auth failed (${status}) — check your API key`);
  }
  if (status === 404 || status === 405) {
    return new Error(`${label}: can't list models (${status} at ${url}). Ensure Base URL ends with /v1, or type the model name manually.`);
  }
  return new Error(`${label} ${status} at ${url}`);
}

// Extract model IDs from the varied shapes OpenAI-compatible servers return:
// { data: [{id}] } | { models: [{id}|{name}|str] } | [str|{id}].
function extractModelIds(data) {
  if (!data) return [];
  const pick = (m) => (typeof m === 'string' ? m : (m && (m.id || m.name)));
  let arr = null;
  if (Array.isArray(data)) arr = data;
  else if (Array.isArray(data.data)) arr = data.data;
  else if (Array.isArray(data.models)) arr = data.models;
  return (arr || []).map(pick).filter(Boolean);
}

// Static provider catalog (no secrets). Returned to the renderer via ai:providers:list.
// `driver` selects the transport; multiple entries can share one (OpenAI-Compatible
// reuses the OpenAI path). Order here = dropdown order. The default active provider
// is the Custom (OpenAI-Compatible) entry; `keyOptional` = key field shown but not required.
const PROVIDERS = {
  ollama: {
    id: 'ollama',
    name: 'Ollama (Local)',
    driver: 'ollama',
    requiresKey: false,
    keyPlaceholder: '',
    defaultBaseUrl: 'http://localhost:11434',
    defaultModel: 'llama3',
    models: []
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    driver: 'openai',
    requiresKey: true,
    keyPlaceholder: 'sk-...',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini']
  },
  'openai-compatible': {
    id: 'openai-compatible',
    name: 'Custom',
    driver: 'openai',
    requiresKey: false,
    keyOptional: true,
    keyPlaceholder: 'sk-... (optional)',
    defaultBaseUrl: '',
    defaultModel: 'default',
    models: []
  },
  claude: {
    id: 'claude',
    name: 'Claude (Anthropic)',
    driver: 'claude',
    requiresKey: true,
    keyPlaceholder: 'sk-ant-...',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-6',
    models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-fable-5']
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini (Google)',
    driver: 'gemini',
    requiresKey: true,
    keyPlaceholder: 'AIza...',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.0-flash',
    models: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-1.5-flash']
  }
};

function trimUrl(u) {
  return (u || '').trim().replace(/\/+$/, '');
}

// Read a Node stream fully into a string (used to surface error response bodies).
function readStream(stream) {
  return new Promise((resolve) => {
    let data = '';
    stream.on('data', (c) => { data += c.toString('utf8'); });
    stream.on('end', () => resolve(data));
    stream.on('error', () => resolve(data));
  });
}

// SSE event streamer: buffer bytes, split on blank line, pass each `data:` payload to handleData.
function consumeSSE(stream, handleData, handlers) {
  let buffer = '';
  const flushEvents = () => {
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLines = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      try { handleData(dataLines.join('\n'), handlers); } catch (e) { /* ignore partial */ }
    }
  };
  stream.on('data', (buf) => { buffer += buf.toString('utf8'); flushEvents(); });
  stream.on('end', () => {
    if (buffer.trim()) {
      const dataLines = buffer.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
      if (dataLines.length) { try { handleData(dataLines.join('\n'), handlers); } catch (e) {} }
    }
    handlers.onClose();
  });
  stream.on('error', (err) => handlers.onError(err));
}

// NDJSON streamer (Ollama): split on newline, one JSON object per line.
function consumeNDJSON(stream, handleLine, handlers) {
  let buffer = '';
  const flushLines = () => {
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) { try { handleLine(line, handlers); } catch (e) {} }
    }
  };
  stream.on('data', (buf) => { buffer += buf.toString('utf8'); flushLines(); });
  stream.on('end', () => { if (buffer.trim()) { try { handleLine(buffer.trim(), handlers); } catch (e) {} } handlers.onClose(); });
  stream.on('error', (err) => handlers.onError(err));
}

// ---- per-provider data handlers ----
function handleOpenAIData(dataStr, handlers) {
  if (dataStr === '[DONE]') return;
  const json = JSON.parse(dataStr);
  const text = json && json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
  if (text) handlers.onDelta(text);
}
function handleClaudeData(dataStr, handlers) {
  const json = JSON.parse(dataStr);
  if (json.type === 'content_block_delta' && json.delta && json.delta.text) {
    handlers.onDelta(json.delta.text);
  }
}
function handleGeminiData(dataStr, handlers) {
  const json = JSON.parse(dataStr);
  const parts = json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts;
  if (Array.isArray(parts)) {
    for (const p of parts) if (typeof p.text === 'string') handlers.onDelta(p.text);
  }
}
function handleOllamaLine(line, handlers) {
  const json = JSON.parse(line);
  if (json.message && json.message.content) handlers.onDelta(json.message.content);
}

// ---- per-provider request builders ----
async function streamOpenAI(opts, handlers) {
  const baseUrl = trimUrl(opts.baseUrl);
  if (!baseUrl) throw new Error('Base URL is required (set it in AI Settings).');
  const messages = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const m of opts.messages) messages.push({ role: m.role, content: m.content });
  const body = { model: opts.model, messages, stream: true };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  const headers = { 'Content-Type': 'application/json' };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`; // optional for OpenAI-Compatible local servers
  const res = await request(`${baseUrl}/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal,
    allowSelfSigned: opts.allowSelfSigned, proxy: opts.proxy
  });
  if (res.statusCode >= 400) throw new Error(`OpenAI ${res.statusCode}: ${(await readStream(res.body)).slice(0, 500)}`);
  consumeSSE(res.body, handleOpenAIData, handlers);
}

async function streamClaude(opts, handlers) {
  const baseUrl = trimUrl(opts.baseUrl) || PROVIDERS.claude.defaultBaseUrl;
  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens || 4096,
    messages: opts.messages.map(m => ({ role: m.role, content: m.content })),
    stream: true
  };
  if (opts.system) body.system = opts.system;
  // NOTE: temperature/top_p/top_k intentionally omitted — rejected (400) on Claude 4.6+.
  const res = await request(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: opts.signal, allowSelfSigned: opts.allowSelfSigned, proxy: opts.proxy
  });
  if (res.statusCode >= 400) throw new Error(`Claude ${res.statusCode}: ${(await readStream(res.body)).slice(0, 500)}`);
  consumeSSE(res.body, handleClaudeData, handlers);
}

async function streamGemini(opts, handlers) {
  const baseUrl = trimUrl(opts.baseUrl) || PROVIDERS.gemini.defaultBaseUrl;
  const body = {
    contents: opts.messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    })),
    generationConfig: {}
  };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
  if (opts.maxTokens) body.generationConfig.maxOutputTokens = opts.maxTokens;
  if (typeof opts.temperature === 'number') body.generationConfig.temperature = opts.temperature;
  const url = `${baseUrl}/models/${encodeURIComponent(opts.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(opts.apiKey)}`;
  const res = await request(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: opts.signal, allowSelfSigned: opts.allowSelfSigned, proxy: opts.proxy
  });
  if (res.statusCode >= 400) throw new Error(`Gemini ${res.statusCode}: ${(await readStream(res.body)).slice(0, 500)}`);
  consumeSSE(res.body, handleGeminiData, handlers);
}

async function streamOllama(opts, handlers) {
  const baseUrl = trimUrl(opts.baseUrl) || PROVIDERS.ollama.defaultBaseUrl;
  const messages = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const m of opts.messages) messages.push({ role: m.role, content: m.content });
  const body = { model: opts.model, messages, stream: true };
  const res = await request(`${baseUrl}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: opts.signal, allowSelfSigned: opts.allowSelfSigned, proxy: opts.proxy
  });
  if (res.statusCode >= 400) throw new Error(`Ollama ${res.statusCode}: ${(await readStream(res.body)).slice(0, 500)}`);
  consumeNDJSON(res.body, handleOllamaLine, handlers);
}

// ---- unified entry ----
// opts: { provider, baseUrl, apiKey, model, messages, system, temperature, maxTokens }
// onDelta(text) called per token; resolves with the full text on completion, rejects on error.
// A user-initiated abort (signal) resolves with whatever was streamed so far.
async function streamChat(opts, onDelta, signal) {
  return new Promise((resolve, reject) => {
    let full = '';
    const handlers = {
      onDelta: (t) => { full += t; try { onDelta && onDelta(t); } catch (e) {} },
      onClose: () => resolve(full),
      onError: (err) => reject(err)
    };
    const run = async () => {
      const reqOpts = Object.assign({}, opts, { signal });
      const driver = (PROVIDERS[opts.provider] && PROVIDERS[opts.provider].driver) || opts.provider;
      switch (driver) {
        case 'openai': return streamOpenAI(reqOpts, handlers);
        case 'claude': return streamClaude(reqOpts, handlers);
        case 'gemini': return streamGemini(reqOpts, handlers);
        case 'ollama': return streamOllama(reqOpts, handlers);
        default: throw new Error('Unknown provider: ' + opts.provider);
      }
    };
    run().catch((err) => {
      // A user-initiated abort resolves with whatever was streamed so far.
      const aborted = (signal && signal.aborted) || (err && (err.name === 'AbortError' || err.message === 'aborted'));
      if (aborted) resolve(full);
      else reject(err);
    });
  });
}

// Fetch the list of available models for a provider (best-effort; static catalog otherwise).
async function getJson(url, { headers, allowSelfSigned, proxy, timeoutMs = 8000 }) {
  const res = await request(url, { method: 'GET', headers, timeoutMs, allowSelfSigned, proxy });
  const text = await readStream(res.body);
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  return { status: res.statusCode, data };
}

async function listModels(provider, baseUrl, apiKey, allowSelfSigned, proxy) {
  const driver = (PROVIDERS[provider] && PROVIDERS[provider].driver) || provider;
  if (driver === 'ollama') {
    const b = trimUrl(baseUrl) || PROVIDERS.ollama.defaultBaseUrl;
    const res = await getJson(`${b}/api/tags`, { allowSelfSigned, proxy });
    if (res.status >= 400) throw modelsError('Ollama', res.status, `${b}/api/tags`);
    return (res.data && res.data.models || []).map(m => m.name);
  }
  if (driver === 'openai') {
    const b = trimUrl(baseUrl);
    if (!b) throw new Error('Set a Base URL first (it should usually end with /v1)');
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    // Try common model-list endpoints so discovery works whether or not the
    // Base URL already includes /v1 (e.g. /models then /v1/models).
    const urls = [`${b}/models`];
    if (!/\/v\d+$/i.test(b)) urls.push(`${b}/v1/models`);
    let lastErr;
    for (const url of urls) {
      try {
        const res = await getJson(url, { headers, allowSelfSigned, proxy });
        if (res.status < 400) return extractModelIds(res.data);
        lastErr = modelsError('OpenAI', res.status, url);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Could not list models — check the Base URL');
  }
  if (driver === 'gemini') {
    const b = trimUrl(baseUrl) || PROVIDERS.gemini.defaultBaseUrl;
    const res = await getJson(`${b}/models?key=${encodeURIComponent(apiKey)}&pageSize=200`, { allowSelfSigned, proxy });
    if (res.status >= 400) throw modelsError('Gemini', res.status, `${b}/models`);
    return (res.data && res.data.models || []).map(m => (m.name || '').replace(/^models\//, ''));
  }
  if (driver === 'claude') {
    const b = trimUrl(baseUrl) || PROVIDERS.claude.defaultBaseUrl;
    const res = await getJson(`${b}/v1/models`, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, allowSelfSigned, proxy });
    if (res.status >= 400) throw modelsError('Claude', res.status, `${b}/v1/models`);
    return (res.data && res.data.data || []).map(m => m.id);
  }
  return [];
}

module.exports = { PROVIDERS, streamChat, listModels };
