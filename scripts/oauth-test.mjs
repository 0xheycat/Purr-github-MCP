import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SecretBox, SessionCookieCodec } from '../src/oauth/crypto.js';
import { SafeJsonHttpClient } from '../src/oauth/outbound.js';
import {
  normalizeRequestedScopes,
  requiredScopeForTool,
  scopeAllows,
} from '../src/oauth/scopes.js';
import { McpOAuthService, pkceS256 } from '../src/oauth/service.js';
import { DurableOAuthStore } from '../src/oauth/store.js';

const directory = await mkdtemp(join(tmpdir(), 'purr-github-oauth-'));
const storePath = join(directory, 'oauth-store.json');

try {
  const key = randomBytes(32).toString('base64');
  const store = new DurableOAuthStore(storePath);
  await store.initialize();
  const secretBox = new SecretBox(key);
  const cookieCodec = new SessionCookieCodec(key);
  const service = new McpOAuthService({
    issuer: 'https://auth.example.test',
    resource: 'https://mcp.example.test/mcp',
    store,
    secretBox,
    cookieCodec,
    ownerCode: 'correct-owner-code',
    defaultClientId: 'chatgpt-purr-git',
    allowedRedirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    subject: 'operator-1',
    accessTtlMs: 60 * 60 * 1_000,
    refreshTtlMs: 30 * 24 * 60 * 60 * 1_000,
  });

  assert.equal(scopeAllows(['github.read'], 'github.read'), true);
  assert.equal(scopeAllows(['github.read'], 'github.plan'), false);
  assert.equal(scopeAllows(['github.plan'], 'github.read'), true);
  assert.equal(scopeAllows(['github.write'], 'github.plan'), true);
  assert.equal(scopeAllows(['github.admin'], 'github.write'), true);
  assert.deepEqual(normalizeRequestedScopes('repo read:user user:email'), [
    'github.read',
    'github.admin',
  ]);
  assert.equal(requiredScopeForTool({ name: 'get_file', annotations: { readOnlyHint: true } }), 'github.read');
  assert.equal(requiredScopeForTool({ name: 'get_verification_plan', annotations: { readOnlyHint: true } }), 'github.plan');
  assert.equal(requiredScopeForTool({ name: 'commit_files', annotations: { readOnlyHint: false } }), 'github.write');
  assert.equal(requiredScopeForTool({ name: 'merge_pull_request', annotations: { readOnlyHint: false } }), 'github.admin');

  const client = await service.registerClient({
    client_name: 'ChatGPT test client',
    redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    token_endpoint_auth_method: 'none',
  }, new Date('2026-07-16T01:00:00.000Z'));

  const verifier = 'a'.repeat(64);
  const prompt = await service.beginAuthorization(new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    code_challenge: pkceS256(verifier),
    code_challenge_method: 'S256',
    resource: service.resource,
    scope: 'github.read',
    state: 'chatgpt-state',
  }), new Date('2026-07-16T01:01:00.000Z'));

  await assert.rejects(
    service.confirmAuthorization({
      requestId: prompt.requestId,
      decision: 'approve',
      csrfToken: prompt.csrfToken,
      ownerCode: 'wrong-code',
      cookieValue: prompt.cookieValue,
      now: new Date('2026-07-16T01:01:30.000Z'),
    }),
    /access_denied/,
  );

  const approved = await service.confirmAuthorization({
    requestId: prompt.requestId,
    decision: 'approve',
    csrfToken: prompt.csrfToken,
    ownerCode: 'correct-owner-code',
    cookieValue: prompt.cookieValue,
    now: new Date('2026-07-16T01:02:00.000Z'),
  });
  assert.equal(approved.state, 'chatgpt-state');
  assert.ok(approved.code);

  await assert.rejects(
    service.confirmAuthorization({
      requestId: prompt.requestId,
      decision: 'approve',
      csrfToken: prompt.csrfToken,
      ownerCode: 'correct-owner-code',
      cookieValue: prompt.cookieValue,
      now: new Date('2026-07-16T01:02:10.000Z'),
    }),
    /invalid_request/,
  );

  const initial = await service.exchangeAuthorizationCode(new URLSearchParams({
    grant_type: 'authorization_code',
    code: approved.code,
    client_id: client.clientId,
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    code_verifier: verifier,
  }), new Date('2026-07-16T01:03:00.000Z'));
  assert.ok(initial.access_token.startsWith('pgh_at_'));
  assert.ok(initial.refresh_token.startsWith('pgh_rt_'));

  await service.authenticate(
    `Bearer ${initial.access_token}`,
    'github.read',
    new Date('2026-07-16T01:04:00.000Z'),
  );
  await assert.rejects(
    service.authenticate(
      `Bearer ${initial.access_token}`,
      'github.write',
      new Date('2026-07-16T01:04:00.000Z'),
    ),
    /insufficient_scope/,
  );
  await assert.rejects(
    service.exchangeAuthorizationCode(new URLSearchParams({
      grant_type: 'authorization_code',
      code: approved.code,
      client_id: client.clientId,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      code_verifier: verifier,
    }), new Date('2026-07-16T01:04:00.000Z')),
    /invalid_grant/,
  );

  const refreshForm = () => new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: initial.refresh_token,
    client_id: client.clientId,
  });
  const race = await Promise.allSettled([
    service.exchangeRefreshToken(refreshForm(), new Date('2026-07-16T01:05:00.000Z')),
    service.exchangeRefreshToken(refreshForm(), new Date('2026-07-16T01:05:00.000Z')),
  ]);
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(race.filter((result) => result.status === 'rejected').length, 1);
  const rotated = race.find((result) => result.status === 'fulfilled').value;
  assert.notEqual(rotated.refresh_token, initial.refresh_token);

  const restartedStore = new DurableOAuthStore(storePath);
  await restartedStore.initialize();
  const restartedService = new McpOAuthService({
    issuer: 'https://auth.example.test',
    resource: 'https://mcp.example.test/mcp',
    store: restartedStore,
    secretBox: new SecretBox(key),
    cookieCodec: new SessionCookieCodec(key),
    ownerCode: 'correct-owner-code',
    defaultClientId: 'chatgpt-purr-git',
    allowedRedirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    subject: 'operator-1',
    accessTtlMs: 60 * 60 * 1_000,
    refreshTtlMs: 30 * 24 * 60 * 60 * 1_000,
  });
  const persistedGrant = await restartedService.authenticate(
    `Bearer ${rotated.access_token}`,
    'github.read',
    new Date('2026-07-16T01:06:00.000Z'),
  );
  assert.equal(persistedGrant.subject, 'operator-1');

  const rawStore = await readFile(storePath, 'utf8');
  for (const sensitive of [
    approved.code,
    initial.access_token,
    initial.refresh_token,
    rotated.access_token,
    rotated.refresh_token,
    'correct-owner-code',
  ]) {
    assert.equal(rawStore.includes(sensitive), false, `plaintext secret leaked to OAuth store: ${sensitive.slice(0, 8)}`);
  }
  if (process.platform !== 'win32') {
    const mode = (await stat(storePath)).mode & 0o777;
    assert.equal(mode, 0o600);
  }

  const httpServer = createServer(async (req, res) => {
    if (req.url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/json' });
      res.end();
      return;
    }
    if (req.url === '/large') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ payload: 'x'.repeat(4_096) }));
      return;
    }
    if (req.url === '/slow') {
      await new Promise((resolve) => setTimeout(resolve, 300));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  try {
    const address = httpServer.address();
    const base = `http://127.0.0.1:${address.port}`;
    const clientHttp = new SafeJsonHttpClient({ timeoutMs: 100, maxResponseBytes: 1_024 });
    assert.deepEqual(await clientHttp.requestJson({ url: `${base}/json`, label: 'json' }), { ok: true });
    await assert.rejects(clientHttp.requestJson({ url: `${base}/redirect`, label: 'redirect' }), /outbound_redirect_rejected/);
    await assert.rejects(clientHttp.requestJson({ url: `${base}/large`, label: 'large' }), /outbound_response_too_large/);
    await assert.rejects(clientHttp.requestJson({ url: `${base}/slow`, label: 'slow' }), /outbound_timeout/);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }

  console.log('OAuth tests passed: PKCE, durable CAS, refresh rotation, scope hierarchy, encrypted persistence, safe HTTP client.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
