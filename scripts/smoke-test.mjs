import { spawn } from 'node:child_process';

const port = 3999;
const server = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', AUTH_MODE: 'passthrough' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
server.stdout.on('data', (chunk) => { output += chunk.toString(); });
server.stderr.on('data', (chunk) => { output += chunk.toString(); });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return json;
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
  if (!Array.isArray(list.result?.tools) || list.result.tools.length < 5) {
    throw new Error(`Unexpected tools/list result: ${JSON.stringify(list)}`);
  }

  console.log(`Smoke test passed with ${list.result.tools.length} tools.`);
} finally {
  server.kill('SIGTERM');
  await sleep(200);
}
