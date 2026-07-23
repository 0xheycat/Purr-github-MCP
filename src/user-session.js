import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE_NAME = 'purr_github_session';

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function timingEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function sessionSecret(env = process.env) {
  return env.SESSION_SIGNING_KEY || env.OAUTH_JWT_SECRET || '';
}

export function createUserSessionToken(user, options = {}) {
  const secret = options.secret || sessionSecret(options.env);
  if (!secret) throw new Error('SESSION_SIGNING_KEY or OAUTH_JWT_SECRET is required');
  if (!user || !user.github_user_id || !user.github_login) {
    throw new Error('github_user_id and github_login are required');
  }

  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const ttlSeconds = options.ttlSeconds ?? 8 * 60 * 60;
  const payload = {
    typ: 'github_user_session',
    github_user_id: String(user.github_user_id),
    github_login: String(user.github_login),
    iat: now,
    exp: now + ttlSeconds,
  };
  const encoded = base64urlJson(payload);
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyUserSessionToken(token, options = {}) {
  const secret = options.secret || sessionSecret(options.env);
  if (!secret) return { ok: false, error: 'missing_session_secret' };
  const [encoded, signature, extra] = String(token || '').split('.');
  if (!encoded || !signature || extra !== undefined) return { ok: false, error: 'malformed_session' };
  if (!timingEqual(signature, sign(encoded, secret))) return { ok: false, error: 'bad_session_signature' };

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'invalid_session_json' };
  }

  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (payload.typ !== 'github_user_session') return { ok: false, error: 'invalid_session_type' };
  if (!payload.github_user_id || !payload.github_login) return { ok: false, error: 'invalid_session_identity' };
  if (typeof payload.exp !== 'number' || payload.exp <= now) return { ok: false, error: 'expired_session' };
  return { ok: true, user: { github_user_id: String(payload.github_user_id), github_login: String(payload.github_login) }, payload };
}

export function parseCookies(header = '') {
  const cookies = new Map();
  for (const pair of String(header).split(';')) {
    const index = pair.indexOf('=');
    if (index < 1) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (name) cookies.set(name, decodeURIComponent(value));
  }
  return cookies;
}

export function readUserSession(req, options = {}) {
  const token = parseCookies(req?.headers?.cookie || '').get(SESSION_COOKIE_NAME) || '';
  return verifyUserSessionToken(token, options);
}

export function userSessionCookie(token, options = {}) {
  const maxAge = options.maxAgeSeconds ?? 8 * 60 * 60;
  const secure = options.secure !== false;
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
    `Max-Age=${maxAge}`,
  ].filter(Boolean).join('; ');
}

export function clearUserSessionCookie(options = {}) {
  const secure = options.secure !== false;
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
    'Max-Age=0',
  ].filter(Boolean).join('; ');
}
