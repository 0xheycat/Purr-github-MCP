import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const port = 3999;
const githubPort = 4099;
const sourcePort = 4100;
const repoPath = '/repos/octo/demo';
const largeBytes = 80_000_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function consume(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    req.on('data', (chunk) => { bytes += chunk.length; });
    req.on('end', () => resolve(bytes));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const githubCalls = [];
const githubMock = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  githubCalls.push({ method: req.method, path: url.pathname });

  if (req.method === 'GET' && url.pathname === `${repoPath}/branches/feat%2Ftest`) {
    return json(res, 200, { commit: { sha: 'parent-sha' } });
  }
  if (req.method === 'GET' && url.pathname === `${repoPath}/git/commits/parent-sha`) {
    return json(res, 200, { tree: { sha: 'base-tree-sha' } });
  }
  if (req.method === 'POST' && url.pathname === `${repoPath}/git/blobs`) {
    const bytes = await consume(req);
    return json(res, 201, { sha: bytes > 100_000_000 ? 'large-blob-sha' : 'text-blob-sha', request_bytes: bytes });
  }
  if (req.method === 'POST' && url.pathname === `${repoPath}/git/trees`) {
    await readJson(req);
    return json(res, 201, { sha: 'new-tree-sha' });
  }
  if (req.method === 'POST' && url.pathname === `${repoPath}/git/commits`) {
    await readJson(req);
    return json(res, 201, { sha: 'new-commit-sha', html_url: 'https://github.test/octo/demo/commit/new-commit-sha' });
  }
  if (req.method === 'PATCH' && url.pathname === `${repoPath}/git/refs/heads/feat%2Ftest`) {
    await readJson(req);
    return json(res, 200, { ref: 'refs/heads/feat/test' });
  }

  return json(res, 404, { message: `Unhandled ${req.method} ${url.pathname}` });
});

const sourceMock = createServer((req, res) => {
  if (req.url !== '/large.bin') {
    res.writeHead(404);
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(largeBytes),
  });
  const chunk = Buffer.alloc(1024 * 1024, 7);
  let remaining = largeBytes;
  function writeMore() {
    while (remaining > 0) {
      const next = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
      remaining -= next.length;
      if (!res.write(next)) {
        res.once('drain', writeMore);
        return;
      }
    }
    res.end();
  }
  writeMore();
});

await new Promise((resolve) => githubMock.listen(githubPort, '127.0.0.1', resolve));
await new Promise((resolve) => sourceMock.listen(sourcePort, '127.0.0.1', resolve));

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    AUTH_MODE: 'passthrough',
    GITHUB_API_BASE: `http://127.0.0.1:${githubPort}`,
    REQUEST_BODY_LIMIT: '3000000',
    MAX_BYTES_PER_FILE: '100000000',
    MAX_BYTES_PER_COMMIT: '100000000',
    MAX_FILES_PER_COMMIT: '0',
    ALLOW_BINARY: 'true',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
server.stdout.on('data', (chunk) => { output += chunk.toString(); });
server.stderr.on('data', (chunk) => { output += chunk.toString(); });

async function request(path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer test-token-for-smoke',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return parsed;
}

async function callTool(name, args, id) {
  return request('/mcp', { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
}

try {
  await sleep(500);

  const health = await request('/health');
  if (health.status !== 'ok') throw new Error(`Unexpected health: ${JSON.stringify(health)}`);

  const init = await request('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  if (init.result?.serverInfo?.name !== 'purr-github-MCP') {
    throw new Error(`Unexpected initialize result: ${JSON.stringify(init)}`);
  }

  const list = await request('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tools = list.result?.tools ?? [];
  if (!Array.isArray(tools) || tools.length < 18) {
    throw new Error(`Unexpected tools/list result: ${JSON.stringify(list)}`);
  }
  const getFile = tools.find((tool) => tool.name === 'get_file');
  const deleteFile = tools.find((tool) => tool.name === 'delete_file');
  const verifyMcp = tools.find((tool) => tool.name === 'verify_mcp_deploy');
  if (getFile?.annotations?.readOnlyHint !== true || deleteFile?.annotations?.destructiveHint !== true || verifyMcp?.annotations?.readOnlyHint !== true) {
    throw new Error(`Tool annotations are missing or incorrect: ${JSON.stringify({ getFile, deleteFile, verifyMcp })}`);
  }

  const secret = await callTool('commit_small_text_files', {
    repo: 'octo/demo',
    branch: 'feat/test',
    files: [{ path: 'notes.txt', content: 'api_key="1234567890abcdef1234567890abcdef"' }],
    commit_message: 'blocked secret',
  }, 3);
  if (!secret.error?.message?.includes('secret/token')) {
    throw new Error(`Secret scan did not block text secret: ${JSON.stringify(secret)}`);
  }

  const bigText = 'a'.repeat(1_200_000);
  const bigTextCommit = await callTool('commit_small_text_files', {
    repo: 'octo/demo',
    branch: 'feat/test',
    files: [{ path: 'big.txt', content: bigText }],
    commit_message: 'commit bigger than 1mb json body',
  }, 4);
  if (bigTextCommit.result?.content?.[0]?.type !== 'text') {
    throw new Error(`>1MB text commit failed: ${JSON.stringify(bigTextCommit)}`);
  }

  const largeCommit = await callTool('commit_large_file_from_url', {
    repo: 'octo/demo',
    branch: 'feat/test',
    path: 'assets/large.bin',
    source_url: `http://127.0.0.1:${sourcePort}/large.bin`,
    commit_message: 'commit 80mb source url',
  }, 5);
  const largeText = largeCommit.result?.content?.[0]?.text ?? '';
  if (!largeText.includes('"bytes": 80000000') || !largeText.includes('"binary": true')) {
    throw new Error(`80MB source_url commit failed: ${JSON.stringify(largeCommit)}`);
  }
  if (!githubCalls.some((call) => call.method === 'POST' && call.path.endsWith('/git/blobs'))) {
    throw new Error('Mock GitHub blob endpoint was not called.');
  }

  console.log(`Smoke test passed with ${tools.length} tools, >1MB JSON commit, 80MB source_url commit, annotations, and secret blocking.`);
} finally {
  server.kill('SIGTERM');
  await sleep(200);
  await new Promise((resolve) => githubMock.close(resolve));
  await new Promise((resolve) => sourceMock.close(resolve));
  if (output.includes('Error')) process.stderr.write(output);
}
