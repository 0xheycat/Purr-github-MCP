import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const port = 4199;
const githubPort = 4200;
const calls = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
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

const pull = {
  number: 7,
  node_id: 'PR_node_7',
  title: 'Add lifecycle tools',
  body: 'Body',
  state: 'open',
  draft: true,
  merged: false,
  mergeable: true,
  mergeable_state: 'clean',
  rebaseable: true,
  user: { login: 'octocat' },
  head: { ref: 'feat/lifecycle', sha: 'head-sha', repo: { full_name: 'octo/demo' } },
  base: { ref: 'main', sha: 'base-sha', repo: { full_name: 'octo/demo' } },
  requested_reviewers: [{ login: 'reviewer' }],
  requested_teams: [{ slug: 'platform' }],
  labels: [{ name: 'feature' }],
  commits: 2,
  changed_files: 3,
  additions: 20,
  deletions: 4,
  comments: 1,
  review_comments: 2,
  maintainer_can_modify: true,
  created_at: '2026-07-23T00:00:00Z',
  updated_at: '2026-07-23T01:00:00Z',
  closed_at: null,
  merged_at: null,
  html_url: 'https://github.test/octo/demo/pull/7',
};

const githubMock = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const accept = String(req.headers.accept ?? '');
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method ?? '') ? await readBody(req) : null;
  calls.push({ method: req.method, path: url.pathname, search: url.search, accept, body });

  if (req.method === 'GET' && url.pathname === '/repos/octo/demo/pulls/7' && accept.includes('application/vnd.github.diff')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('diff --git a/a.js b/a.js\n+ready\n');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/repos/octo/demo/pulls/7') return json(res, 200, pull);
  if (req.method === 'GET' && url.pathname === '/repos/octo/demo/pulls/7/files') {
    return json(res, 200, [{ filename: 'src/a.js', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '+ready' }]);
  }
  if (req.method === 'GET' && url.pathname === '/repos/octo/demo/pulls/7/commits') {
    return json(res, 200, [{ sha: 'head-sha', commit: { message: 'feat: ready', author: { name: 'Octo', date: '2026-07-23T00:00:00Z' }, committer: { date: '2026-07-23T00:01:00Z' } }, author: { login: 'octocat' }, html_url: 'https://github.test/commit/head-sha' }]);
  }
  if (req.method === 'GET' && url.pathname === '/repos/octo/demo/pulls/7/reviews') {
    return json(res, 200, [{ id: 11, user: { login: 'reviewer' }, body: 'LGTM', state: 'APPROVED', commit_id: 'head-sha', submitted_at: '2026-07-23T01:00:00Z', html_url: 'https://github.test/review/11' }]);
  }
  if (req.method === 'GET' && url.pathname === '/repos/octo/demo/pulls/7/comments') {
    return json(res, 200, [{ id: 12, user: { login: 'reviewer' }, body: 'Inline', path: 'src/a.js', line: 1, side: 'RIGHT', created_at: '2026-07-23T01:00:00Z', updated_at: '2026-07-23T01:00:00Z', html_url: 'https://github.test/comment/12' }]);
  }
  if (req.method === 'GET' && url.pathname === '/repos/octo/demo/issues/7/comments') {
    return json(res, 200, [{ id: 13, user: { login: 'reviewer' }, body: 'Conversation', created_at: '2026-07-23T01:00:00Z', updated_at: '2026-07-23T01:00:00Z', html_url: 'https://github.test/comment/13' }]);
  }
  if (req.method === 'GET' && url.pathname === '/repos/octo/demo/pulls/7/requested_reviewers') {
    return json(res, 200, { users: [{ login: 'reviewer', html_url: 'https://github.test/reviewer' }], teams: [{ name: 'Platform', slug: 'platform', html_url: 'https://github.test/platform' }] });
  }
  if (req.method === 'GET' && url.pathname === '/repos/octo/demo/commits/head-sha/status') {
    return json(res, 200, { sha: 'head-sha', state: 'success', total_count: 1, statuses: [{ context: 'ci/test', state: 'success', description: 'passed', target_url: 'https://ci.test', created_at: '2026-07-23T01:00:00Z', updated_at: '2026-07-23T01:00:00Z' }] });
  }
  if (req.method === 'GET' && url.pathname === '/repos/octo/demo/commits/head-sha/check-runs') {
    return json(res, 200, { total_count: 1, check_runs: [{ id: 14, name: 'test', status: 'completed', conclusion: 'success', started_at: '2026-07-23T01:00:00Z', completed_at: '2026-07-23T01:01:00Z', details_url: 'https://ci.test/run/14', app: { slug: 'actions' } }] });
  }
  if (req.method === 'POST' && url.pathname === '/graphql') {
    assert.match(body.query, /markPullRequestReadyForReview/);
    assert.equal(body.variables.pullRequestId, 'PR_node_7');
    return json(res, 200, { data: { markPullRequestReadyForReview: { pullRequest: { number: 7, isDraft: false, url: pull.html_url } } } });
  }
  if (req.method === 'POST' && url.pathname === '/repos/octo/demo/pulls/7/requested_reviewers') {
    return json(res, 201, { requested_reviewers: body.reviewers.map((login) => ({ login })), requested_teams: body.team_reviewers.map((slug) => ({ slug })), html_url: pull.html_url });
  }
  if (req.method === 'PUT' && url.pathname === '/repos/octo/demo/pulls/7/update-branch') {
    return json(res, 202, { message: 'Updating pull request branch.', url: 'https://api.github.test/update/7' });
  }

  return json(res, 404, { message: `Unhandled ${req.method} ${url.pathname}${url.search}` });
});

