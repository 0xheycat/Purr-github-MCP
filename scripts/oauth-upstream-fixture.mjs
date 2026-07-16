import { createServer } from 'node:http';

const port = Number(process.env.PORT);
const host = process.env.HOST || '127.0.0.1';
const token = process.env.SERVER_TOKEN || '';

const tools = [
  {
    name: 'get_file',
    description: 'Read a file.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'get_verification_plan',
    description: 'Plan verification.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'commit_files',
    description: 'Commit files.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function dispatch(request) {
  if (request.method === 'initialize') {
    return { jsonrpc: '2.0', id: request.id ?? null, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'oauth-fixture', version: '1' }, capabilities: { tools: {} } } };
  }
  if (request.method === 'tools/list') {
    return { jsonrpc: '2.0', id: request.id ?? null, result: { tools } };
  }
  if (request.method === 'tools/call') {
    const name = request.params?.name;
    if (!tools.some((tool) => tool.name === name)) {
      return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32602, message: 'Unknown tool' } };
    }
    return { jsonrpc: '2.0', id: request.id ?? null, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, name }) }] } };
  }
  return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32601, message: 'Method not found' } };
}

const server = createServer(async (req, res) => {
  if (req.url === '/health') return json(res, 200, { status: 'ok' });
  if (req.url !== '/mcp') return json(res, 404, { error: 'not_found' });
  if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'invalid_token' });
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  const body = await readBody(req);
  json(res, 200, Array.isArray(body) ? body.map(dispatch) : dispatch(body));
});

server.listen(port, host);
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
