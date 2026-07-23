const MODES = new Set(['hosted', 'self-hosted']);

function present(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireHttps(name, value, errors) {
  if (!present(value)) return;
  try {
    if (new URL(value).protocol !== 'https:') errors.push(`${name} must use https`);
  } catch {
    errors.push(`${name} must be a valid URL`);
  }
}

export function validateDeploymentMode(environment = process.env) {
  const mode = String(environment.DEPLOYMENT_MODE ?? '').trim();
  const errors = [];

  if (!MODES.has(mode)) {
    return { ok: false, mode, errors: ['DEPLOYMENT_MODE must be explicitly set to hosted or self-hosted'] };
  }

  if (mode === 'self-hosted') {
    if (!present(environment.SERVER_TOKEN)) errors.push('SERVER_TOKEN is required in self-hosted mode');
    return { ok: errors.length === 0, mode, errors };
  }

  for (const name of ['OAUTH_JWT_SECRET', 'PUBLIC_BASE_URL', 'OAUTH_ISSUER', 'OAUTH_ALLOWED_REDIRECT_URIS']) {
    if (!present(environment[name])) errors.push(`${name} is required in hosted mode`);
  }

  requireHttps('PUBLIC_BASE_URL', environment.PUBLIC_BASE_URL, errors);
  requireHttps('OAUTH_ISSUER', environment.OAUTH_ISSUER, errors);
  for (const redirectUri of String(environment.OAUTH_ALLOWED_REDIRECT_URIS ?? '').split(/[ ,]+/).filter(Boolean)) {
    requireHttps('OAUTH_ALLOWED_REDIRECT_URIS entry', redirectUri, errors);
  }

  if (present(environment.SERVER_TOKEN)
    && present(environment.OAUTH_JWT_SECRET)
    && environment.SERVER_TOKEN === environment.OAUTH_JWT_SECRET) {
    errors.push('OAUTH_JWT_SECRET must be distinct from SERVER_TOKEN in hosted mode');
  }

  return { ok: errors.length === 0, mode, errors };
}

export function assertDeploymentMode(environment = process.env) {
  const result = validateDeploymentMode(environment);
  if (!result.ok) throw new Error(`Invalid deployment configuration: ${result.errors.join('; ')}`);
  return result.mode;
}