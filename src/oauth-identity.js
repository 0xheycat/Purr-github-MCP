export function authorizationIdentityFromSession(session) {
  if (!session?.ok || !session.user?.github_user_id || !session.user?.github_login) {
    throw new Error('authenticated GitHub user session is required');
  }
  return {
    github_user_id: String(session.user.github_user_id),
    github_login: String(session.user.github_login),
  };
}

export function oauthSubjectForIdentity(identity) {
  if (!identity?.github_user_id) {
    throw new Error('github_user_id is required');
  }
  return `github:${String(identity.github_user_id)}`;
}

export function authorizationCodeIdentityFields(session) {
  const identity = authorizationIdentityFromSession(session);
  return {
    github_user_id: identity.github_user_id,
    github_login: identity.github_login,
  };
}

export function accessTokenIdentityClaims(entry) {
  if (!entry?.github_user_id || !entry?.github_login) {
    throw new Error('authorization code is missing GitHub identity');
  }
  return {
    sub: oauthSubjectForIdentity(entry),
    github_login: String(entry.github_login),
  };
}
