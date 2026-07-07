import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';

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
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeNoTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

const publicPort = envInt('PORT', 3000);
const upstreamPort = envInt('OAUTH_UPSTREAM_PORT', publicPort === 3000 ? 3100 : publicPort + 1);

const config = {
  host: env('HOST', '0.0.0.0'),
  port: publicPort,
  upstreamHost: env('OAUTH_UPSTREAM_HOST', '127.0.0.1'),
  upstreamPort,
  realm: env('OAUTH_REALM', 'purr-github-mcp'),
  resourceName: env('OAUTH_RESOURCE_NAME', 'Purr GitHub MCP'),
};

function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? `localhost:${config.port}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

function publicBaseUrl(req) {
  return normalizeNoTrailingSlash(env('PUBLIC_BASE_URL') || requestOrigin(req));
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
  const authorizationServers = splitList(env('OAUTH_AUTHORIZATION_SERVERS'));
  const scopes = splitList(env('OAUTH_SCOPES_SUPPORTED', 'repo,read:user,user:email'));
  const metadata = {
    resource: resourceUrl(req),
    resource_name: config.resourceName,
    bearer_methods_supported: ['header'],
    scopes_supported: scopes,
    resource_documentation: `${publicBaseUrl(req)}/`,
  };
  if (authorizationServers.length > 0) metadata.authorization_servers = authorizationServers;
  return metadata;
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

function isMetadataPath(pathname) {
  return pathname === '/.well-known/oauth-protected-resource'
    || pathname === '/.well-known/oauth-protected-resource/mcp';
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
  const upstreamReq = httpRequest({
    host: config.upstreamHost,
    port: config.upstreamPort,
    method: req.method,
    path: req.url,
    headers: {
      ...req.headers,
      host: `${config.upstreamHost}:${config.upstreamPort}`,
    },
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

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', requestOrigin(req));

  if (isMetadataPath(url.pathname)) {
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

  proxyToUpstream(req, res);
});

server.listen(config.port, config.host, () => {
  console.log('purr-github-MCP OAuth compatibility wrapper');
  console.log(`Public HTTP server: http://${config.host}:${config.port}`);
  console.log(`Upstream MCP server: http://${config.upstreamHost}:${config.upstreamPort}`);
  console.log('OAuth metadata: /.well-known/oauth-protected-resource/mcp');
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down OAuth wrapper...`);
  upstream.kill(signal);
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
