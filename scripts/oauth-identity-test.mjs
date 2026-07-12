import assert from 'node:assert/strict';
import {
  accessTokenIdentityClaims,
  authorizationCodeIdentityFields,
  authorizationIdentityFromSession,
  oauthSubjectForIdentity,
} from '../src/oauth-identity.js';

const session = {
  ok: true,
  user: {
    github_user_id: '12345678',
    github_login: 'octocat-example',
  },
};

assert.deepEqual(authorizationIdentityFromSession(session), {
  github_user_id: '12345678',
  github_login: 'octocat-example',
});

assert.deepEqual(authorizationCodeIdentityFields(session), {
  github_user_id: '12345678',
  github_login: 'octocat-example',
});

assert.equal(oauthSubjectForIdentity({ github_user_id: '12345678' }), 'github:12345678');

assert.deepEqual(accessTokenIdentityClaims({
  github_user_id: '12345678',
  github_login: 'octocat-example',
}), {
  sub: 'github:12345678',
  github_login: 'octocat-example',
});

assert.throws(
  () => authorizationIdentityFromSession({ ok: false }),
  /authenticated GitHub user session is required/,
);
assert.throws(
  () => authorizationIdentityFromSession({ ok: true, user: { github_login: 'octocat-example' } }),
  /authenticated GitHub user session is required/,
);
assert.throws(
  () => accessTokenIdentityClaims({ github_user_id: '12345678' }),
  /authorization code is missing GitHub identity/,
);

console.log('OAuth GitHub identity binding regression tests passed.');
