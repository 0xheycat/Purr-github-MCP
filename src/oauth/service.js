import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { normalizeRequestedScopes, scopeAllows } from './scopes.js';

const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1_000;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1_000;

function iso(date) {
  return date.toISOString();
}

function plus(date, milliseconds) {
  return new Date(date.valueOf() + milliseconds).toISOString();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function pkceS256(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function exactOrigin(value) {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new Error('OAuth issuer must be a credential-free HTTP(S) origin');
  }
  if (
    parsed.protocol === 'http:'
    && parsed.hostname !== '127.0.0.1'
    && parsed.hostname !== 'localhost'
    && parsed.hostname !== '[::1]'
  ) {
    throw new Error('OAuth issuer may use HTTP only on loopback');
  }
  return parsed.toString().replace(/\/$/, '');
}

function exactResource(value) {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.hash !== ''
  ) {
    throw new Error('OAuth resource is invalid');
  }
  if (
    parsed.protocol === 'http:'
    && parsed.hostname !== '127.0.0.1'
    && parsed.hostname !== 'localhost'
    && parsed.hostname !== '[::1]'
  ) {
    throw new Error('OAuth resource may use HTTP only on loopback');
  }
  return parsed.toString();
}

function redirectUri(value) {
  if (typeof value !== 'string' || value.length > 2_000) throw new Error('redirect_uri is invalid');
  const parsed = new URL(value);
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.hash !== ''
  ) {
    throw new Error('redirect_uri is invalid');
  }
  if (
    parsed.protocol === 'http:'
    && parsed.hostname !== '127.0.0.1'
    && parsed.hostname !== 'localhost'
    && parsed.hostname !== '[::1]'
  ) {
    throw new Error('redirect_uri may use HTTP only on loopback');
  }
  return parsed.toString();
}

function validChallenge(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(value)) {
    throw new Error('code_challenge is invalid');
  }
  return value;
}

function validVerifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(value)) {
    throw new Error('code_verifier is invalid');
  }
  return value;
}

function text(value, field, maximum = 500) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function optionalText(value, field, maximum = 2_000) {
  return value === undefined || value === null || value === '' ? undefined : text(value, field, maximum);
}

function tokenResponse(accessToken, refreshToken, grant, now) {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: Math.max(1, Math.floor((new Date(grant.expiresAt).valueOf() - now.valueOf()) / 1_000)),
    scope: grant.scopes.join(' '),
  };
}

export class McpOAuthService {
  #issuer;
  #resource;
  #store;
  #box;
  #cookies;
  #ownerCode;
  #defaultClientId;
  #allowedRedirectUris;
  #subject;
  #accessTtlMs;
  #refreshTtlMs;

