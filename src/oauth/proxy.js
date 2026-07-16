import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';

import { SafeJsonHttpClient } from './outbound.js';
import {
  normalizeRequestedScopes,
  requiredScopeForTool,
  scopeAllows,
  securitySchemesForTool,
} from './scopes.js';
import {
  authIssuer,
  parseBearer,
  readRequestBody,
  resourceUrl,
  secureEqual,
  sendJson,
  wwwAuthenticate,
} from './runtime.js';

export class ScopedMcpProxy {
  #config;
  #serverToken;
  #ownerGitHubToken;
  #jwtSecret;
  #serviceForRequest;
  #githubAuth;
  #catalogClient;
  #catalogCache = { expiresAt: 0, tools: [] };

  constructor(options) {
    this.#config = options.config;
    this.#serverToken = options.serverToken;
    this.#ownerGitHubToken = options.ownerGitHubToken;
    this.#jwtSecret = options.jwtSecret;
    this.#serviceForRequest = options.serviceForRequest;
    this.#githubAuth = options.githubAuth;
    this.#catalogClient = new SafeJsonHttpClient({ timeoutMs: 5_000, maxResponseBytes: 5_000_000 });
  }

  #legacyJwt(token, req) {
    if (!this.#jwtSecret) return null;
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const [head, body, signature] = parts;
    let header;
    let payload;
    try {
      header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    const expected = createHmac('sha256', this.#jwtSecret).update(`${head}.${body}`).digest('base64url');
    if (header.alg !== 'HS256' || !secureEqual(signature, expected)) return null;
    if (!Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1_000)) return null;
    if (payload.iss !== authIssuer(req, this.#config)) return null;
    const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audience.includes(resourceUrl(req, this.#config))) return null;
    try {
      return {
        subject: String(payload.sub ?? this.#config.subject),
        clientId: String(payload.client_id ?? this.#config.defaultClientId),
        scopes: normalizeRequestedScopes(payload.scope),
        expiresAt: new Date(payload.exp * 1_000).toISOString(),
      };
    } catch {
      return null;
    }
  }

  #ownerAuthorization() {
    if (!this.#ownerGitHubToken) throw new Error('owner GitHub credential is not configured');
    return `Bearer ${this.#ownerGitHubToken}`;
  }

  async #caller(req) {
    const token = parseBearer(req);
    if (!token) return null;
    if (this.#serverToken && secureEqual(token, this.#serverToken)) {
      try {
        return {
          kind: 'legacy',
          scopes: ['github.admin'],
          authorization: this.#ownerAuthorization(),
        };
      } catch {
        return null;
      }
    }
    const service = this.#serviceForRequest(req);
    if (service && token.startsWith('pgh_at_')) {
      try {
        const grant = await service.authenticate(req.headers.authorization);
        if (grant.githubCredentialRef) {
          if (!this.#githubAuth) return null;
          const credential = await this.#githubAuth.resolveToken(grant.githubCredentialRef);
          return {
            kind: 'oauth',
            scopes: grant.scopes,
            subject: grant.subject,
            githubUserId: grant.githubUserId,
            githubCredentialRef: grant.githubCredentialRef,
            authorization: `Bearer ${credential.token}`,
          };
        }
        return {
          kind: 'oauth',
          scopes: grant.scopes,
          subject: grant.subject,
          authorization: this.#ownerAuthorization(),
        };
      } catch {
        return null;
      }
    }
    const legacy = this.#legacyJwt(token, req);
    if (legacy) {
      try {
        return {
          kind: 'oauth',
          scopes: legacy.scopes,
          subject: legacy.subject,
          authorization: this.#ownerAuthorization(),
        };
      } catch {
        return null;
      }
    }
    if (this.#config.authMode === 'passthrough') {
      return { kind: 'passthrough', scopes: ['github.admin'], authorization: req.headers.authorization };
    }
    return null;
  }

  async #catalog(force = false) {
    if (!this.#ownerGitHubToken) throw new Error('OAuth catalog requires the owner GitHub credential');
    if (!force && this.#catalogCache.expiresAt > Date.now()) return this.#catalogCache.tools;
    const endpoint = `http://${this.#config.upstreamHost}:${this.#config.upstreamPort}/mcp`;
    let lastError;
    for (const delay of [0, 50, 100, 200, 400]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        const payload = await this.#catalogClient.requestJson({
          url: endpoint,
          init: {
            method: 'POST',
            headers: {
              Authorization: this.#ownerAuthorization(),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'oauth-catalog', method: 'tools/list', params: {} }),
          },
        });
        if (!Array.isArray(payload?.result?.tools)) throw new Error('upstream tool catalog is invalid');
        this.#catalogCache = { expiresAt: Date.now() + 60_000, tools: payload.result.tools };
        return this.#catalogCache.tools;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error('upstream tool catalog unavailable');
  }

  async #requiredScope(payload, scopes) {
    const entries = Array.isArray(payload) ? payload : [payload];
    const calls = entries.filter((entry) => entry?.method === 'tools/call');
    if (calls.length === 0) return '';
    let tools = await this.#catalog();
    let byName = new Map(tools.map((tool) => [tool.name, tool]));
    if (calls.some((entry) => !byName.has(entry?.params?.name))) {
      tools = await this.#catalog(true);
      byName = new Map(tools.map((tool) => [tool.name, tool]));
    }
    for (const call of calls) {
      const tool = byName.get(call?.params?.name);
      if (!tool) continue;
      const required = requiredScopeForTool(tool);
      if (!scopeAllows(scopes, required)) return required;
    }
    return '';
  }

  #transformList(payload, requestIds, scopes) {
    const entries = Array.isArray(payload) ? payload : [payload];
    const result = entries.map((entry) => {
      if (!requestIds.has(JSON.stringify(entry?.id ?? null)) || !Array.isArray(entry?.result?.tools)) return entry;
      const tools = entry.result.tools
        .filter((tool) => scopeAllows(scopes, requiredScopeForTool(tool)))
        .map((tool) => {
          const securitySchemes = securitySchemesForTool(tool);
          return { ...tool, securitySchemes, _meta: { ...(tool._meta ?? {}), securitySchemes } };
        });
      return { ...entry, result: { ...entry.result, tools } };
    });
    return Array.isArray(payload) ? result : result[0];
  }

  #proxy(req, res, options = {}) {
    const headers = {
      ...req.headers,
      host: `${this.#config.upstreamHost}:${this.#config.upstreamPort}`,
      ...(options.authorization ? { authorization: options.authorization } : {}),
    };
    if (options.body) {
      headers['content-length'] = String(options.body.length);
      delete headers['transfer-encoding'];
    }
    const upstreamReq = httpRequest({
      host: this.#config.upstreamHost,
      port: this.#config.upstreamPort,
      method: req.method,
      path: req.url,
      headers,
    }, (upstreamRes) => {
      const responseHeaders = { ...upstreamRes.headers };
      if (upstreamRes.statusCode === 401 && !responseHeaders['www-authenticate']) {
        responseHeaders['www-authenticate'] = wwwAuthenticate(req, this.#config);
      }
      if (!options.transform) {
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        upstreamRes.pipe(res);
        return;
      }
      const chunks = [];
      let total = 0;
      upstreamRes.on('data', (chunk) => {
        total += chunk.length;
        if (total <= 10_000_000) chunks.push(chunk);
      });
      upstreamRes.on('end', () => {
        if (total > 10_000_000) return sendJson(res, this.#config, 502, { error: 'upstream_response_too_large' });
        try {
          const transformed = options.transform(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          const body = Buffer.from(JSON.stringify(transformed));
          delete responseHeaders['content-length'];
          delete responseHeaders['transfer-encoding'];
          responseHeaders['content-length'] = String(body.length);
          res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
          res.end(body);
        } catch {
          sendJson(res, this.#config, 502, { error: 'invalid_upstream_response' });
        }
      });
    });
    upstreamReq.on('error', (error) => {
      sendJson(res, this.#config, 502, { error: 'upstream_unavailable', message: error?.message ?? String(error) });
    });
    if (options.body) upstreamReq.end(options.body);
    else req.pipe(upstreamReq);
  }

  async handle(req, res, url) {
    const caller = await this.#caller(req);
    if (url.pathname === '/mcp' && caller === null && parseBearer(req)) {
      sendJson(res, this.#config, 401, { error: 'invalid_token' }, {
        'WWW-Authenticate': wwwAuthenticate(req, this.#config),
      });
      return;
    }
    if (url.pathname !== '/mcp' || req.method !== 'POST' || caller?.kind !== 'oauth') {
      this.#proxy(req, res, { authorization: caller?.authorization });
      return;
    }
    const body = await readRequestBody(req, this.#config.maxBodyBytes);
    let payload;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, this.#config, 400, { error: 'invalid_json' });
      return;
    }
    const required = await this.#requiredScope(payload, caller.scopes);
    if (required) {
      sendJson(res, this.#config, 403, { error: 'insufficient_scope', required_scope: required }, {
        'WWW-Authenticate': wwwAuthenticate(req, this.#config, required),
      });
      return;
    }
    const entries = Array.isArray(payload) ? payload : [payload];
    const listIds = new Set(entries
      .filter((entry) => entry?.method === 'tools/list')
      .map((entry) => JSON.stringify(entry?.id ?? null)));
    this.#proxy(req, res, {
      body,
      authorization: caller.authorization,
      ...(listIds.size === 0 ? {} : {
        transform: (response) => this.#transformList(response, listIds, caller.scopes),
      }),
    });
  }
}
