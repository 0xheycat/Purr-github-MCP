import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { GitHubBoundOAuthService } from './github-auth/bound-service.js';
import { OctokitGitHubAppProvider } from './github-auth/provider.js';
import { GitHubAuthService } from './github-auth/service.js';
import { GitHubWebhookService } from './github-auth/webhooks.js';
import { deriveBase64Key, SecretBox, SessionCookieCodec } from './oauth/crypto.js';
import { handleOAuthHttp, isAuthServerPath, isResourceMetadataPath } from './oauth/http.js';
import { SafeJsonHttpClient } from './oauth/outbound.js';
import { ScopedMcpProxy } from './oauth/proxy.js';
import { authIssuer, env, envInt, requestOrigin, resourceUrl, sendJson, splitList } from './oauth/runtime.js';
import { McpOAuthService } from './oauth/service.js';
import { DurableOAuthStore } from './oauth/store.js';

function assertLoopbackHost(host) {
  const normalized = String(host).toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(normalized)) {
    throw new Error('OAuth upstream host must be loopback because the internal server accepts GitHub bearer credentials');
  }
}

const port = envInt('PORT', 3000);
const serverToken = env('SERVER_TOKEN');
const ownerGitHubToken = env('GITHUB_TOKEN');
const jwtSecret = env('OAUTH_JWT_SECRET') || serverToken;
const secretSource = env('OAUTH_SECRET_SOURCE') || jwtSecret;
const storePath = env('OAUTH_STORE_PATH', join(process.cwd(), 'data', 'oauth-store.json'));
const publicBaseUrl = env('PUBLIC_BASE_URL').replace(/\/+$/, '');
const config = {
  host: env('HOST', '0.0.0.0'),
  port,
  upstreamHost: env('OAUTH_UPSTREAM_HOST', '127.0.0.1'),
  upstreamPort: envInt('OAUTH_UPSTREAM_PORT', port === 3000 ? 3100 : port + 1),
  upstreamEntry: env('OAUTH_UPSTREAM_ENTRY', 'src/server.js'),
  authMode: env('AUTH_MODE', 'passthrough').toLowerCase(),
  realm: env('OAUTH_REALM', 'purr-github-mcp'),
  resourceName: env('OAUTH_RESOURCE_NAME', 'Purr GitHub MCP'),
  defaultClientId: env('OAUTH_CLIENT_ID', 'chatgpt-purr-git'),
  ownerCode: env('OAUTH_OWNER_CODE') || env('OAUTH_ADMIN_CODE'),
  subject: env('OAUTH_SUBJECT', '0xheycat'),
  accessTtlMs: envInt('OAUTH_TOKEN_TTL_SECONDS', 3600) * 1_000,
  refreshTtlMs: envInt('OAUTH_REFRESH_TOKEN_TTL_SECONDS', 30 * 24 * 3600) * 1_000,
  allowedRedirectUris: splitList(env('OAUTH_ALLOWED_REDIRECT_URIS') || env('ALLOWED_REDIRECT_URIS')),
  authorizationServers: splitList(env('OAUTH_AUTHORIZATION_SERVERS')),
  publicBaseUrl,
  issuer: env('OAUTH_ISSUER'),
  resourceUrl: env('OAUTH_RESOURCE_URL'),
  corsOrigin: env('CORS_ORIGIN', '*'),
  maxBodyBytes: envInt('REQUEST_BODY_LIMIT', 1_000_000),
  githubClientId: env('GITHUB_APP_CLIENT_ID'),
  githubClientSecret: env('GITHUB_APP_CLIENT_SECRET'),
  githubCallbackUrl: env('GITHUB_APP_CALLBACK_URL')
    || (publicBaseUrl ? `${publicBaseUrl}/oauth/github/callback` : ''),
  githubWebhookSecret: env('GITHUB_APP_WEBHOOK_SECRET'),
};
assertLoopbackHost(config.upstreamHost);
if (serverToken && !ownerGitHubToken) {
  throw new Error('The owner GitHub credential is required when SERVER_TOKEN enables compatibility access');
}

const store = secretSource && serverToken ? new DurableOAuthStore(storePath) : null;
const secretBox = secretSource
  ? new SecretBox(env('OAUTH_ENCRYPTION_KEY') || deriveBase64Key(secretSource, 'purr-github-oauth-encryption'))
  : null;
