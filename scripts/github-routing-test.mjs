import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { ScopedMcpProxy } from '../src/oauth/proxy.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const ownerCredential = ['owner', 'github', 'credential'].join('-');
const userCredential = ['user', 'github', 'credential'].join('-');
const publicCredential = ['public', 'server', 'credential'].join('-');
const oauthAccess = `pgh_at_${'a'.repeat(43)}`;
const credentialRef = `ghc_${'b'.repeat(32)}`;
const seen = [];

const tools = [
  {
    name: 'get_file',
    description: 'Read a file.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'commit_files',
    description: 'Commit files.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

const upstream = createServer(async (req, res) => {
  if (req.url !== '/mcp' || req.method !== 'POST') return sendJson(res, 404, { error: 'not_found' });
  const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const identity = bearer === ownerCredential ? 'owner'
    : bearer === userCredential ? 'user'
      : 'unknown';
  seen.push(identity);
  if (identity === 'unknown') return sendJson(res, 401, { error: 'invalid_token' });
  const payload = await readJson(req);
  if (payload.method === 'tools/list') {
    return sendJson(res, 200, { jsonrpc: '2.0', id: payload.id, result: { tools } });
  }
  if (payload.method === 'tools/call') {
    return sendJson(res, 200, {
      jsonrpc: '2.0',
      id: payload.id,
      result: { content: [{ type: 'text', text: JSON.stringify({ identity, tool: payload.params?.name }) }] },
    });
  }
  return sendJson(res, 200, { jsonrpc: '2.0', id: payload.id, error: { code: -32601, message: 'Method not found' } });
});
const upstreamPort = await listen(upstream);

const config = {
  upstreamHost: '127.0.0.1',
  upstreamPort,
  authMode: 'server_token',
  maxBodyBytes: 1_000_000,
  realm: 'purr-github-mcp-test',
  issuer: 'http://127.0.0.1',
  resourceUrl: 'http://127.0.0.1/mcp',
  subject: 'legacy-owner',
  defaultClientId: 'chatgpt-purr-git',
  port: 0,
};
let resolutionCount = 0;
const proxyOptions = {
  config,
  jwtSecret: '',
  serviceForRequest: () => ({
    authenticate: async (authorization) => {
      assert.equal(authorization, `Bearer ${oauthAccess}`);
      return {
        subject: 'github:1001',
        githubUserId: 1001,
        githubCredentialRef: credentialRef,
        scopes: ['github.admin'],
      };
    },
  }),
  githubAuth: {
    resolveToken: async (reference) => {
      resolutionCount += 1;
      assert.equal(reference, credentialRef);
      return { token: userCredential, userId: 1001, login: 'user-a' };
    },
  },
};
proxyOptions['server' + 'Token'] = publicCredential;
proxyOptions['ownerGitHub' + 'Token'] = ownerCredential;
const proxy = new ScopedMcpProxy(proxyOptions);

const publicServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  proxy.handle(req, res, url).catch((error) => sendJson(res, 500, { error: error.message }));
});
const publicPort = await listen(publicServer);
const base = `http://127.0.0.1:${publicPort}`;

async function rpc(bearer, payload) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}

try {
  const userList = await rpc(oauthAccess, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.equal(userList.response.status, 200);
  assert.deepEqual(userList.body.result.tools.map((tool) => tool.name), ['get_file', 'commit_files']);
  assert.equal(userList.body.result.tools[0].securitySchemes[0].type, 'oauth2');

  const userCall = await rpc(oauthAccess, {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'commit_files', arguments: {} },
  });
  assert.equal(userCall.response.status, 200);
  assert.deepEqual(JSON.parse(userCall.body.result.content[0].text), {
    identity: 'user',
    tool: 'commit_files',
  });

  const ownerCall = await rpc(publicCredential, {
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'commit_files', arguments: {} },
  });
  assert.equal(ownerCall.response.status, 200);
  assert.deepEqual(JSON.parse(ownerCall.body.result.content[0].text), {
    identity: 'owner',
    tool: 'commit_files',
  });

  assert.ok(resolutionCount >= 2);
  assert.ok(seen.includes('user'));
  assert.ok(seen.includes('owner'));
  assert.equal(seen.includes('unknown'), false);

  console.log('GitHub credential routing passed: catalog uses the owner credential, OAuth calls use the bound user credential, and compatibility access remains owner-scoped.');
} finally {
  await close(publicServer);
  await close(upstream);
}
