// Lightweight HTTP client on Node's http/https modules (replaces axios).
// Supports streaming responses (Node stream), buffering, AbortController/signal,
// per-request self-signed-cert tolerance, and HTTP(S) proxy via CONNECT tunnel.
// Zero external dependencies.
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');

// Reused agent for self-signed HTTPS endpoints (no proxy).
const insecureHttpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

// Collect a Node readable stream into a single Buffer.
function toArray(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// Open a TLS tunnel through an HTTP proxy (CONNECT) — used for HTTPS-over-proxy.
function connectTunnel(proxy, host, port, allowSelfSigned) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: parseInt(proxy.port, 10) || 80 });
    let settled = false;
    const fail = (err) => {
      if (!settled) { settled = true; try { socket.destroy(); } catch (e) {} reject(err); }
    };
    socket.on('error', fail);
    socket.once('connect', () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      socket.removeListener('data', onData);
      const statusLine = buf.slice(0, idx).split('\r\n')[0];
      if (!/^HTTP\/1\.[01] 2\d\d/.test(statusLine)) {
        return fail(new Error(`Proxy CONNECT failed: ${statusLine}`));
      }
      const tlsSocket = tls.connect({ socket, servername: host, rejectUnauthorized: !allowSelfSigned });
      tlsSocket.once('secureConnect', () => { if (!settled) { settled = true; resolve(tlsSocket); } });
      tlsSocket.once('error', fail);
    };
    socket.on('data', onData);
  });
}

// Custom https.Agent that tunnels through a proxy (mirrors the https-proxy-agent pattern).
class ProxyTunnelAgent extends https.Agent {
  constructor(proxy, allowSelfSigned) {
    super();
    this.proxy = proxy;
    this.allowSelfSigned = allowSelfSigned;
  }
  createConnection(opts, cb) {
    const host = opts.host || opts.servername;
    const port = opts.port || 443;
    connectTunnel(this.proxy, host, port, this.allowSelfSigned)
      .then((socket) => cb(null, socket), (err) => cb(err));
  }
}

// Pick the right agent for the target URL + options (undefined = Node default agent).
function buildAgent(u, { allowSelfSigned, proxy }) {
  const isHttps = u.protocol === 'https:';
  if (proxy) {
    if (isHttps) return new ProxyTunnelAgent(proxy, allowSelfSigned);
    return undefined; // HTTP-over-proxy handled by sending the absolute URI to the proxy
  }
  if (isHttps && allowSelfSigned) return insecureHttpsAgent;
  return undefined;
}

// Single request attempt (no redirect handling). Returns { statusCode, statusText, headers, body, url }.
function singleRequest(targetUrl, options) {
  const { method = 'GET', headers = {}, body, signal, timeoutMs, allowSelfSigned = false, proxy } = options;
  const u = new URL(targetUrl);
  const isHttps = u.protocol === 'https:';
  const lib = isHttps ? https : http;

  let reqOpts;
  if (proxy && !isHttps) {
    // HTTP via proxy: forward the absolute URI to the proxy (no CONNECT).
    reqOpts = { method, headers, host: proxy.host, port: parseInt(proxy.port, 10) || 80, path: targetUrl, signal };
  } else {
    const agent = buildAgent(u, { allowSelfSigned, proxy });
    reqOpts = {
      method, headers, host: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search, agent, signal
    };
  }

  return new Promise((resolve, reject) => {
    const req = lib.request(reqOpts, (res) => {
      if (timeoutMs) res.setTimeout(timeoutMs, () => res.destroy(new Error('timeout')));
      resolve({ statusCode: res.statusCode, statusText: res.statusMessage, headers: res.headers || {}, body: res, url: targetUrl });
    });
    req.on('error', reject);
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

// Main request with automatic redirect following (3xx + Location), up to
// options.maxRedirects (default 5, like axios). 301/302/303 → GET and drop the
// body; 307/308 preserve method + body. Returns { statusCode, headers, body, url }.
async function request(targetUrl, options = {}) {
  let url = targetUrl;
  let opts = options;
  let redirectsLeft = options.maxRedirects === undefined ? 5 : options.maxRedirects;
  for (;;) {
    const res = await singleRequest(url, opts);
    const status = res.statusCode;
    const location = res.headers && res.headers.location;
    const isRedirect = status >= 300 && status < 400 && location;
    if (!isRedirect || redirectsLeft <= 0) return res;
    // Drain & discard the redirect body, then follow the Location (resolve relative URLs).
    try { res.body.resume(); } catch (e) {}
    url = new URL(location, url).href;
    if (status === 301 || status === 302 || status === 303) {
      if ((opts.method || 'GET') !== 'HEAD') {
        const headers = { ...opts.headers };
        delete headers['content-type'];
        delete headers['content-length'];
        opts = { ...opts, method: 'GET', body: undefined, headers };
      }
    } // 307/308: keep method + body as-is
    redirectsLeft--;
  }
}

module.exports = { request, toArray, connectTunnel, ProxyTunnelAgent, buildAgent };
