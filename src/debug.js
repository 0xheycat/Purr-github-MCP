import { randomUUID } from 'node:crypto';

const MAX_RECENT_ERRORS = 50;
const recent = [];
const startedAt = Date.now();

export function getRequestId(req) {
  const existing = req?.headers?.['x-purr-request-id'] || req?.headers?.['x-request-id'];
  const value = Array.isArray(existing) ? existing[0] : existing;
  return value ? String(value) : `purr_${randomUUID()}`;
}

export function uptimeSeconds() {
  return Math.floor((Date.now() - startedAt) / 1000);
}

export function sanitize(value, limit = 1200) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, 'Bearer [redacted]')
    .replace(/(ghp_|github_pat_|sk-)[A-Za-z0-9_\-]{12,}/gi, '$1[redacted]')
    .replace(/(token|secret|password|authorization)\s*[:=]\s*['"]?[^\s,'"]+/gi, '$1=[redacted]')
    .slice(0, limit);
}

export function recordDebugError(entry) {
  const safe = {
    time: new Date().toISOString(),
    requestId: entry?.requestId || null,
    service: entry?.service || 'purr-github-mcp',
    phase: entry?.phase || 'unknown',
    tool: entry?.tool || null,
    status: entry?.status || null,
    code: entry?.code || null,
    message: sanitize(entry?.message || entry?.error || 'unknown error', 1000),
    hint: entry?.hint ? sanitize(entry.hint, 800) : undefined,
    contentType: entry?.contentType || undefined,
    bodyPreview: entry?.bodyPreview ? sanitize(entry.bodyPreview, 1000) : undefined,
  };
  recent.unshift(safe);
  if (recent.length > MAX_RECENT_ERRORS) recent.length = MAX_RECENT_ERRORS;
  return safe;
}

export function recentDebugErrors(limit = 20) {
  const n = Math.max(1, Math.min(Number(limit) || 20, MAX_RECENT_ERRORS));
  return recent.slice(0, n);
}

export function debugErrorPayload(entry) {
  return {
    error: entry?.code || 'tool_error',
    requestId: entry?.requestId || null,
    phase: entry?.phase || 'unknown',
    tool: entry?.tool || null,
    message: sanitize(entry?.message || entry?.error || 'unknown error', 1000),
    hint: entry?.hint ? sanitize(entry.hint, 800) : undefined,
  };
}

export function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

export function textToolResult(value, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], isError };
}
