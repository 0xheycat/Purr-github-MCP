import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

const originalCreateServer = http.createServer.bind(http);
const startedAt = Date.now();
const recent = [];
const MAX_ERRORS = 50;

function requestId(req) {
  const existing = req.headers['x-purr-request-id'] || req.headers['x-request-id'];
  const value = Array.isArray(existing) ? existing[0] : existing;
  return value ? String(value) : `purr_${randomUUID()}`;
}

function safeText(value, limit = 700) {
  return String(value ?? '')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/(ghp_|github_pat_|sk-)[A-Za-z0-9_\-]{12,}/gi, '$1[redacted]')
    .slice(0, limit);
}

function remember(entry) {
  recent.unshift({
    time: new Date().toISOString(),
    requestId: entry.requestId || null,
    phase: entry.phase || 'http_response',
    status: entry.status || null,
    method: entry.method || null,
    path: entry.path || null,
    message: safeText(entry.message || ''),
  });
  if (recent.length > MAX_ERRORS) recent.length = MAX_ERRORS;
}

function sendJson(res, status, body, rid) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-purr-request-id': rid,
  });
  res.end(JSON.stringify(body));
}

http.createServer = function patchedCreateServer(listener, ...rest) {
  const wrapped = async function purrDebugWrapper(req, res) {
    const rid = requestId(req);
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/debug') {
      return sendJson(res, 200, {
        ok: true,
        service: 'purr-github-mcp',
        layer: 'debug-preload',
        time: new Date().toISOString(),
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        recentErrorsCount: recent.length,
      }, rid);
    }

    if (req.method === 'GET' && url.pathname === '/debug/errors') {
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 20), MAX_ERRORS));
      return sendJson(res, 200, {
        ok: true,
        service: 'purr-github-mcp',
        layer: 'debug-preload',
        errors: recent.slice(0, limit),
      }, rid);
    }

    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = function patchedWriteHead(statusCode, headersOrReason, headers) {
      const finalHeaders = typeof headersOrReason === 'object' && headersOrReason !== null
        ? headersOrReason
        : (headers || {});
      finalHeaders['x-purr-request-id'] = rid;
      if (Number(statusCode) >= 400) {
        remember({
          requestId: rid,
          status: Number(statusCode),
          method: req.method,
          path: url.pathname,
          message: `HTTP ${statusCode}`,
        });
      }
      if (typeof headersOrReason === 'object' && headersOrReason !== null) {
        return originalWriteHead(statusCode, finalHeaders);
      }
      return originalWriteHead(statusCode, headersOrReason, finalHeaders);
    };

    try {
      return listener(req, res);
    } catch (error) {
      remember({
        requestId: rid,
        phase: 'uncaught_listener_error',
        method: req.method,
        path: url.pathname,
        message: error?.message || String(error),
      });
      throw error;
    }
  };
  return originalCreateServer(wrapped, ...rest);
};

syncBuiltinESMExports();
