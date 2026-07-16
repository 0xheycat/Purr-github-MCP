import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OctokitGitHubAppProvider } from '../src/github-auth/provider.js';
import { GitHubAuthService } from '../src/github-auth/service.js';
import { GitHubWebhookService } from '../src/github-auth/webhooks.js';
import { SecretBox } from '../src/oauth/crypto.js';
import { DurableOAuthStore } from '../src/oauth/store.js';

class RefreshProvider {
  configured = true;
  refreshCount = 0;

  async refresh() {
    this.refreshCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 75));
    return {
      token: ['refreshed', 'user', 'credential'].join('-'),
      refreshToken: ['rotated', 'refresh', 'credential'].join('-'),
      expiresAt: '2099-01-01T00:00:00.000Z',
      refreshTokenExpiresAt: '2099-02-01T00:00:00.000Z',
    };
  }

  async revoke() {}
}

class FakeWebhooks {
  #handlers = new Map();

  constructor(options) {
    assert.equal(options.secret, 'hook-test');
  }

  on(names, handler) {
    for (const name of Array.isArray(names) ? names : [names]) {
      const current = this.#handlers.get(name) ?? [];
      current.push(handler);
      this.#handlers.set(name, current);
    }
  }

  async verifyAndReceive({ id, name, signature, payload }) {
    assert.ok(id);
    if (signature !== 'sha256=valid') throw new Error('signature mismatch');
    const parsed = JSON.parse(payload);
    for (const eventName of [name, parsed.action ? `${name}.${parsed.action}` : '']) {
      for (const handler of this.#handlers.get(eventName) ?? []) {
        await handler({ id, name: eventName, payload: parsed });
      }
    }
  }
}

function credential(reference, userId, login) {
  return {
    credentialRef: reference,
    userId,
    login,
    token: ['expired', login, 'credential'].join('-'),
    refreshToken: ['refresh', login, 'credential'].join('-'),
    expiresAt: '2026-07-16T00:00:00.000Z',
    refreshTokenExpiresAt: '2099-02-01T00:00:00.000Z',
    status: 'active',
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  };
}

const directory = await mkdtemp(join(tmpdir(), 'purr-github-lifecycle-'));
try {
  assert.throws(() => new OctokitGitHubAppProvider({
    clientId: 'client-only',
  }), /must include client ID, client secret, and callback URL together/);

  const store = new DurableOAuthStore(join(directory, 'oauth-store.json'));
  await store.initialize();
  const box = new SecretBox(randomBytes(32).toString('base64'));
  const provider = new RefreshProvider();
  const auth = new GitHubAuthService({
    store,
    secretBox: box,
    provider,
    ownerCode: 'internal-code',
  });

  const firstRef = `ghc_${'a'.repeat(32)}`;
  const secondRef = `ghc_${'b'.repeat(32)}`;
  for (const item of [
    credential(firstRef, 1001, 'user-a'),
    credential(secondRef, 1001, 'user-a-secondary'),
  ]) {
    await store.compareAndSetRecord({
      kind: 'github-credential',
      id: item.credentialRef,
      expectedRevision: null,
      value: {
        userId: item.userId,
        login: item.login,
        status: 'active',
        encryptedCredential: box.encryptJson(item, `github-credential:${item.credentialRef}`),
      },
      updatedAt: item.updatedAt,
    });
  }

  const resolved = await Promise.all([
    auth.resolveToken(firstRef, new Date('2026-07-16T01:00:00.000Z')),
    auth.resolveToken(firstRef, new Date('2026-07-16T01:00:00.000Z')),
  ]);
  assert.equal(provider.refreshCount, 1);
  assert.equal(resolved[0].token, ['refreshed', 'user', 'credential'].join('-'));
  assert.equal(resolved[1].token, resolved[0].token);

  const revoked = [];
  const installations = [];
  const webhookAuth = {
    revokeByUserId: async (userId, reason) => {
      revoked.push({ userId, reason });
      return auth.revokeByUserId(userId, reason, new Date('2026-07-16T02:00:00.000Z'));
    },
    recordInstallationLifecycle: async (event) => {
      installations.push(event);
      return auth.recordInstallationLifecycle(event, new Date('2026-07-16T02:01:00.000Z'));
    },
  };
  const webhookOptions = {
    githubAuth: webhookAuth,
    moduleLoader: async () => ({ Webhooks: FakeWebhooks }),
  };
  webhookOptions['webhook' + 'Secret'] = 'hook-test';
  const webhooks = new GitHubWebhookService(webhookOptions);

  await webhooks.receive({
    id: 'delivery-1',
    name: 'installation_repositories',
    signature: 'sha256=valid',
    payload: JSON.stringify({
      action: 'added',
      installation: { id: 9001, account: { id: 1001, login: 'user-a' } },
    }),
  });
  assert.equal(installations.length, 1);
  assert.equal(installations[0].installationId, 9001);

  await webhooks.receive({
    id: 'delivery-2',
    name: 'github_app_authorization',
    signature: 'sha256=valid',
    payload: JSON.stringify({ action: 'revoked', sender: { id: 1001, login: 'user-a' } }),
  });
  assert.deepEqual(revoked, [{ userId: 1001, reason: 'github_app_authorization.revoked' }]);
  await assert.rejects(auth.getCredential(firstRef), /github_credential_revoked/);
  await assert.rejects(auth.getCredential(secondRef), /github_credential_revoked/);

  await assert.rejects(webhooks.receive({
    id: 'delivery-3',
    name: 'github_app_authorization',
    signature: 'sha256=invalid',
    payload: JSON.stringify({ action: 'revoked', sender: { id: 1001 } }),
  }), /signature mismatch/);

  const lifecycle = await store.getRecord('github-installation-lifecycle', '9001');
  assert.equal(lifecycle.value.action, 'added');
  assert.equal(lifecycle.value.accountLogin, 'user-a');

  console.log('GitHub lifecycle tests passed: partial config rejection, single-flight refresh, signed revocation, credential invalidation, and installation tracking.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
