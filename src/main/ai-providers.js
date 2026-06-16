// AI provider adapter for TeamAPI chat.
// Maps one unified request to OpenAI / Claude (Anthropic) / Gemini (Google) / Ollama
// and streams text deltas back via callbacks. All HTTP runs in the main process
// (no CORS). Uses axios with responseType: 'stream'.
const axios = require('axios');

// Static provider catalog (no secrets). Returned to the renderer via ai:providers:list.
// `driver` selects the transport; multiple entries can share one (OpenAI-Compatible
// reuses the OpenAI path). Order here = dropdown order. Ollama is first/default
// (local, no API key). `keyOptional` = key field shown but not required.
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
    name: 'OpenAI-Compatible',
    driver: 'openai',
    requiresKey: false,
    keyOptional: true,
    keyPlaceholder: 'sk-... (optional)',
    defaultBaseUrl: '',
    defaultModel: '',
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
  const res = await axios.post(`${baseUrl}/chat/completions`, body, {
    headers, responseType: 'stream', validateStatus: () => true, signal: opts.signal, timeout: 0
  });
  if (res.status >= 400) throw new Error(`OpenAI ${res.status}: ${(await readStream(res.data)).slice(0, 500)}`);
  consumeSSE(res.data, handleOpenAIData, handlers);
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
  const res = await axios.post(`${baseUrl}/v1/messages`, body, {
    headers: { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    responseType: 'stream', validateStatus: () => true, signal: opts.signal, timeout: 0
  });
  if (res.status >= 400) throw new Error(`Claude ${res.status}: ${(await readStream(res.data)).slice(0, 500)}`);
  consumeSSE(res.data, handleClaudeData, handlers);
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
  const res = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    responseType: 'stream', validateStatus: () => true, signal: opts.signal, timeout: 0
  });
  if (res.status >= 400) throw new Error(`Gemini ${res.status}: ${(await readStream(res.data)).slice(0, 500)}`);
  consumeSSE(res.data, handleGeminiData, handlers);
}

async function streamOllama(opts, handlers) {
  const baseUrl = trimUrl(opts.baseUrl) || PROVIDERS.ollama.defaultBaseUrl;
  const messages = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const m of opts.messages) messages.push({ role: m.role, content: m.content });
  const body = { model: opts.model, messages, stream: true };
  const res = await axios.post(`${baseUrl}/api/chat`, body, {
    headers: { 'Content-Type': 'application/json' },
    responseType: 'stream', validateStatus: () => true, signal: opts.signal, timeout: 0
  });
  if (res.status >= 400) throw new Error(`Ollama ${res.status}: ${(await readStream(res.data)).slice(0, 500)}`);
  consumeNDJSON(res.data, handleOllamaLine, handlers);
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
      if (axios.isCancel(err) || (err && err.code === 'ERR_CANCELED')) resolve(full); // abort → keep partial
      else reject(err);
    });
  });
}

// Fetch the list of available models for a provider (best-effort; static catalog otherwise).
async function listModels(provider, baseUrl, apiKey) {
  const driver = (PROVIDERS[provider] && PROVIDERS[provider].driver) || provider;
  if (driver === 'ollama') {
    const b = trimUrl(baseUrl) || PROVIDERS.ollama.defaultBaseUrl;
    const res = await axios.get(`${b}/api/tags`, { timeout: 8000, validateStatus: () => true });
    if (res.status >= 400) throw new Error(`Ollama ${res.status}`);
    return (res.data && res.data.models || []).map(m => m.name);
  }
  if (driver === 'openai') {
    const b = trimUrl(baseUrl);
    if (!b) throw new Error('Set a Base URL first');
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await axios.get(`${b}/models`, { headers, timeout: 8000, validateStatus: () => true });
    if (res.status >= 400) throw new Error(`OpenAI ${res.status}`);
    return (res.data && res.data.data || []).map(m => m.id);
  }
  if (driver === 'gemini') {
    const b = trimUrl(baseUrl) || PROVIDERS.gemini.defaultBaseUrl;
    const res = await axios.get(`${b}/models?key=${encodeURIComponent(apiKey)}&pageSize=200`, { timeout: 8000, validateStatus: () => true });
    if (res.status >= 400) throw new Error(`Gemini ${res.status}`);
    return (res.data && res.data.models || []).map(m => (m.name || '').replace(/^models\//, ''));
  }
  if (driver === 'claude') {
    const b = trimUrl(baseUrl) || PROVIDERS.claude.defaultBaseUrl;
    const res = await axios.get(`${b}/v1/models`, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, timeout: 8000, validateStatus: () => true });
    if (res.status >= 400) throw new Error(`Claude ${res.status}`);
    return (res.data && res.data.data || []).map(m => m.id);
  }
  return [];
}

module.exports = { PROVIDERS, streamChat, listModels };
