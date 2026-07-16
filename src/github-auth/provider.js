function requiredText(value, field, maximum = 2_000) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function optionalTimestamp(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`${field} is invalid`);
  return parsed.toISOString();
}

function normalizeAuthentication(authentication) {
  if (authentication === null || typeof authentication !== 'object' || Array.isArray(authentication)) {
    throw new Error('github_oauth_exchange_failed');
  }
  return {
    token: requiredText(authentication.token, 'GitHub access token', 2_000),
    ...(authentication.refreshToken
      ? { refreshToken: requiredText(authentication.refreshToken, 'GitHub refresh token', 2_000) }
      : {}),
    ...(authentication.expiresAt
      ? { expiresAt: optionalTimestamp(authentication.expiresAt, 'GitHub access-token expiry') }
      : {}),
    ...(authentication.refreshTokenExpiresAt
      ? { refreshTokenExpiresAt: optionalTimestamp(authentication.refreshTokenExpiresAt, 'GitHub refresh-token expiry') }
      : {}),
  };
}

function normalizeUser(data) {
  if (
    data === null
    || typeof data !== 'object'
    || !Number.isSafeInteger(data.id)
    || data.id <= 0
    || typeof data.login !== 'string'
    || data.login.length === 0
    || data.login.length > 200
  ) {
    throw new Error('github_identity_invalid');
  }
  return {
    id: data.id,
    login: data.login,
    ...(typeof data.name === 'string' && data.name.length <= 300 ? { name: data.name } : {}),
    ...(typeof data.html_url === 'string' && data.html_url.length <= 2_000 ? { htmlUrl: data.html_url } : {}),
  };
}

export class OctokitGitHubAppProvider {
  #clientId;
  #clientSecret;
  #callbackUrl;
  #moduleLoader;
  #appPromise;

  constructor(options = {}) {
    this.#clientId = String(options.clientId ?? '');
    this.#clientSecret = String(options.clientSecret ?? '');
    this.#callbackUrl = String(options.callbackUrl ?? '');
    this.#moduleLoader = options.moduleLoader ?? (() => import('@octokit/oauth-app'));
    if (this.#clientId.length > 300) throw new Error('GitHub App client ID is invalid');
    if (this.#clientSecret.length > 1_000) throw new Error('GitHub App client secret is invalid');
    if (this.#callbackUrl.length > 2_000) throw new Error('GitHub App callback URL is invalid');
    if (this.configured) {
      const callback = new URL(this.#callbackUrl);
      if (callback.protocol !== 'https:' && callback.hostname !== 'localhost' && callback.hostname !== '127.0.0.1') {
        throw new Error('GitHub App callback URL must use HTTPS outside loopback');
      }
    }
  }

  get configured() {
    return this.#clientId.length > 0 && this.#clientSecret.length > 0 && this.#callbackUrl.length > 0;
  }

  async #app() {
    if (!this.configured) throw new Error('github_oauth_setup_required');
    if (!this.#appPromise) {
      this.#appPromise = Promise.resolve(this.#moduleLoader()).then((module) => {
        if (typeof module?.OAuthApp !== 'function') throw new Error('github_oauth_provider_unavailable');
        return new module.OAuthApp({
          clientType: 'github-app',
          clientId: this.#clientId,
          clientSecret: this.#clientSecret,
          redirectUrl: this.#callbackUrl,
        });
      });
    }
    return this.#appPromise;
  }

  async authorizationUrl(options) {
    const app = await this.#app();
    const state = requiredText(options?.state, 'GitHub OAuth state', 500);
    const result = app.getWebFlowAuthorizationUrl({
      state,
      redirectUrl: this.#callbackUrl,
      allowSignup: options?.allowSignup !== false,
    });
    const url = new URL(requiredText(result?.url, 'GitHub authorization URL', 4_000));
    if (url.protocol !== 'https:') throw new Error('github_authorization_url_invalid');
    return url.toString();
  }

  async exchange(options) {
    const app = await this.#app();
    const code = requiredText(options?.code, 'GitHub authorization code', 1_000);
    const state = requiredText(options?.state, 'GitHub OAuth state', 500);
    const result = await app.createToken({ code, state, redirectUrl: this.#callbackUrl });
    const authentication = normalizeAuthentication(result?.authentication);
    const octokit = await app.getUserOctokit(authentication);
    const response = await octokit.request('GET /user');
    return { authentication, user: normalizeUser(response?.data) };
  }

  async refresh(options) {
    const app = await this.#app();
    const refreshToken = requiredText(options?.refreshToken, 'GitHub refresh token', 2_000);
    const result = await app.refreshToken({ refreshToken });
    return normalizeAuthentication(result?.authentication);
  }

  async revoke(options) {
    const app = await this.#app();
    const token = requiredText(options?.token, 'GitHub access token', 2_000);
    await app.deleteAuthorization({ token });
  }
}