  constructor(options) {
    this.#issuer = exactOrigin(options.issuer);
    this.#resource = exactResource(options.resource);
    this.#store = options.store;
    this.#box = options.secretBox;
    this.#cookies = options.cookieCodec;
    this.#ownerCode = String(options.ownerCode ?? '');
    if (this.#ownerCode.length > 1_000) throw new Error('OAuth owner code is invalid');
    this.#defaultClientId = text(options.defaultClientId, 'OAuth default client ID', 300);
    this.#allowedRedirectUris = Object.freeze((options.allowedRedirectUris ?? []).map(redirectUri));
    this.#subject = text(options.subject ?? '0xheycat', 'OAuth subject', 300);
    this.#accessTtlMs = options.accessTtlMs;
    this.#refreshTtlMs = options.refreshTtlMs;
    if (!Number.isInteger(this.#accessTtlMs) || this.#accessTtlMs < 60_000) {
      throw new Error('OAuth access-token TTL is invalid');
    }
    if (!Number.isInteger(this.#refreshTtlMs) || this.#refreshTtlMs < this.#accessTtlMs) {
      throw new Error('OAuth refresh-token TTL is invalid');
    }
  }

  get issuer() {
    return this.#issuer;
  }

  get resource() {
    return this.#resource;
  }

  get configured() {
    return this.#ownerCode.length > 0;
  }

  async registerClient(input, now = new Date()) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('invalid_client_metadata');
    }
    const rawRedirectUris = input.redirect_uris;
    if (!Array.isArray(rawRedirectUris) || rawRedirectUris.length === 0 || rawRedirectUris.length > 10) {
      throw new Error('invalid_redirect_uri');
    }
    const method = input.token_endpoint_auth_method ?? 'none';
    if (method !== 'none') throw new Error('invalid_client_metadata');
    const clientId = `pgh_${randomBytes(18).toString('base64url')}`;
    const client = {
      clientId,
      clientName: optionalText(input.client_name, 'client_name', 200) ?? 'MCP client',
      redirectUris: [...new Set(rawRedirectUris.map(redirectUri))],
      tokenEndpointAuthMethod: 'none',
      createdAt: iso(now),
    };
    const created = await this.#store.compareAndSetRecord({
      kind: 'mcp-client',
      id: clientId,
      expectedRevision: null,
      value: client,
      updatedAt: iso(now),
    });
    if (created === undefined) throw new Error('invalid_client_metadata');
    return client;
  }

  async #client(clientId) {
    if (clientId === this.#defaultClientId) {
      return {
        clientId,
        clientName: 'ChatGPT',
        redirectUris: this.#allowedRedirectUris,
        tokenEndpointAuthMethod: 'none',
      };
    }
    const record = await this.#store.getRecord('mcp-client', clientId);
    return record?.value;
  }

  #staticRedirectAllowed(uri) {
    if (this.#allowedRedirectUris.length > 0) return this.#allowedRedirectUris.includes(uri);
    return uri.startsWith('https://chatgpt.com/connector/oauth/')
      || uri === 'https://chatgpt.com/connector_platform_oauth_redirect';
  }

  async beginAuthorization(query, now = new Date()) {
    if (query.get('response_type') !== 'code') throw new Error('unsupported_response_type');
    const clientId = text(query.get('client_id'), 'client_id', 300);
    const client = await this.#client(clientId);
    if (client === undefined) throw new Error('invalid_client');
    const exactRedirect = redirectUri(query.get('redirect_uri'));
    const allowed = clientId === this.#defaultClientId
      ? this.#staticRedirectAllowed(exactRedirect)
      : client.redirectUris.includes(exactRedirect);
    if (!allowed) throw new Error('invalid_redirect_uri');
    if (query.get('code_challenge_method') !== 'S256') throw new Error('invalid_request');
    const resource = exactResource(query.get('resource') ?? this.#resource);
    if (resource !== this.#resource) throw new Error('invalid_target');
    const requestId = randomBytes(24).toString('base64url');
    const csrfToken = randomBytes(24).toString('base64url');
    const expiresAt = plus(now, AUTHORIZATION_REQUEST_TTL_MS);
    const record = {
      requestId,
      clientId,
      clientName: client.clientName,
      redirectUri: exactRedirect,
      scopes: normalizeRequestedScopes(query.get('scope')),
      codeChallenge: validChallenge(query.get('code_challenge')),
      resource,
      csrfToken,
      createdAt: iso(now),
      expiresAt,
      ...(query.get('state') === null ? {} : { state: optionalText(query.get('state'), 'state', 2_000) }),
    };
    const created = await this.#store.compareAndSetRecord({
      kind: 'mcp-auth-request',
      id: requestId,
      expectedRevision: null,
      value: record,
      updatedAt: iso(now),
    });
    if (created === undefined) throw new Error('server_error');
    return {
      requestId,
      clientName: client.clientName,
      redirectUri: exactRedirect,
      scopes: record.scopes,
      csrfToken,
      cookieValue: this.#cookies.encode({ requestId, expiresAt }),
    };
  }

  async confirmAuthorization(options) {
    const now = options.now ?? new Date();
    const signed = this.#cookies.decode(options.cookieValue, now);
    if (signed.requestId !== options.requestId) throw new Error('invalid_request');
    const requestRecord = await this.#store.getRecord('mcp-auth-request', options.requestId);
    if (requestRecord === undefined) throw new Error('invalid_request');
    const request = requestRecord.value;
    if (request.consumedAt !== undefined || now.valueOf() >= new Date(request.expiresAt).valueOf()) {
      throw new Error('invalid_request');
    }
    if (!secureEqual(options.csrfToken, request.csrfToken)) throw new Error('invalid_request');
    if (options.decision === 'deny') {
      const consumed = await this.#store.compareAndSetRecord({
        kind: 'mcp-auth-request',
        id: request.requestId,
        expectedRevision: requestRecord.revision,
        value: { ...request, consumedAt: iso(now) },
        updatedAt: iso(now),
      });
      if (consumed === undefined) throw new Error('invalid_request');
      return {
        redirectUri: request.redirectUri,
        error: 'access_denied',
        ...(request.state === undefined ? {} : { state: request.state }),
      };
    }
    if (options.decision !== 'approve') throw new Error('invalid_request');
    if (!this.configured) throw new Error('oauth_setup_required');
    if (!secureEqual(options.ownerCode, this.#ownerCode)) throw new Error('access_denied');
    const rawCode = randomBytes(32).toString('base64url');
    const codeId = sha256(rawCode);
    const code = {
      codeId,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      scopes: request.scopes,
      codeChallenge: request.codeChallenge,
      resource: request.resource,
      subject: this.#subject,
      createdAt: iso(now),
      expiresAt: plus(now, AUTHORIZATION_CODE_TTL_MS),
    };
    const created = await this.#store.compareAndSetRecords([
      {
        kind: 'mcp-auth-request',
        id: request.requestId,
        expectedRevision: requestRecord.revision,
        value: { ...request, consumedAt: iso(now) },
        updatedAt: iso(now),
      },
      {
        kind: 'mcp-auth-code',
        id: codeId,
        expectedRevision: null,
        value: code,
        updatedAt: iso(now),
      },
    ]);
    if (created === undefined) throw new Error('invalid_request');
    return {
      redirectUri: request.redirectUri,
      code: rawCode,
      ...(request.state === undefined ? {} : { state: request.state }),
    };
  }

  async exchangeAuthorizationCode(form, now = new Date()) {
    if (form.get('grant_type') !== 'authorization_code') throw new Error('unsupported_grant_type');
    const rawCode = text(form.get('code'), 'code', 500);
    const codeId = sha256(rawCode);
    const codeRecord = await this.#store.getRecord('mcp-auth-code', codeId);
    if (codeRecord === undefined) throw new Error('invalid_grant');
    const code = codeRecord.value;
    if (code.consumedAt !== undefined || now.valueOf() >= new Date(code.expiresAt).valueOf()) {
      throw new Error('invalid_grant');
    }
    if (
      form.get('client_id') !== code.clientId
      || redirectUri(form.get('redirect_uri')) !== code.redirectUri
      || !secureEqual(pkceS256(validVerifier(form.get('code_verifier'))), code.codeChallenge)
    ) {
      throw new Error('invalid_grant');
    }
    const rawAccess = `pgh_at_${randomBytes(32).toString('base64url')}`;
    const accessId = sha256(rawAccess);
    const rawRefresh = `pgh_rt_${randomBytes(32).toString('base64url')}`;
    const refreshId = sha256(rawRefresh);
    const access = {
      grantId: accessId,
      clientId: code.clientId,
      scopes: code.scopes,
      resource: code.resource,
      subject: code.subject,
      createdAt: iso(now),
      expiresAt: plus(now, this.#accessTtlMs),
    };
    const refresh = {
      grantId: refreshId,
      clientId: code.clientId,
      scopes: code.scopes,
      resource: code.resource,
      subject: code.subject,
      createdAt: iso(now),
      expiresAt: plus(now, this.#refreshTtlMs),
    };
    const created = await this.#store.compareAndSetRecords([
      {
        kind: 'mcp-auth-code',
        id: codeId,
        expectedRevision: codeRecord.revision,
        value: { ...code, consumedAt: iso(now) },
        updatedAt: iso(now),
      },
      {
        kind: 'mcp-access-token',
        id: accessId,
        expectedRevision: null,
        value: { encryptedGrant: this.#box.encryptJson(access, `mcp-access-token:${accessId}`) },
        updatedAt: iso(now),
      },
      {
        kind: 'mcp-refresh-token',
        id: refreshId,
        expectedRevision: null,
        value: { encryptedGrant: this.#box.encryptJson(refresh, `mcp-refresh-token:${refreshId}`) },
        updatedAt: iso(now),
      },
    ]);
    if (created === undefined) throw new Error('invalid_grant');
    return tokenResponse(rawAccess, rawRefresh, access, now);
  }

  async exchangeRefreshToken(form, now = new Date()) {
    if (form.get('grant_type') !== 'refresh_token') throw new Error('unsupported_grant_type');
    const rawRefresh = text(form.get('refresh_token'), 'refresh_token', 500);
    const refreshId = sha256(rawRefresh);
    const refreshRecord = await this.#store.getRecord('mcp-refresh-token', refreshId);
    if (refreshRecord === undefined) throw new Error('invalid_grant');
    const refresh = this.#box.decryptJson(
      refreshRecord.value.encryptedGrant,
      `mcp-refresh-token:${refreshId}`,
    );
    if (
      refresh.consumedAt !== undefined
      || refresh.revokedAt !== undefined
      || refresh.resource !== this.#resource
      || form.get('client_id') !== refresh.clientId
      || now.valueOf() >= new Date(refresh.expiresAt).valueOf()
    ) {
      throw new Error('invalid_grant');
    }
    const rawAccess = `pgh_at_${randomBytes(32).toString('base64url')}`;
    const accessId = sha256(rawAccess);
    const nextRawRefresh = `pgh_rt_${randomBytes(32).toString('base64url')}`;
    const nextRefreshId = sha256(nextRawRefresh);
    const access = {
      grantId: accessId,
      clientId: refresh.clientId,
      scopes: refresh.scopes,
      resource: refresh.resource,
      subject: refresh.subject,
      createdAt: iso(now),
      expiresAt: plus(now, this.#accessTtlMs),
    };
    const nextRefresh = {
      grantId: nextRefreshId,
      clientId: refresh.clientId,
      scopes: refresh.scopes,
      resource: refresh.resource,
      subject: refresh.subject,
      createdAt: iso(now),
      expiresAt: refresh.expiresAt,
    };
    const rotated = await this.#store.compareAndSetRecords([
      {
        kind: 'mcp-refresh-token',
        id: refreshId,
        expectedRevision: refreshRecord.revision,
        value: {
          encryptedGrant: this.#box.encryptJson(
            { ...refresh, consumedAt: iso(now) },
            `mcp-refresh-token:${refreshId}`,
          ),
        },
        updatedAt: iso(now),
      },
      {
        kind: 'mcp-access-token',
        id: accessId,
        expectedRevision: null,
        value: { encryptedGrant: this.#box.encryptJson(access, `mcp-access-token:${accessId}`) },
        updatedAt: iso(now),
      },
      {
        kind: 'mcp-refresh-token',
        id: nextRefreshId,
        expectedRevision: null,
        value: {
          encryptedGrant: this.#box.encryptJson(
            nextRefresh,
            `mcp-refresh-token:${nextRefreshId}`,
          ),
        },
        updatedAt: iso(now),
      },
    ]);
    if (rotated === undefined) throw new Error('invalid_grant');
    return tokenResponse(rawAccess, nextRawRefresh, access, now);
  }

  async authenticate(authorization, requiredScope, now = new Date()) {
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization ?? '');
    if (match?.[1] === undefined) throw new Error('invalid_token');
    const accessId = sha256(match[1]);
    const record = await this.#store.getRecord('mcp-access-token', accessId);
    if (record === undefined) throw new Error('invalid_token');
    const grant = this.#box.decryptJson(
      record.value.encryptedGrant,
      `mcp-access-token:${accessId}`,
    );
    if (
      grant.revokedAt !== undefined
      || grant.resource !== this.#resource
      || now.valueOf() >= new Date(grant.expiresAt).valueOf()
      || (requiredScope !== undefined && !scopeAllows(grant.scopes, requiredScope))
    ) {
      throw new Error(requiredScope === undefined ? 'invalid_token' : 'insufficient_scope');
    }
    return grant;
  }

  async revoke(form, now = new Date()) {
    const raw = form.get('token');
    if (raw === null || raw.length > 500) return;
    const id = sha256(raw);
    for (const [kind, context] of [
      ['mcp-access-token', 'mcp-access-token'],
      ['mcp-refresh-token', 'mcp-refresh-token'],
    ]) {
      const record = await this.#store.getRecord(kind, id);
      if (record === undefined) continue;
      const grant = this.#box.decryptJson(record.value.encryptedGrant, `${context}:${id}`);
      if (grant.revokedAt !== undefined || grant.consumedAt !== undefined) return;
      await this.#store.compareAndSetRecord({
        kind,
        id,
        expectedRevision: record.revision,
        value: {
          encryptedGrant: this.#box.encryptJson(
            { ...grant, revokedAt: iso(now) },
            `${context}:${id}`,
          ),
        },
        updatedAt: iso(now),
      });
      return;
    }
  }
}
