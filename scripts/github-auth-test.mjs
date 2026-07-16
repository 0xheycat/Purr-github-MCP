import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitHubBoundOAuthService } from '../src/github-auth/bound-service.js';
import { GitHubAuthService } from '../src/github-auth/service.js';
import { SecretBox, SessionCookieCodec } from '../src/oauth/crypto.js';
import { McpOAuthService, pkceS256 } from '../src/oauth/service.js';
import { DurableOAuthStore } from '../src/oauth/store.js';

class FakeGitHubProvider {
  configured = true;
  refreshCount = 0;
  revokeCount = 0;

  async authorizationUrl({ state }) {
    return `https://github.com/login/oauth/authorize?client_id=fake&state=${encodeURIComponent(state)}`;
  }

  async exchange({ code }) {
    const userId = code === 'provider-code-b' ? 2002 : 1001;
    const login = userId === 2002 ? 'user-b' : 'user-a';
    return {
      authentication: {
        token: `provider-access-${userId}`,
        refreshToken: `provider-refresh-${userId}`,
        expiresAt: '2026-07-16T02:00:00.000Z',
        refreshTokenExpiresAt: '2026-08-16T02:00:00.000Z',
      },
      user: { id: userId, login, htmlUrl: `https://github.com/${login}` },
    };
  }

  async refresh({ refreshToken }) {
    this.refreshCount += 1;
    const userId = refreshToken.endsWith('2002') ? 2002 : 1001;
    return {
      token: `provider-access-refreshed-${userId}`,
      refreshToken: `provider-refresh-rotated-${userId}`,
      expiresAt: '2026-07-16T10:00:00.000Z',
      refreshTokenExpiresAt: '2026-08-16T02:00:00.000Z',
    };
  }

  async revoke() {
    this.revokeCount += 1;
  }
}

const directory = await mkdtemp(join(tmpdir(), 'purr-github-user-auth-'));
const storePath = join(directory, 'oauth-store.json');

