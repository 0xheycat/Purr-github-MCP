function parseGitHubSubject(subject) {
  const match = /^github:(\d+):(ghc_[A-Za-z0-9_-]{24,128})$/.exec(String(subject));
  if (!match) return null;
  const userId = Number(match[1]);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  return { userId, githubCredentialRef: match[2] };
}

export class GitHubBoundOAuthService {
  #base;

  constructor(baseService) {
    this.#base = baseService;
  }

  get issuer() {
    return this.#base.issuer;
  }

  get resource() {
    return this.#base.resource;
  }

  get configured() {
    return this.#base.configured;
  }

  registerClient(...args) {
    return this.#base.registerClient(...args);
  }

  beginAuthorization(...args) {
    return this.#base.beginAuthorization(...args);
  }

  confirmAuthorization(...args) {
    return this.#base.confirmAuthorization(...args);
  }

  exchangeAuthorizationCode(...args) {
    return this.#base.exchangeAuthorizationCode(...args);
  }

  exchangeRefreshToken(...args) {
    return this.#base.exchangeRefreshToken(...args);
  }

  revoke(...args) {
    return this.#base.revoke(...args);
  }

  async authenticate(...args) {
    const grant = await this.#base.authenticate(...args);
    const binding = parseGitHubSubject(grant.subject);
    if (!binding) return grant;
    return {
      ...grant,
      subject: `github:${binding.userId}`,
      githubUserId: binding.userId,
      githubCredentialRef: binding.githubCredentialRef,
    };
  }
}
