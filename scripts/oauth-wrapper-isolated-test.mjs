for (const key of [
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_APP_CALLBACK_URL',
  'GITHUB_APP_WEBHOOK_SECRET',
]) {
  process.env[key] = '';
}

await import('./oauth-wrapper-test.mjs');
