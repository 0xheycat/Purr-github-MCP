import assert from 'node:assert/strict';
import {
  SESSION_COOKIE_NAME,
  clearUserSessionCookie,
  createUserSessionToken,
  parseCookies,
  readUserSession,
  userSessionCookie,
  verifyUserSessionToken,
} from '../src/user-session.js';

const secret = 'session-fixture-signing-material';
const now = Date.UTC(2026, 6, 12, 12, 0, 0);
const user = { github_user_id: '81378817', github_login: '0xheycat' };

const token = createUserSessionToken(user, { secret, now, ttlSeconds: 3600 });
const verified = verifyUserSessionToken(token, { secret, now: now + 1000 });
assert.equal(verified.ok, true);
assert.deepEqual(verified.user, user);

assert.equal(verifyUserSessionToken(`${token}x`, { secret, now }).error, 'bad_session_signature');
assert.equal(verifyUserSessionToken(token, { secret: 'different-fixture-material', now }).error, 'bad_session_signature');
assert.equal(verifyUserSessionToken(token, { secret, now: now + 3600 * 1000 }).error, 'expired_session');
assert.equal(verifyUserSessionToken('', { secret, now }).error, 'malformed_session');

const cookie = userSessionCookie(token, { maxAgeSeconds: 3600 });
assert.match(cookie, new RegExp(`^${SESSION_COOKIE_NAME}=`));
assert.match(cookie, /HttpOnly/);
assert.match(cookie, /Secure/);
assert.match(cookie, /SameSite=Lax/);
assert.match(cookie, /Max-Age=3600/);

const parsed = parseCookies(`other=value; ${cookie.split(';')[0]}`);
assert.equal(parsed.get('other'), 'value');
assert.equal(parsed.get(SESSION_COOKIE_NAME), token);

const requestResult = readUserSession({ headers: { cookie: cookie.split(';')[0] } }, { secret, now });
assert.equal(requestResult.ok, true);
assert.deepEqual(requestResult.user, user);

const cleared = clearUserSessionCookie();
assert.match(cleared, new RegExp(`^${SESSION_COOKIE_NAME}=`));
assert.match(cleared, /Max-Age=0/);
assert.match(cleared, /HttpOnly/);

assert.throws(
  () => createUserSessionToken({ github_login: 'missing-id' }, { secret, now }),
  /github_user_id and github_login are required/,
);

console.log('GitHub user session regression tests passed');
