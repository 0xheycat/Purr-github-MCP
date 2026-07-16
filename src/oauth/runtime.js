import { timingSafeEqual } from 'node:crypto';

import { OAUTH_SCOPES } from './scopes.js';

export function env(key, fallback = '') {
  return process.env[key] ?? fallback;
}

export function envInt(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function splitList(raw = '') {
  return String(raw).split(/[ ,]+/).map((item) => item.trim()).filter(Boolean);
}

export function requestOrigin(req, config) {
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? `localhost:${config.port}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

export function publicBaseUrl(req, config) {
  return String(config.publicBaseUrl || requestOrigin(req, config)).replace(/\/+$/, '');
}

export function authIssuer(req, config) {
  return String(config.issuer || requestOrigin(req, config)).replace(/\/+$/, '');
}

export function resourceUrl(req, config) {
  return config.resourceUrl || `${publicBaseUrl(req, config)}/mcp`;
}

export function resourceMetadataUrl(req, config) {
  const resource = new URL(resourceUrl(req, config));
  const path = resource.pathname === '/' ? '' : resource.pathname;
  return `${resource.origin}/.well-known/oauth-protected-resource${path}`;
}

export function oauthMetadata(req, config) {
  return {
    resource: resourceUrl(req, config),
    resource_name: config.resourceName,
    bearer_methods_supported: ['header'],
    scopes_supported: OAUTH_SCOPES,
    authorization_servers: config.authorizationServers.length > 0
      ? config.authorizationServers
      : [authIssuer(req, config)],
    resource_documentation: `${publicBaseUrl(req, config)}/docs/chatgpt-oauth`,
  };
}

export function authServerMetadata(req, config) {
  const issuer = authIssuer(req, config);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: OAUTH_SCOPES,
    resource_indicators_supported: true,
  };
}

function headerSafe(value) {
  return String(value).replace(/["\\\r\n]/g, '');
}

export function wwwAuthenticate(req, config, scope) {
  const values = [
    `Bearer realm="${headerSafe(config.realm)}"`,
    `resource_metadata="${headerSafe(resourceMetadataUrl(req, config))}"`,
  ];
  if (scope) values.push(`scope="${headerSafe(scope)}"`);
  return values.join(', ');
}

export function corsHeaders(config, extra = {}) {
  return {
    'Access-Control-Allow-Origin': config.corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
    ...extra,
  };
}

export function securityHeaders(config, contentType, extra = {}) {
  return corsHeaders(config, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...extra,
  });
}

export function sendJson(res, config, status, body, extraHeaders = {}) {
  res.writeHead(status, securityHeaders(config, 'application/json; charset=utf-8', extraHeaders));
  res.end(JSON.stringify(body));
}

export function sendHtml(res, config, status, body, nonce, extraHeaders = {}) {
  res.writeHead(status, securityHeaders(config, 'text/html; charset=utf-8', {
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    ...extraHeaders,
  }));
  res.end(body);
}

export function redirect(res, config, location, extraHeaders = {}) {
  res.writeHead(302, securityHeaders(config, 'text/plain; charset=utf-8', { Location: location, ...extraHeaders }));
  res.end();
}

export async function readRequestBody(req, maximum) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw new Error('request_body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function parseCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const item of String(raw).split(';')) {
    const [key, ...value] = item.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

export function parseBearer(req) {
  const match = String(req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

export function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
