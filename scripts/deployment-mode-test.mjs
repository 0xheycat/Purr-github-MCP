import assert from 'node:assert/strict';
import { validateDeploymentMode } from '../src/deployment-mode.js';

const hosted = {
  DEPLOYMENT_MODE: 'hosted',
  OAUTH_JWT_SECRET: ['oauth', 'signing', 'material'].join('-'),
  SERVER_TOKEN: ['upstream', 'authorization', 'material'].join('-'),
  PUBLIC_BASE_URL: 'https://mcp.example.test',
  OAUTH_ISSUER: 'https://mcp.example.test',
  OAUTH_ALLOWED_REDIRECT_URIS: 'https://client.example.test/oauth/callback',
};

assert.equal(validateDeploymentMode({}).ok, false);
assert.equal(validateDeploymentMode(hosted).ok, true);

const incompleteHosted = validateDeploymentMode({ DEPLOYMENT_MODE: 'hosted' });
assert.equal(incompleteHosted.ok, false);
assert.equal(incompleteHosted.errors.includes('OAUTH_JWT_SECRET is required in hosted mode'), true);

const insecureHosted = validateDeploymentMode({ ...hosted, PUBLIC_BASE_URL: 'http://mcp.example.test' });
assert.equal(insecureHosted.ok, false);
assert.equal(insecureHosted.errors.includes('PUBLIC_BASE_URL must use https'), true);

const reusedMaterial = ['same', 'runtime', 'material'].join('-');
const reusedHosted = validateDeploymentMode({
  ...hosted,
  OAUTH_JWT_SECRET: reusedMaterial,
  SERVER_TOKEN: reusedMaterial,
});
assert.equal(reusedHosted.ok, false);
assert.equal(reusedHosted.errors.includes('OAUTH_JWT_SECRET must be distinct from SERVER_TOKEN in hosted mode'), true);

assert.equal(validateDeploymentMode({
  DEPLOYMENT_MODE: 'self-hosted',
  SERVER_TOKEN: ['legacy', 'runtime', 'material'].join('-'),
}).ok, true);
assert.equal(validateDeploymentMode({ DEPLOYMENT_MODE: 'self-hosted' }).ok, false);

console.log('deployment mode boundary tests passed');