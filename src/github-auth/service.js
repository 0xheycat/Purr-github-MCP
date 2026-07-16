import { createHash, randomBytes } from 'node:crypto';

const GITHUB_AUTH_REQUEST_TTL_MS = 10 * 60 * 1_000;
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1_000;

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

  async resolveToken(reference, now = new Date()) {
    const { record, credential } = await this.getCredential(reference);
    if (
      credential.expiresAt === undefined
      || new Date(credential.expiresAt).valueOf() > now.valueOf() + TOKEN_REFRESH_SKEW_MS
    ) {
      return { token: credential.token, userId: credential.userId, login: credential.login };
    }
    if (
      credential.refreshToken === undefined
      || (credential.refreshTokenExpiresAt
        && now.valueOf() >= new Date(credential.refreshTokenExpiresAt).valueOf())
    ) {
      throw new Error('github_reauthorization_required');
    }
    const refreshed = await this.#provider.refresh({ refreshToken: credential.refreshToken });
    const next = {
      ...credential,
      token: refreshed.token,
      refreshToken: refreshed.refreshToken ?? credential.refreshToken,
      ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
      ...(refreshed.refreshTokenExpiresAt
        ? { refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt }
        : {}),
      updatedAt: iso(now),
    };
    const updated = await this.#store.compareAndSetRecord({
      kind: 'github-credential',
      id: credential.credentialRef,
      expectedRevision: record.revision,
      value: {
        ...record.value,
        encryptedCredential: this.#box.encryptJson(
          next,
          credentialContext(credential.credentialRef),
        ),
      },
      updatedAt: iso(now),
    });
    if (updated === undefined) {
      const latest = await this.getCredential(credential.credentialRef);
      return {
        token: latest.credential.token,
        userId: latest.credential.userId,
        login: latest.credential.login,
      };
    }
    return { token: next.token, userId: next.userId, login: next.login };
  }

  async revokeCredential(reference, now = new Date()) {
    const { record, credential } = await this.getCredential(reference);
    try {
      await this.#provider.revoke({ token: credential.token });
    } finally {
      const revoked = { ...credential, status: 'revoked', revokedAt: iso(now), updatedAt: iso(now) };
      await this.#store.compareAndSetRecord({
        kind: 'github-credential',
        id: credential.credentialRef,
        expectedRevision: record.revision,
        value: {
          ...record.value,
          status: 'revoked',
          encryptedCredential: this.#box.encryptJson(
            revoked,
            credentialContext(credential.credentialRef),
          ),
        },
        updatedAt: iso(now),
      });
    }
  }
}
