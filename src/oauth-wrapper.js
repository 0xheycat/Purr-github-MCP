import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

function env(key, fallback = '') {
  return process.env[key] ?? fallback;
}

function envInt(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitList(raw = '') {
  return String(raw)
    .split(/[ ,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeNoTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

const publicPort = envInt('PORT', 3000);
const upstreamPort = envInt('OAUTH_UPSTREAM_PORT', publicPort === 3000 ? 3100 : publicPort + 1);
const authorizationCodes = new Map();
const registeredClients = new Map();

const config = {
  host: env('HOST', '0.0.0.0'),
  port: publicPort,
  upstreamHost: env('OAUTH_UPSTREAM_HOST', '127.0.0.1'),
  upstreamPort,
  realm: env('OAUTH_REALM', 'purr-github-mcp'),
  resourceName: env('OAUTH_RESOURCE_NAME', 'Purr GitHub MCP'),
  defaultClientId: env('OAUTH_CLIENT_ID', 'chatgpt-purr-git'),
  tokenTtlSeconds: envInt('OAUTH_TOKEN_TTL_SECONDS', 3600),
};

function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? `localhost:${config.port}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

function publicBaseUrl(req) {
  return normalizeNoTrailingSlash(env('PUBLIC_BASE_URL') || requestOrigin(req));
}

function authIssuer(req) {
  return normalizeNoTrailingSlash(env('OAUTH_ISSUER') || requestOrigin(req));
}

function resourceUrl(req) {
  return env('OAUTH_RESOURCE_URL') || `${publicBaseUrl(req)}/mcp`;
}

function resourceMetadataUrl(req) {
  const resource = new URL(resourceUrl(req));
  const path = resource.pathname === '/' ? '' : resource.pathname;
  return `${resource.origin}/.well-known/oauth-protected-resource${path}`;
}

function oauthMetadata(req) {
  const authorizationServers = splitList(env('OAUTH_AUTHORIZATION_SERVERS') || authIssuer(req));
  const scopes = supportedScopes();
  return {
    resource: resourceUrl(req),
    resource_name: config.resourceName,
    bearer_methods_supported: ['header'],
    scopes_supported: scopes,
    authorization_servers: authorizationServers,
    resource_documentation: `${publicBaseUrl(req)}/`,
  };
}

function authServerMetadata(req) {
  const issuer = authIssuer(req);
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: supportedScopes(),
    resource_indicators_supported: true,
  };
}

function supportedScopes() {
  return splitList(env('OAUTH_SCOPES_SUPPORTED', 'repo read:user user:email'));
}

function allowedRedirectUris() {
  return splitList(env('OAUTH_ALLOWED_REDIRECT_URIS') || env('ALLOWED_REDIRECT_URIS'));
}

function ownerCode() {
  return env('OAUTH_OWNER_CODE') || env('OAUTH_ADMIN_CODE');
}

function jwtSecret() {
  return env('OAUTH_JWT_SECRET') || env('SERVER_TOKEN');
}

function headerSafe(value) {
  return String(value).replace(/["\\\r\n]/g, '');
}

function wwwAuthenticate(req) {
  return `Bearer realm="${headerSafe(config.realm)}", resource_metadata="${headerSafe(resourceMetadataUrl(req))}"`;
}

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': env('CORS_ORIGIN', '*'),
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
    ...extra,
  };
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, corsHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }));
  res.end(JSON.stringify(body));
}

function sendHtml(res, status, body, extraHeaders = {}) {
  res.writeHead(status, corsHeaders({ 'Content-Type': 'text/html; charset=utf-8', ...extraHeaders }));
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, corsHeaders({ Location: location }));
  res.end();
}

function isResourceMetadataPath(pathname) {
  return pathname === '/.well-known/oauth-protected-resource'
    || pathname === '/.well-known/oauth-protected-resource/mcp';
}

function isAuthServerPath(pathname) {
  return pathname === '/.well-known/oauth-authorization-server'
    || pathname === '/.well-known/openid-configuration'
    || pathname === '/authorize'
    || pathname === '/token'
    || pathname === '/register'
    || pathname === '/jwks.json';
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function jsonBase64url(value) {
  return base64url(JSON.stringify(value));
}

function sha256Base64url(value) {
  return createHash('sha256').update(value).digest('base64url');
}

function hmacBase64url(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function timingEqualString(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function signJwt(payload) {
  const secret = jwtSecret();
  if (!secret) throw new Error('OAUTH_JWT_SECRET or SERVER_TOKEN is required');
  const header = { alg: 'HS256', typ: 'JWT' };
  const unsigned = `${jsonBase64url(header)}.${jsonBase64url(payload)}`;
  return `${unsigned}.${hmacBase64url(unsigned, secret)}`;
}

function verifyJwt(token, req) {
  const secret = jwtSecret();
  if (!secret) return { ok: false, error: 'missing_jwt_secret' };
  const parts = String(token).split('.');
  if (parts.length !== 3) return { ok: false, error: 'malformed_token' };
  const [encodedHeader, encodedPayload, signature] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'invalid_token_json' };
  }
  if (header.alg !== 'HS256') return { ok: false, error: 'unsupported_alg' };
  const expected = hmacBase64url(`${encodedHeader}.${encodedPayload}`, secret);
  if (!timingEqualString(signature, expected)) return { ok: false, error: 'bad_signature' };
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) return { ok: false, error: 'expired_token' };
  if (payload.iss !== authIssuer(req)) return { ok: false, error: 'bad_issuer' };
  const expectedAudience = resourceUrl(req);
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audience.includes(expectedAudience)) return { ok: false, error: 'bad_audience' };
  return { ok: true, payload };
}

function parseBearer(req) {
  const authorization = req.headers.authorization || '';
  const match = String(authorization).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function rewriteAuthorizationHeader(req) {
  const token = parseBearer(req);
  if (!token) return null;
  const serverToken = env('SERVER_TOKEN');
  if (!serverToken) return null;
  if (token === serverToken) return null;
  const verified = verifyJwt(token, req);
  if (!verified.ok) return null;
  return `Bearer ${serverToken}`;
}

function isRedirectAllowed(clientId, redirectUri) {
  const registered = registeredClients.get(clientId);
  if (registered?.redirect_uris?.includes(redirectUri)) return true;
  if (clientId === config.defaultClientId) {
    const allowed = allowedRedirectUris();
    if (allowed.length > 0) return allowed.includes(redirectUri);
    return redirectUri.startsWith('https://chatgpt.com/connector/oauth/');
  }
  return false;
}

function validateAuthorizeParams(params, req) {
  const responseType = params.get('response_type');
  const clientId = params.get('client_id') || '';
  const redirectUri = params.get('redirect_uri') || '';
  const codeChallenge = params.get('code_challenge') || '';
  const codeChallengeMethod = params.get('code_challenge_method') || '';
  const resource = params.get('resource') || resourceUrl(req);
  if (responseType !== 'code') return 'response_type must be code';
  if (!clientId) return 'client_id is required';
  if (!redirectUri) return 'redirect_uri is required';
  if (!isRedirectAllowed(clientId, redirectUri)) return 'redirect_uri is not allowed for this client_id';
  if (!codeChallenge) return 'code_challenge is required';
  if (codeChallengeMethod !== 'S256') return 'code_challenge_method must be S256';
  if (resource !== resourceUrl(req)) return 'resource does not match this MCP server';
  return '';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderAuthorizePage(params, req, error = '') {
  const fields = ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'resource'];
  const hidden = fields.map((key) => `<input type="hidden" name="${key}" value="${escapeHtml(params.get(key) || (key === 'resource' ? resourceUrl(req) : ''))}">`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Purr GitHub MCP OAuth</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#09090b;color:#fafafa;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
    main{width:min(440px,100%);background:#18181b;border:1px solid #3f3f46;border-radius:18px;padding:24px;box-shadow:0 18px 60px #0008}
    h1{font-size:20px;margin:0 0 8px} p{color:#d4d4d8;line-height:1.5} code{color:#fbbf24;word-break:break-all}
    input,button{width:100%;box-sizing:border-box;border-radius:10px;border:1px solid #52525b;background:#09090b;color:#fafafa;padding:12px;font-size:15px}
    button{margin-top:12px;background:#f97316;border:0;font-weight:700;cursor:pointer}.err{color:#fca5a5}.muted{font-size:13px;color:#a1a1aa}
  </style>
</head>
<body>
  <main>
    <h1>Authorize Purr GitHub MCP</h1>
    <p>ChatGPT is requesting access to <code>${escapeHtml(resourceUrl(req))}</code>.</p>
    <p class="muted">Client: <code>${escapeHtml(params.get('client_id') || '')}</code><br>Scopes: <code>${escapeHtml(params.get('scope') || supportedScopes().join(' '))}</code></p>
    ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
    <form method="post" action="/authorize">
      ${hidden}
      <label>Owner approval code</label>
      <input type="password" name="owner_code" autocomplete="current-password" required autofocus>
      <button type="submit">Authorize ChatGPT</button>
    </form>
  </main>
</body>
</html>`;
}

async function readRequestBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('request_body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleAuthorize(req, res, url) {
  if (!ownerCode()) {
    sendHtml(res, 500, '<h1>OAuth setup required</h1><p>Set OAUTH_OWNER_CODE before using /authorize.</p>');
    return;
  }
  if (req.method === 'GET') {
    const error = validateAuthorizeParams(url.searchParams, req);
    if (error) {
      sendHtml(res, 400, renderAuthorizePage(url.searchParams, req, error));
      return;
    }
    sendHtml(res, 200, renderAuthorizePage(url.searchParams, req));
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const body = await readRequestBody(req);
  const params = new URLSearchParams(body);
  const error = validateAuthorizeParams(params, req);
  if (error) {
    sendHtml(res, 400, renderAuthorizePage(params, req, error));
    return;
  }
  if (!timingEqualString(params.get('owner_code') || '', ownerCode())) {
    sendHtml(res, 401, renderAuthorizePage(params, req, 'Invalid owner approval code.'));
    return;
  }
  const code = randomBytes(32).toString('base64url');
  authorizationCodes.set(code, {
    client_id: params.get('client_id'),
    redirect_uri: params.get('redirect_uri'),
    scope: params.get('scope') || supportedScopes().join(' '),
    resource: params.get('resource') || resourceUrl(req),
    code_challenge: params.get('code_challenge'),
    created_at: Date.now(),
    expires_at: Date.now() + 5 * 60 * 1000,
  });
  const callback = new URL(params.get('redirect_uri'));
  callback.searchParams.set('code', code);
  const state = params.get('state');
  if (state) callback.searchParams.set('state', state);
  redirect(res, callback.toString());
}

async function handleToken(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  const body = await readRequestBody(req);
  const params = new URLSearchParams(body);
  if (params.get('grant_type') !== 'authorization_code') {
    sendJson(res, 400, { error: 'unsupported_grant_type' });
    return;
  }
  const code = params.get('code') || '';
  const entry = authorizationCodes.get(code);
  authorizationCodes.delete(code);
  if (!entry || entry.expires_at < Date.now()) {
    sendJson(res, 400, { error: 'invalid_grant' });
    return;
  }
  if (params.get('client_id') !== entry.client_id || params.get('redirect_uri') !== entry.redirect_uri) {
    sendJson(res, 400, { error: 'invalid_grant' });
    return;
  }
  const verifier = params.get('code_verifier') || '';
  if (!verifier || sha256Base64url(verifier) !== entry.code_challenge) {
    sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const accessToken = signJwt({
    iss: authIssuer(req),
    sub: env('OAUTH_SUBJECT', '0xheycat'),
    aud: entry.resource,
    client_id: entry.client_id,
    scope: entry.scope,
    iat: now,
    exp: now + config.tokenTtlSeconds,
  });
  sendJson(res, 200, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: config.tokenTtlSeconds,
    scope: entry.scope,
  }, { 'Cache-Control': 'no-store' });
}

async function handleRegister(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  let body = {};
  try {
    body = JSON.parse(await readRequestBody(req));
  } catch {
    sendJson(res, 400, { error: 'invalid_client_metadata' });
    return;
  }
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((uri) => typeof uri === 'string') : [];
  if (redirectUris.length === 0) {
    sendJson(res, 400, { error: 'invalid_redirect_uri' });
    return;
  }
  const clientId = `chatgpt-${randomBytes(12).toString('base64url')}`;
  registeredClients.set(clientId, { redirect_uris: redirectUris, created_at: Date.now() });
  sendJson(res, 201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
}

async function handleAuthServerPath(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  if (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
    return sendJson(res, 200, authServerMetadata(req));
  }
  if (url.pathname === '/authorize') return handleAuthorize(req, res, url);
  if (url.pathname === '/token') return handleToken(req, res);
  if (url.pathname === '/register') return handleRegister(req, res);
  if (url.pathname === '/jwks.json') return sendJson(res, 200, { keys: [] });
}

const upstream = spawn(process.execPath, ['src/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: config.upstreamHost,
    PORT: String(config.upstreamPort),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

upstream.on('exit', (code, signal) => {
  if (signal) {
    console.log(`purr-github-MCP upstream exited via ${signal}`);
  } else {
    console.log(`purr-github-MCP upstream exited with code ${code}`);
  }
});

function proxyToUpstream(req, res) {
  const headers = {
    ...req.headers,
    host: `${config.upstreamHost}:${config.upstreamPort}`,
  };
  const rewrittenAuthorization = rewriteAuthorizationHeader(req);
  if (rewrittenAuthorization) headers.authorization = rewrittenAuthorization;

  const upstreamReq = httpRequest({
    host: config.upstreamHost,
    port: config.upstreamPort,
    method: req.method,
    path: req.url,
    headers,
  }, (upstreamRes) => {
    const headers = { ...upstreamRes.headers };
    if (upstreamRes.statusCode === 401 && !headers['www-authenticate']) {
      headers['www-authenticate'] = wwwAuthenticate(req);
    }
    res.writeHead(upstreamRes.statusCode ?? 502, headers);
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', (error) => {
    sendJson(res, 502, { error: 'upstream_unavailable', message: error?.message ?? String(error) });
  });

  req.pipe(upstreamReq);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', requestOrigin(req));

    if (isResourceMetadataPath(url.pathname)) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders());
        res.end();
        return;
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }
      sendJson(res, 200, oauthMetadata(req));
      return;
    }

    if (isAuthServerPath(url.pathname)) {
      await handleAuthServerPath(req, res, url);
      return;
    }

    proxyToUpstream(req, res);
  } catch (error) {
    sendJson(res, 500, { error: 'internal_error', message: error?.message ?? String(error) });
  }
});

server.listen(config.port, config.host, () => {
  console.log('purr-github-MCP OAuth compatibility wrapper');
  console.log(`Public HTTP server: http://${config.host}:${config.port}`);
  console.log(`Upstream MCP server: http://${config.upstreamHost}:${config.upstreamPort}`);
  console.log('OAuth resource metadata: /.well-known/oauth-protected-resource/mcp');
  console.log('OAuth authorization server metadata: /.well-known/oauth-authorization-server');
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down OAuth wrapper...`);
  upstream.kill(signal);
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
