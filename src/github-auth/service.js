import { createHash, randomBytes } from 'node:crypto';

const GITHUB_AUTH_REQUEST_TTL_MS = 10 * 60 * 1_000;
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1_000;
const REFRESH_LEASE_MS = 30 * 1_000;
const REFRESH_WAIT_TIMEOUT_MS = 10 * 1_000;
const REFRESH_POLL_MS = 25;

function iso(date) {
  return date.toISOString();
}

function plus(date, milliseconds) {
  return new Date(date.valueOf() + milliseconds).toISOString();
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function text(value, field, maximum = 1_000) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} is invalid`);
  return value;
}

function validCredentialRef(value) {
  if (typeof value !== 'string' || !/^ghc_[A-Za-z0-9_-]{24,128}$/.test(value)) {
    throw new Error('github_credential_invalid');
  }
  return value;
}

function credentialContext(reference) {
  return `github-credential:${reference}`;
}

function boundSubject(userId, credentialRef) {
  return `github:${userId}:${credentialRef}`;
}

function credentialResult(credential) {
  return { token: credential.token, userId: credential.userId, login: credential.login };
}

function credentialIsFresh(credential, now) {
  return credential.expiresAt === undefined
    || new Date(credential.expiresAt).valueOf() > now.valueOf() + TOKEN_REFRESH_SKEW_MS;
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class GitHubAuthService {
  #store;
  #box;
  #provider;
  #ownerCode;

  constructor(options) {
    this.#store = options.store;
    this.#box = options.secretBox;
    this.#provider = options.provider;
    this.#ownerCode = text(options.ownerCode, 'Internal OAuth approval code', 1_000);
    if (!this.#store || !this.#box || !this.#provider) {
      throw new Error('GitHub auth service dependencies are required');
    }
  }

  get configured() {
    return this.#provider.configured === true;
  }

  async beginAuthorization(options, now = new Date()) {
    if (!this.configured) throw new Error('github_oauth_setup_required');
    const mcpRequestId = text(options?.mcpRequestId, 'MCP authorization request ID', 500);
    const csrfToken = text(options?.csrfToken, 'MCP CSRF token', 500);
    const rawState = `pgh_gh_${randomBytes(32).toString('base64url')}`;
    const stateId = sha256(rawState);
    const request = {
      stateId,
      mcpRequestId,
      csrfToken,
      createdAt: iso(now),
      expiresAt: plus(now, GITHUB_AUTH_REQUEST_TTL_MS),
    };
    const created = await this.#store.compareAndSetRecord({
      kind: 'github-auth-request',
      id: stateId,
      expectedRevision: null,
      value: request,
      updatedAt: iso(now),
    });
    if (created === undefined) throw new Error('server_error');
    return {
      authorizationUrl: await this.#provider.authorizationUrl({ state: rawState }),
      state: rawState,
    };
  }

  async #request(rawState, now) {
    const state = text(rawState, 'GitHub OAuth state', 500);
    const stateId = sha256(state);
    const record = await this.#store.getRecord('github-auth-request', stateId);
    if (
      record === undefined
      || record.value.consumedAt !== undefined
      || now.valueOf() >= new Date(record.value.expiresAt).valueOf()
    ) {
      throw new Error('invalid_request');
    }
    return { state, stateId, record, request: record.value };
  }

  async completeAuthorization(options) {
    const now = options.now ?? new Date();
    const pending = await this.#request(options.state, now);
    const exchanged = await this.#provider.exchange({
      code: text(options.code, 'GitHub authorization code', 1_000),
      state: pending.state,
    });
    const credentialRef = `ghc_${randomBytes(24).toString('base64url')}`;
    const credential = {
      credentialRef,
      userId: exchanged.user.id,
      login: exchanged.user.login,
      ...(exchanged.user.name ? { name: exchanged.user.name } : {}),
      ...(exchanged.user.htmlUrl ? { htmlUrl: exchanged.user.htmlUrl } : {}),
      token: exchanged.authentication.token,
      ...(exchanged.authentication.refreshToken
        ? { refreshToken: exchanged.authentication.refreshToken }
        : {}),
      ...(exchanged.authentication.expiresAt
        ? { expiresAt: exchanged.authentication.expiresAt }
        : {}),
      ...(exchanged.authentication.refreshTokenExpiresAt
        ? { refreshTokenExpiresAt: exchanged.authentication.refreshTokenExpiresAt }
        : {}),
      status: 'active',
      createdAt: iso(now),
      updatedAt: iso(now),
    };
    const result = await options.mcpService.confirmAuthorization({
      requestId: pending.request.mcpRequestId,
      decision: 'approve',
      csrfToken: pending.request.csrfToken,
      ownerCode: this.#ownerCode,
      cookieValue: options.cookieValue,
      now,
    });
    const codeId = sha256(result.code);
    const codeRecord = await this.#store.getRecord('mcp-auth-code', codeId);
    if (codeRecord === undefined || codeRecord.value.consumedAt !== undefined) {
      throw new Error('invalid_request');
    }
    const committed = await this.#store.compareAndSetRecords([
      {
        kind: 'github-auth-request',
        id: pending.stateId,
        expectedRevision: pending.record.revision,
        value: { ...pending.request, consumedAt: iso(now) },
        updatedAt: iso(now),
      },
      {
        kind: 'github-credential',
        id: credentialRef,
        expectedRevision: null,
        value: {
          userId: exchanged.user.id,
          login: exchanged.user.login,
          status: 'active',
          encryptedCredential: this.#box.encryptJson(
            credential,
            credentialContext(credentialRef),
          ),
        },
        updatedAt: iso(now),
      },
      {
        kind: 'mcp-auth-code',
        id: codeId,
        expectedRevision: codeRecord.revision,
        value: {
          ...codeRecord.value,
          subject: boundSubject(exchanged.user.id, credentialRef),
        },
        updatedAt: iso(now),
      },
    ]);
    if (committed === undefined) throw new Error('invalid_request');
    return result;
  }

  async rejectAuthorization(options) {
    const now = options.now ?? new Date();
    const pending = await this.#request(options.state, now);
    const result = await options.mcpService.confirmAuthorization({
      requestId: pending.request.mcpRequestId,
      decision: 'deny',
      csrfToken: pending.request.csrfToken,
      ownerCode: '',
      cookieValue: options.cookieValue,
      now,
    });
    const consumed = await this.#store.compareAndSetRecord({
      kind: 'github-auth-request',
      id: pending.stateId,
      expectedRevision: pending.record.revision,
      value: { ...pending.request, consumedAt: iso(now), providerError: 'access_denied' },
      updatedAt: iso(now),
    });
    if (consumed === undefined) throw new Error('invalid_request');
    return result;
  }

  async getCredential(reference) {
    const credentialRef = validCredentialRef(reference);
    const record = await this.#store.getRecord('github-credential', credentialRef);
    if (record === undefined) throw new Error('github_credential_invalid');
    const credential = this.#box.decryptJson(
      record.value.encryptedCredential,
      credentialContext(credentialRef),
    );
    if (credential.credentialRef !== credentialRef || credential.status !== 'active') {
      throw new Error('github_credential_revoked');
    }
    return { record, credential };
  }

  async #acquireRefreshLease(reference) {
    const deadline = Date.now() + REFRESH_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const leaseNow = new Date();
      const current = await this.#store.getRecord('github-refresh-lease', reference);
      const available = current === undefined
        || current.value.releasedAt !== undefined
        || leaseNow.valueOf() >= new Date(current.value.expiresAt).valueOf();
      if (available) {
        const holder = randomBytes(18).toString('base64url');
        const acquired = await this.#store.compareAndSetRecord({
          kind: 'github-refresh-lease',
          id: reference,
          expectedRevision: current?.revision ?? null,
          value: {
            holder,
            acquiredAt: iso(leaseNow),
            expiresAt: plus(leaseNow, REFRESH_LEASE_MS),
          },
          updatedAt: iso(leaseNow),
        });
        if (acquired !== undefined) return acquired;
      }
      await sleep(REFRESH_POLL_MS);
      const latest = await this.getCredential(reference);
      if (credentialIsFresh(latest.credential, new Date())) {
        return { refreshedCredential: latest.credential };
      }
    }
    throw new Error('github_refresh_in_progress');
  }

  async #releaseRefreshLease(lease, outcome, now = new Date()) {
    if (!lease?.revision) return;
    await this.#store.compareAndSetRecord({
      kind: 'github-refresh-lease',
      id: lease.id,
      expectedRevision: lease.revision,
      value: {
        ...lease.value,
        outcome,
        releasedAt: iso(now),
        expiresAt: iso(now),
      },
      updatedAt: iso(now),
    });
  }

  async resolveToken(reference, now = new Date()) {
    const initial = await this.getCredential(reference);
    if (credentialIsFresh(initial.credential, now)) return credentialResult(initial.credential);
    if (
      initial.credential.refreshToken === undefined
      || (initial.credential.refreshTokenExpiresAt
        && now.valueOf() >= new Date(initial.credential.refreshTokenExpiresAt).valueOf())
    ) {
      throw new Error('github_reauthorization_required');
    }

    const lease = await this.#acquireRefreshLease(initial.credential.credentialRef);
    if (lease.refreshedCredential) return credentialResult(lease.refreshedCredential);

    const current = await this.getCredential(initial.credential.credentialRef);
    if (credentialIsFresh(current.credential, now)) {
      await this.#releaseRefreshLease(lease, 'already_refreshed');
      return credentialResult(current.credential);
    }
    if (
      current.credential.refreshToken === undefined
      || (current.credential.refreshTokenExpiresAt
        && now.valueOf() >= new Date(current.credential.refreshTokenExpiresAt).valueOf())
    ) {
      await this.#releaseRefreshLease(lease, 'reauthorization_required');
      throw new Error('github_reauthorization_required');
    }

    let refreshed;
    try {
      refreshed = await this.#provider.refresh({ refreshToken: current.credential.refreshToken });
    } catch (error) {
      await this.#releaseRefreshLease(lease, 'provider_error');
      throw error;
    }
    const next = {
      ...current.credential,
      token: refreshed.token,
      refreshToken: refreshed.refreshToken ?? current.credential.refreshToken,
      ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
      ...(refreshed.refreshTokenExpiresAt
        ? { refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt }
        : {}),
      updatedAt: iso(now),
    };
    const updated = await this.#store.compareAndSetRecords([
      {
        kind: 'github-credential',
        id: current.credential.credentialRef,
        expectedRevision: current.record.revision,
        value: {
          ...current.record.value,
          encryptedCredential: this.#box.encryptJson(
            next,
            credentialContext(current.credential.credentialRef),
          ),
        },
        updatedAt: iso(now),
      },
      {
        kind: 'github-refresh-lease',
        id: lease.id,
        expectedRevision: lease.revision,
        value: {
          ...lease.value,
          outcome: 'refreshed',
          releasedAt: iso(now),
          expiresAt: iso(now),
        },
        updatedAt: iso(now),
      },
    ]);
    if (updated === undefined) {
      const latest = await this.getCredential(current.credential.credentialRef);
      if (credentialIsFresh(latest.credential, now)) return credentialResult(latest.credential);
      throw new Error('github_refresh_conflict');
    }
    return credentialResult(next);
  }

  async #markCredentialRevoked(record, reason, now) {
    if (record.value.status !== 'active') return false;
    const credential = this.#box.decryptJson(
      record.value.encryptedCredential,
      credentialContext(record.id),
    );
    if (credential.status !== 'active') return false;
    const revoked = {
      ...credential,
      status: 'revoked',
      revokedReason: reason,
      revokedAt: iso(now),
      updatedAt: iso(now),
    };
    const updated = await this.#store.compareAndSetRecord({
      kind: 'github-credential',
      id: record.id,
      expectedRevision: record.revision,
      value: {
        ...record.value,
        status: 'revoked',
        encryptedCredential: this.#box.encryptJson(revoked, credentialContext(record.id)),
      },
      updatedAt: iso(now),
    });
    return updated !== undefined;
  }

  async revokeCredential(reference, now = new Date()) {
    const { record, credential } = await this.getCredential(reference);
    try {
      await this.#provider.revoke({ token: credential.token });
    } finally {
      await this.#markCredentialRevoked(record, 'local_revocation', now);
    }
  }

  async revokeByUserId(userId, reason = 'github_app_authorization.revoked', now = new Date()) {
    const target = positiveInteger(userId, 'GitHub user ID');
    const records = await this.#store.listRecords('github-credential');
    let revoked = 0;
    for (const record of records) {
      if (record.value.userId !== target) continue;
      if (await this.#markCredentialRevoked(record, reason, now)) revoked += 1;
    }
    return revoked;
  }

  async recordInstallationLifecycle(event, now = new Date()) {
    const installationId = positiveInteger(event?.installationId, 'GitHub installation ID');
    const action = text(event?.action, 'GitHub installation action', 100);
    const current = await this.#store.getRecord('github-installation-lifecycle', String(installationId));
    const value = {
      installationId,
      action,
      eventName: text(event?.eventName, 'GitHub event name', 100),
      ...(Number.isSafeInteger(event?.accountId) && event.accountId > 0
        ? { accountId: event.accountId }
        : {}),
      ...(typeof event?.accountLogin === 'string' && event.accountLogin.length <= 200
        ? { accountLogin: event.accountLogin }
        : {}),
      updatedAt: iso(now),
    };
    return this.#store.compareAndSetRecord({
      kind: 'github-installation-lifecycle',
      id: String(installationId),
      expectedRevision: current?.revision ?? null,
      value,
      updatedAt: iso(now),
    });
  }
}
