import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/oauth-wrapper.js', import.meta.url), 'utf8');
const functionMatch = source.match(/function isRedirectAllowed\(clientId, redirectUri\) \{[\s\S]*?\n\}/);

assert.ok(functionMatch, 'isRedirectAllowed implementation must remain discoverable for regression coverage');

const buildPolicy = new Function(
  'registeredClients',
  'config',
  'allowedRedirectUris',
  `${functionMatch[0]}\nreturn isRedirectAllowed;`,
);

const exactDefaultRedirect = 'https://chatgpt.com/connector/oauth/callback';
const registeredClients = new Map();
const isRedirectAllowed = buildPolicy(
  registeredClients,
  { defaultClientId: 'chatgpt-purr-git' },
  () => [exactDefaultRedirect],
);

assert.equal(
  isRedirectAllowed('chatgpt-purr-git', exactDefaultRedirect),
  true,
  'the exact configured redirect URI must be accepted',
);
assert.equal(
  isRedirectAllowed('chatgpt-purr-git', `${exactDefaultRedirect}/appended`),
  false,
  'a prefix-appended redirect URI must be rejected',
);
assert.equal(
  isRedirectAllowed('chatgpt-purr-git', 'https://chatgpt.com/connector/oauth/unregistered'),
  false,
  'an unregistered ChatGPT redirect URI must be rejected',
);

registeredClients.set('dynamic-client', {
  redirect_uris: ['https://client.example/oauth/callback'],
});
assert.equal(
  isRedirectAllowed('dynamic-client', 'https://client.example/oauth/callback'),
  true,
  'an exact dynamically registered redirect URI must be accepted',
);
assert.equal(
  isRedirectAllowed('dynamic-client', 'https://client.example/oauth/callback/extra'),
  false,
  'a dynamically registered redirect URI must also require exact matching',
);

console.log('OAuth redirect exact-match regression tests passed.');
