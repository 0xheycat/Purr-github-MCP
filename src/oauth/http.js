import { randomBytes } from 'node:crypto';

import {
  authServerMetadata,
  corsHeaders,
  oauthMetadata,
  parseCookie,
  readRequestBody,
  redirect,
  requestOrigin,
  sendHtml,
  sendJson,
} from './runtime.js';

const COOKIE = 'pgh_oauth_request';

export function isResourceMetadataPath(pathname) {
  return pathname === '/.well-known/oauth-protected-resource'
    || pathname === '/.well-known/oauth-protected-resource/mcp';
}

export function isAuthServerPath(pathname) {
  return pathname === '/.well-known/oauth-authorization-server'
    || pathname === '/.well-known/openid-configuration'
    || pathname === '/oauth/authorize'
    || pathname === '/oauth/authorize/confirm'
    || pathname === '/oauth/token'
    || pathname === '/oauth/register'
    || pathname === '/oauth/revoke'
    || pathname === '/authorize'
    || pathname === '/token'
    || pathname === '/register'
    || pathname === '/revoke'
    || pathname === '/jwks.json';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function requestCookie(value, req, config) {
  const secure = requestOrigin(req, config).startsWith('https:') ? '; Secure' : '';
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/oauth/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`;
}

function clearCookie(req, config) {
  const secure = requestOrigin(req, config).startsWith('https:') ? '; Secure' : '';
  return `${COOKIE}=; Path=/oauth/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function consentPage(prompt, nonce) {
  const scopes = prompt.scopes.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Purr GitHub MCP</title><style nonce="${nonce}">body{font-family:system-ui;background:#09090b;color:#fafafa;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}main{width:min(480px,100%);background:#18181b;border:1px solid #3f3f46;border-radius:18px;padding:24px}p,li{color:#d4d4d8;line-height:1.5}code{color:#fbbf24;word-break:break-all}input,button{width:100%;box-sizing:border-box;border-radius:10px;border:1px solid #52525b;background:#09090b;color:#fafafa;padding:12px;font-size:15px}button{margin-top:12px;border:0;font-weight:700;cursor:pointer}.approve{background:#f97316}.deny{background:#3f3f46}.muted{font-size:13px;color:#a1a1aa}.wait{display:none;color:#fbbf24}</style></head><body><main><h1>Authorize Purr GitHub MCP</h1><p><strong>${escapeHtml(prompt.clientName)}</strong> requests access.</p><ul>${scopes}</ul><p class="muted">Redirect: <code>${escapeHtml(prompt.redirectUri)}</code></p><form method="post" action="/oauth/authorize/confirm" id="approve-form"><input type="hidden" name="request_id" value="${escapeHtml(prompt.requestId)}"><input type="hidden" name="csrf_token" value="${escapeHtml(prompt.csrfToken)}"><input type="hidden" name="decision" value="approve"><label for="owner-code">Owner approval code</label><input id="owner-code" type="password" name="owner_code" autocomplete="current-password" required autofocus><button class="approve" id="approve-button" type="submit">Approve</button></form><form method="post" action="/oauth/authorize/confirm" id="deny-form"><input type="hidden" name="request_id" value="${escapeHtml(prompt.requestId)}"><input type="hidden" name="csrf_token" value="${escapeHtml(prompt.csrfToken)}"><input type="hidden" name="decision" value="deny"><button class="deny" id="deny-button" type="submit">Deny</button></form><p class="wait" id="wait">Authorizing…</p><script nonce="${nonce}">(function(){let done=false;function lock(){if(done)return;done=true;for(const id of ['approve-button','deny-button']){const b=document.getElementById(id);if(b){b.disabled=true;b.style.opacity='.55'}}document.getElementById('wait').style.display='block'}document.getElementById('approve-form').addEventListener('submit',lock);document.getElementById('deny-form').addEventListener('submit',lock)})()</script></main></body></html>`;
}

function oauthError(error) {
  const code = String(error?.message ?? error);
  return new Set([
    'access_denied', 'invalid_client', 'invalid_client_metadata', 'invalid_grant',
    'invalid_redirect_uri', 'invalid_request', 'invalid_target', 'invalid_token',
    'oauth_setup_required', 'server_error', 'unsupported_grant_type',
    'unsupported_response_type', 'unsupported_scope',
  ]).has(code) ? code : 'server_error';
}

async function authorizeGet(req, res, url, service, config) {
  if (!service) return sendJson(res, config, 503, { error: 'oauth_setup_required' });
  if (!service.configured) return sendJson(res, config, 503, { error: 'oauth_setup_required' });
  try {
    const prompt = await service.beginAuthorization(url.searchParams);
    const nonce = randomBytes(18).toString('base64url');
    sendHtml(res, config, 200, consentPage(prompt, nonce), nonce, {
      'Set-Cookie': requestCookie(prompt.cookieValue, req, config),
    });
  } catch (error) {
    sendJson(res, config, 400, { error: oauthError(error) });
  }
}

async function authorizeConfirm(req, res, service, config) {
  if (!service) return sendJson(res, config, 503, { error: 'oauth_setup_required' });
  try {
    const form = new URLSearchParams((await readRequestBody(req, config.maxBodyBytes)).toString('utf8'));
    const decision = form.get('decision');
    if (decision !== 'approve' && decision !== 'deny') throw new Error('invalid_request');
    const result = await service.confirmAuthorization({
      requestId: form.get('request_id') ?? '',
      decision,
      csrfToken: form.get('csrf_token') ?? '',
      ownerCode: form.get('owner_code') ?? '',
      cookieValue: parseCookie(req, COOKIE),
    });
    const callback = new URL(result.redirectUri);
    if (result.code) callback.searchParams.set('code', result.code);
    if (result.error) callback.searchParams.set('error', result.error);
    if (result.state) callback.searchParams.set('state', result.state);
    redirect(res, config, callback.toString(), { 'Set-Cookie': clearCookie(req, config) });
  } catch (error) {
    sendJson(res, config, oauthError(error) === 'access_denied' ? 403 : 400, { error: oauthError(error) });
  }
}

async function token(req, res, service, config) {
  if (!service) return sendJson(res, config, 503, { error: 'oauth_setup_required' });
  try {
    const form = new URLSearchParams((await readRequestBody(req, config.maxBodyBytes)).toString('utf8'));
    const result = form.get('grant_type') === 'refresh_token'
      ? await service.exchangeRefreshToken(form)
      : await service.exchangeAuthorizationCode(form);
    sendJson(res, config, 200, result);
  } catch (error) {
    sendJson(res, config, 400, { error: oauthError(error) });
  }
}

async function register(req, res, service, config) {
  if (!service) return sendJson(res, config, 503, { error: 'oauth_setup_required' });
  try {
    const input = JSON.parse((await readRequestBody(req, config.maxBodyBytes)).toString('utf8'));
    const client = await service.registerClient(input);
    sendJson(res, config, 201, {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(new Date(client.createdAt).valueOf() / 1_000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  } catch (error) {
    sendJson(res, config, 400, { error: oauthError(error) });
  }
}

async function revoke(req, res, service, config) {
  if (!service) return sendJson(res, config, 503, { error: 'oauth_setup_required' });
  try {
    await service.revoke(new URLSearchParams((await readRequestBody(req, config.maxBodyBytes)).toString('utf8')));
  } catch {}
  sendJson(res, config, 200, {});
}

export async function handleOAuthHttp(req, res, url, context) {
  const { config, service } = context;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(config));
    res.end();
    return;
  }
  if (isResourceMetadataPath(url.pathname)) {
    if (req.method !== 'GET') return sendJson(res, config, 405, { error: 'method_not_allowed' });
    return sendJson(res, config, 200, oauthMetadata(req, config));
  }
  if (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration') {
    if (req.method !== 'GET') return sendJson(res, config, 405, { error: 'method_not_allowed' });
    return sendJson(res, config, 200, authServerMetadata(req, config));
  }
  if ((url.pathname === '/oauth/authorize' || url.pathname === '/authorize') && req.method === 'GET') return authorizeGet(req, res, url, service, config);
  if ((url.pathname === '/oauth/authorize/confirm' || url.pathname === '/authorize') && req.method === 'POST') return authorizeConfirm(req, res, service, config);
  if ((url.pathname === '/oauth/token' || url.pathname === '/token') && req.method === 'POST') return token(req, res, service, config);
  if ((url.pathname === '/oauth/register' || url.pathname === '/register') && req.method === 'POST') return register(req, res, service, config);
  if ((url.pathname === '/oauth/revoke' || url.pathname === '/revoke') && req.method === 'POST') return revoke(req, res, service, config);
  if (url.pathname === '/jwks.json' && req.method === 'GET') return sendJson(res, config, 200, { keys: [] });
  sendJson(res, config, 405, { error: 'method_not_allowed' });
}
