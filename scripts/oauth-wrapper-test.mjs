import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url, child) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`OAuth wrapper exited early with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`readiness returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError ?? new Error('OAuth wrapper did not become ready');
}

function hidden(html, name) {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  if (!match) throw new Error(`hidden input ${name} missing`);
  return match[1];
}

async function rpc(base, bearer, body) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

const directory = await mkdtemp(join(tmpdir(), 'purr-oauth-wrapper-'));
const publicPort = await freePort();
const upstreamPort = await freePort();
const base = `http://127.0.0.1:${publicPort}`;
const callback = 'http://127.0.0.1:49152/callback';
const serverToken = ['fixture', 'server', 'token'].join('-');
const child = spawn(process.execPath, ['src/oauth-wrapper.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(publicPort),
    OAUTH_UPSTREAM_PORT: String(upstreamPort),
    OAUTH_UPSTREAM_ENTRY: 'scripts/oauth-upstream-fixture.mjs',
    AUTH_MODE: 'server_token',
    SERVER_TOKEN: serverToken,
    GITHUB_TOKEN: ['fixture', 'github', 'token'].join('-'),
    PUBLIC_BASE_URL: base,
    OAUTH_ISSUER: base,
    OAUTH_RESOURCE_URL: `${base}/mcp`,
    OAUTH_CLIENT_ID: 'chatgpt-purr-git',
    OAUTH_ALLOWED_REDIRECT_URIS: callback,
    OAUTH_OWNER_CODE: 'owner-code',
    OAUTH_SECRET_SOURCE: ['fixture', 'oauth', 'source'].join('-'),
    OAUTH_STORE_PATH: join(directory, 'oauth-store.json'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
child.stderr.on('data', (chunk) => { logs += chunk.toString(); });

try {
  await waitFor(`${base}/.well-known/oauth-authorization-server`, child);
  const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(metadata.grant_types_supported, ['authorization_code', 'refresh_token']);
  assert.equal(metadata.revocation_endpoint, `${base}/oauth/revoke`);

  const verifier = 'z'.repeat(64);
  const challenge = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const codeChallenge = Buffer.from(challenge).toString('base64url');
  const authorize = new URL(`${base}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: 'chatgpt-purr-git',
    redirect_uri: callback,
    scope: 'github.read',
    state: 'state-1',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    resource: `${base}/mcp`,
  }).toString();
  const authorizationPage = await fetch(authorize);
  assert.equal(authorizationPage.status, 200);
  assert.match(authorizationPage.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  const cookie = (authorizationPage.headers.get('set-cookie') ?? '').split(';', 1)[0];
  const html = await authorizationPage.text();
  assert.match(html, /id="approve-form"/);
  assert.match(html, /id="deny-form"/);

  const confirmation = await fetch(`${base}/oauth/authorize/confirm`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      request_id: hidden(html, 'request_id'),
      csrf_token: hidden(html, 'csrf_token'),
      decision: 'approve',
      owner_code: 'owner-code',
    }),
  });
  assert.equal(confirmation.status, 302);
  const redirected = new URL(confirmation.headers.get('location'));
  assert.equal(redirected.origin + redirected.pathname, callback);
  assert.equal(redirected.searchParams.get('state'), 'state-1');
  const code = redirected.searchParams.get('code');
  assert.ok(code);

  const tokenResponse = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: 'chatgpt-purr-git',
      redirect_uri: callback,
      code_verifier: verifier,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.ok(tokens.access_token.startsWith('pgh_at_'));
  assert.ok(tokens.refresh_token.startsWith('pgh_rt_'));

  const listed = await rpc(base, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.equal(listed.response.status, 200);
  assert.deepEqual(listed.payload.result.tools.map((tool) => tool.name), ['get_file']);
  assert.deepEqual(listed.payload.result.tools[0].securitySchemes, [{ type: 'oauth2', scopes: ['github.read'] }]);

  const readCall = await rpc(base, tokens.access_token, {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_file', arguments: {} },
  });
  assert.equal(readCall.response.status, 200);
  assert.equal(readCall.payload.result.content[0].type, 'text');

  const writeCall = await rpc(base, tokens.access_token, {
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'commit_files', arguments: {} },
  });
  assert.equal(writeCall.response.status, 403);
  assert.equal(writeCall.payload.error, 'insufficient_scope');
  assert.equal(writeCall.payload.required_scope, 'github.write');

  const legacy = await rpc(base, serverToken, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
  assert.equal(legacy.response.status, 200);
  assert.deepEqual(legacy.payload.result.tools.map((tool) => tool.name), [
    'get_file',
    'get_verification_plan',
    'commit_files',
    'merge_pull_request',
  ]);

  const refreshedResponse = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: 'chatgpt-purr-git',
    }),
  });
  assert.equal(refreshedResponse.status, 200);
  const refreshed = await refreshedResponse.json();
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token);

  const replay = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: 'chatgpt-purr-git',
    }),
  });
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, 'invalid_grant');

  console.log('OAuth wrapper integration passed: ChatGPT flow, filtered catalog, scoped dispatch, legacy SERVER_TOKEN compatibility.');
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(directory, { recursive: true, force: true });
  if (child.exitCode && child.exitCode !== 0) process.stderr.write(logs);
}
