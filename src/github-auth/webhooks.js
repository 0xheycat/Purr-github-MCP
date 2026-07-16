function requiredText(value, field, maximum = 2_000) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function userIdFromAuthorization(payload) {
  const value = payload?.sender?.id ?? payload?.user?.id;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('github_webhook_user_invalid');
  return value;
}

function installationEvent(name, payload) {
  const installation = payload?.installation;
  if (!Number.isSafeInteger(installation?.id) || installation.id <= 0) {
    throw new Error('github_webhook_installation_invalid');
  }
  return {
    eventName: name,
    action: requiredText(payload?.action, 'GitHub webhook action', 100),
    installationId: installation.id,
    ...(Number.isSafeInteger(installation.account?.id) && installation.account.id > 0
      ? { accountId: installation.account.id }
      : {}),
    ...(typeof installation.account?.login === 'string'
      ? { accountLogin: installation.account.login }
      : {}),
  };
}

export class GitHubWebhookService {
  #webhookSecret;
  #githubAuth;
  #moduleLoader;
  #webhooksPromise;

  constructor(options = {}) {
    this.#webhookSecret = String(options.webhookSecret ?? '');
    this.#githubAuth = options.githubAuth;
    this.#moduleLoader = options.moduleLoader ?? (() => import('@octokit/webhooks'));
    if (this.#webhookSecret.length > 1_000) throw new Error('GitHub webhook secret is invalid');
    if (this.#webhookSecret && !this.#githubAuth) {
      throw new Error('GitHub webhook service requires GitHub auth');
    }
  }

  get configured() {
    return this.#webhookSecret.length > 0 && this.#githubAuth !== undefined && this.#githubAuth !== null;
  }

  async #webhooks() {
    if (!this.configured) throw new Error('github_webhook_setup_required');
    if (!this.#webhooksPromise) {
      this.#webhooksPromise = Promise.resolve(this.#moduleLoader()).then((module) => {
        if (typeof module?.Webhooks !== 'function') throw new Error('github_webhook_provider_unavailable');
        const webhooks = new module.Webhooks({ secret: this.#webhookSecret });
        webhooks.on('github_app_authorization.revoked', async ({ payload }) => {
          await this.#githubAuth.revokeByUserId(
            userIdFromAuthorization(payload),
            'github_app_authorization.revoked',
          );
        });
        webhooks.on([
          'installation.created',
          'installation.deleted',
          'installation.suspend',
          'installation.unsuspend',
          'installation.new_permissions_accepted',
          'installation_repositories.added',
          'installation_repositories.removed',
        ], async ({ name, payload }) => {
          await this.#githubAuth.recordInstallationLifecycle(installationEvent(name, payload));
        });
        return webhooks;
      });
    }
    return this.#webhooksPromise;
  }

  async receive(options) {
    const webhooks = await this.#webhooks();
    const id = requiredText(options?.id, 'GitHub delivery ID', 300);
    const name = requiredText(options?.name, 'GitHub event name', 100);
    const signature = requiredText(options?.signature, 'GitHub webhook signature', 500);
    const payload = requiredText(options?.payload, 'GitHub webhook payload', 10_000_000);
    await webhooks.verifyAndReceive({ id, name, signature, payload });
    return { accepted: true };
  }
}