try {
  const key = randomBytes(32).toString('base64');
  const store = new DurableOAuthStore(storePath);
  await store.initialize();
  const secretBox = new SecretBox(key);
  const cookieCodec = new SessionCookieCodec(key);
  const provider = new FakeGitHubProvider();
  const internalOwnerCode = 'internal-github-approval';
  const base = new McpOAuthService({
    issuer: 'https://auth.example.test',
    resource: 'https://mcp.example.test/mcp',
    store,
    secretBox,
    cookieCodec,
    ownerCode: internalOwnerCode,
    defaultClientId: 'chatgpt-purr-git',
    allowedRedirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    subject: 'legacy-owner',
    accessTtlMs: 60 * 60 * 1_000,
    refreshTtlMs: 30 * 24 * 60 * 60 * 1_000,
  });
  const oauth = new GitHubBoundOAuthService(base);
  const github = new GitHubAuthService({
    store,
    secretBox,
    provider,
    ownerCode: internalOwnerCode,
  });

  const beginMcp = async (state, now) => {
    const verifier = state.padEnd(64, 'x').slice(0, 64);
    const prompt = await oauth.beginAuthorization(new URLSearchParams({
      response_type: 'code',
      client_id: 'chatgpt-purr-git',
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      code_challenge: pkceS256(verifier),
      code_challenge_method: 'S256',
      resource: oauth.resource,
      scope: 'github.admin',
      state,
    }), now);
    const providerFlow = await github.beginAuthorization({
      mcpRequestId: prompt.requestId,
      csrfToken: prompt.csrfToken,
    }, now);
    return { verifier, prompt, providerFlow };
  };

  const flowA = await beginMcp('chatgpt-state-a', new Date('2026-07-16T01:00:00.000Z'));
  assert.match(flowA.providerFlow.authorizationUrl, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  const approvedA = await github.completeAuthorization({
    state: flowA.providerFlow.state,
    code: 'provider-code-a',
    cookieValue: flowA.prompt.cookieValue,
    mcpService: oauth,
    now: new Date('2026-07-16T01:01:00.000Z'),
  });
  assert.equal(approvedA.state, 'chatgpt-state-a');

  await assert.rejects(github.completeAuthorization({
    state: flowA.providerFlow.state,
    code: 'provider-code-a',
    cookieValue: flowA.prompt.cookieValue,
    mcpService: oauth,
    now: new Date('2026-07-16T01:01:10.000Z'),
  }), /invalid_request/);

  const tokenA = await oauth.exchangeAuthorizationCode(new URLSearchParams({
    grant_type: 'authorization_code',
    code: approvedA.code,
    client_id: 'chatgpt-purr-git',
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    code_verifier: flowA.verifier,
  }), new Date('2026-07-16T01:02:00.000Z'));
  const grantA = await oauth.authenticate(
    `Bearer ${tokenA.access_token}`,
    'github.admin',
    new Date('2026-07-16T01:03:00.000Z'),
  );
  assert.equal(grantA.subject, 'github:1001');
  assert.equal(grantA.githubUserId, 1001);
  assert.match(grantA.githubCredentialRef, /^ghc_/);
  const credentialA = await github.getCredential(grantA.githubCredentialRef);
  assert.equal(credentialA.credential.login, 'user-a');
  assert.equal(credentialA.credential.token, 'provider-access-1001');

  const flowB = await beginMcp('chatgpt-state-b', new Date('2026-07-16T01:10:00.000Z'));
  const approvedB = await github.completeAuthorization({
    state: flowB.providerFlow.state,
    code: 'provider-code-b',
    cookieValue: flowB.prompt.cookieValue,
    mcpService: oauth,
    now: new Date('2026-07-16T01:11:00.000Z'),
  });
  const tokenB = await oauth.exchangeAuthorizationCode(new URLSearchParams({
    grant_type: 'authorization_code',
    code: approvedB.code,
    client_id: 'chatgpt-purr-git',
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    code_verifier: flowB.verifier,
  }), new Date('2026-07-16T01:12:00.000Z'));
  const grantB = await oauth.authenticate(
    `Bearer ${tokenB.access_token}`,
    'github.admin',
    new Date('2026-07-16T01:13:00.000Z'),
  );
  assert.equal(grantB.subject, 'github:2002');
  assert.notEqual(grantB.githubCredentialRef, grantA.githubCredentialRef);
  assert.equal((await github.getCredential(grantB.githubCredentialRef)).credential.login, 'user-b');

  const refreshed = await github.resolveToken(
    grantA.githubCredentialRef,
    new Date('2026-07-16T02:10:00.000Z'),
  );
  assert.equal(refreshed.token, 'provider-access-refreshed-1001');
  assert.equal(provider.refreshCount, 1);
  assert.equal((await github.getCredential(grantA.githubCredentialRef)).credential.refreshToken, 'provider-refresh-rotated-1001');

  const deniedFlow = await beginMcp('chatgpt-state-denied', new Date('2026-07-16T03:00:00.000Z'));
  const denied = await github.rejectAuthorization({
    state: deniedFlow.providerFlow.state,
    cookieValue: deniedFlow.prompt.cookieValue,
    mcpService: oauth,
    now: new Date('2026-07-16T03:01:00.000Z'),
  });
  assert.equal(denied.error, 'access_denied');

  const rawStore = await readFile(storePath, 'utf8');
  for (const secret of [
    flowA.providerFlow.state,
    flowB.providerFlow.state,
    'provider-access-1001',
    'provider-refresh-1001',
    'provider-access-2002',
    'provider-refresh-2002',
    'provider-access-refreshed-1001',
    'provider-refresh-rotated-1001',
    approvedA.code,
    approvedB.code,
    tokenA.access_token,
    tokenA.refresh_token,
    tokenB.access_token,
    tokenB.refresh_token,
    internalOwnerCode,
  ]) {
    assert.equal(rawStore.includes(secret), false, `plaintext auth material leaked: ${secret.slice(0, 16)}`);
  }

  console.log('GitHub App user-auth tests passed: callback binding, replay rejection, encrypted credentials, user isolation, and refresh persistence.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