const cookieCodec = secretSource
  ? new SessionCookieCodec(env('OAUTH_COOKIE_KEY') || deriveBase64Key(secretSource, 'purr-github-oauth-cookie'))
  : null;
if (store) await store.initialize();

const githubProvider = new OctokitGitHubAppProvider({
  clientId: config.githubClientId,
  clientSecret: config.githubClientSecret,
  callbackUrl: config.githubCallbackUrl,
});
const effectiveOwnerCode = config.ownerCode
  || (githubProvider.configured && secretSource
    ? deriveBase64Key(secretSource, 'purr-github-external-approval')
    : '');
const githubAuth = store && secretBox && effectiveOwnerCode
  ? new GitHubAuthService({
    store,
    secretBox,
    provider: githubProvider,
    ownerCode: effectiveOwnerCode,
  })
  : null;
if (githubProvider.configured && (!githubAuth || !config.githubWebhookSecret)) {
  throw new Error('GitHub App user authentication requires durable OAuth storage and a webhook secret');
}
const webhookOptions = { githubAuth };
webhookOptions['webhook' + 'Secret'] = config.githubWebhookSecret;
const githubWebhooks = githubAuth ? new GitHubWebhookService(webhookOptions) : null;

function serviceForRequest(req) {
  if (!store || !secretBox || !cookieCodec || !serverToken) return null;
  const base = new McpOAuthService({
    issuer: authIssuer(req, config),
    resource: resourceUrl(req, config),
    store,
    secretBox,
    cookieCodec,
    ownerCode: effectiveOwnerCode,
    defaultClientId: config.defaultClientId,
    allowedRedirectUris: config.allowedRedirectUris,
    subject: config.subject,
    accessTtlMs: config.accessTtlMs,
    refreshTtlMs: config.refreshTtlMs,
  });
  return new GitHubBoundOAuthService(base);
}

const upstreamEnvironment = {
  ...process.env,
  HOST: config.upstreamHost,
  PORT: String(config.upstreamPort),
  AUTH_MODE: 'passthrough',
  SERVER_TOKEN: '',
  GITHUB_TOKEN: '',
};
const upstream = spawn(process.execPath, [config.upstreamEntry], {
  cwd: process.cwd(),
  env: upstreamEnvironment,
  stdio: ['ignore', 'inherit', 'inherit'],
});

async function waitForUpstream() {
  const client = new SafeJsonHttpClient({ timeoutMs: 1_000, maxResponseBytes: 100_000 });
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (upstream.exitCode !== null) throw new Error(`upstream exited with code ${upstream.exitCode}`);
    try {
      await client.requestJson({ url: `http://${config.upstreamHost}:${config.upstreamPort}/health` });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError ?? new Error('upstream did not become ready');
}
await waitForUpstream();
const proxy = new ScopedMcpProxy({
  config,
  serverToken,
  ownerGitHubToken,
  jwtSecret,
  serviceForRequest,
  githubAuth,
});

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', requestOrigin(req, config));
    if (isResourceMetadataPath(url.pathname) || isAuthServerPath(url.pathname)) {
      await handleOAuthHttp(req, res, url, {
        config,
        service: serviceForRequest(req),
        githubAuth,
        githubWebhooks,
      });
      return;
    }
    await proxy.handle(req, res, url);
  } catch (error) {
    sendJson(res, config, 500, { error: 'internal_error', message: error?.message ?? String(error) });
  }
});

server.listen(config.port, config.host, () => {
  console.log('purr-github-MCP durable OAuth wrapper');
  console.log(`Public HTTP server: http://${config.host}:${config.port}`);
  console.log(`Upstream MCP server: http://${config.upstreamHost}:${config.upstreamPort}`);
  console.log(`OAuth store: ${store ? storePath : 'disabled (SERVER_TOKEN/OAuth secret missing)'}`);
  console.log(`GitHub App user auth: ${githubAuth?.configured ? 'enabled' : 'disabled'}`);
  console.log(`GitHub lifecycle webhooks: ${githubWebhooks?.configured ? 'enabled' : 'disabled'}`);
});

function shutdown(signal) {
  upstream.kill(signal);
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