await new Promise((resolve) => githubMock.listen(githubPort, '127.0.0.1', resolve));

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    AUTH_MODE: 'passthrough',
    GITHUB_API_BASE: `http://127.0.0.1:${githubPort}`,
    ALLOWED_REPOS: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
server.stdout.on('data', (chunk) => { output += chunk.toString(); });
server.stderr.on('data', (chunk) => { output += chunk.toString(); });

async function rpc(method, params, id) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return res.json();
}

async function callTool(name, args, id) {
  const response = await rpc('tools/call', { name, arguments: args }, id);
  if (response.error) throw new Error(JSON.stringify(response.error));
  return JSON.parse(response.result.content[0].text);
}

try {
  await sleep(400);
  const catalog = await rpc('tools/list', {}, 1);
  const byName = new Map(catalog.result.tools.map((tool) => [tool.name, tool]));
  for (const name of ['get_pull_request', 'update_pull_request_draft_state', 'request_pull_request_reviewers', 'update_pull_request_branch']) {
    assert.ok(byName.has(name), `${name} missing from catalog`);
  }
  assert.equal(byName.get('get_pull_request').annotations.readOnlyHint, true);
  assert.equal(byName.get('update_pull_request_draft_state').annotations.destructiveHint, false);
  assert.equal(byName.get('update_pull_request_draft_state').annotations.idempotentHint, true);

  const detail = await callTool('get_pull_request', { repo: 'octo/demo', number: 7 }, 2);
  assert.equal(detail.head.sha, 'head-sha');
  assert.equal(detail.draft, true);

  const diff = await callTool('get_pull_request', { repo: 'octo/demo', number: 7, method: 'get_diff' }, 3);
  assert.match(diff.diff, /\+ready/);

  const status = await callTool('get_pull_request', { repo: 'octo/demo', number: 7, method: 'get_status' }, 4);
  assert.equal(status.state, 'success');

  const checks = await callTool('get_pull_request', { repo: 'octo/demo', number: 7, method: 'get_check_runs' }, 5);
  assert.equal(checks.check_runs[0].conclusion, 'success');

  const unchanged = await callTool('update_pull_request_draft_state', { repo: 'octo/demo', number: 7, draft: true }, 6);
  assert.equal(unchanged.changed, false);

  const ready = await callTool('update_pull_request_draft_state', { repo: 'octo/demo', number: 7, draft: false }, 7);
  assert.equal(ready.draft, false);
  assert.equal(ready.changed, true);

  const requested = await callTool('request_pull_request_reviewers', { repo: 'octo/demo', number: 7, reviewers: ['alice', 'alice'], team_reviewers: ['platform'] }, 8);
  assert.deepEqual(requested.requested_reviewers, ['alice']);
  assert.deepEqual(requested.requested_teams, ['platform']);

  const updated = await callTool('update_pull_request_branch', { repo: 'octo/demo', number: 7, expected_head_sha: 'head-sha' }, 9);
  assert.match(updated.message, /Updating/);

  const reviewerCall = calls.find((call) => call.method === 'POST' && call.path.endsWith('/requested_reviewers'));
  assert.deepEqual(reviewerCall.body, { reviewers: ['alice'], team_reviewers: ['platform'] });
  const branchCall = calls.find((call) => call.method === 'PUT' && call.path.endsWith('/update-branch'));
  assert.deepEqual(branchCall.body, { expected_head_sha: 'head-sha' });
  assert.equal(calls.filter((call) => call.path === '/graphql').length, 1);

  console.log('PR lifecycle tools test passed.');
} finally {
  server.kill('SIGTERM');
  await sleep(150);
  await new Promise((resolve) => githubMock.close(resolve));
  if (output.includes('Error')) process.stderr.write(output);
}
