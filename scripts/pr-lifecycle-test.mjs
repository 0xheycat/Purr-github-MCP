import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const port = 4199;
const githubPort = 4200;
const calls = [];
let pullDraft = true;

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

function pull(number = 7) {
  return {
    number,
    node_id: number === 9 ? 'PR_node_error' : `PR_node_${number}`,
    title: 'Add lifecycle tools',
    body: 'Body',
    state: 'open',
    draft: pullDraft,
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
    html_url: `https://github.test/octo/demo/pull/${number}`,
  };
}

const githubMock = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const accept = String(req.headers.accept ?? '');
  const contentType = String(req.headers['content-type'] ?? '');
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method ?? '') ? await readBody(req) : null;
  calls.push({ method: req.method, path: url.pathname, search: url.search, accept, contentType, body });

  if (req.method === 'GET' && url.pathname === '/repos/octo/demo/pulls/403') {
    return json(res, 403, { message: 'forbidden fixture' });
  }
  if (req.method === 'GET' && url.pathname === '/repos/octo/demo/pulls/7' && accept.includes('application/vnd.github.diff')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('diff --git a/a.js b/a.js\n+ready\n');
    return;
  }
  if (req.method === 'GET' && ['/repos/octo/demo/pulls/7', '/repos/octo/demo/pulls/9'].includes(url.pathname)) {
    return json(res, 200, pull(Number(url.pathname.split('/').at(-1))));
  }
  if (req.method === 'GET' && url.pathname === '/repos/octo/demo/pulls/7/files') {
    return json(res, 200, [{
      sha: 'file-sha',
      filename: 'src/a.js',
      status: 'modified',
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: '+ready',
      blob_url: 'https://github.test/blob/file-sha',
      raw_url: 'https://github.test/raw/file-sha',
    }]);
  }
  if (req.method === 'GET' && url.pathname === '/repos/octo/demo/pulls/7/commits') {
    return json(res, 200, [{
      sha: 'head-sha',
      commit: {
        message: 'feat: ready',
        author: { name: 'Octo', date: '2026-07-23T00:00:00Z' },
        committer: { date: '2026-07-23T00:01:00Z' },
      },
      author: { login: 'octocat' },
      html_url: 'https://github.test/commit/head-sha',
    }]);
  }
  if (req.method === 'GET' && url.pathname === '/repos/octo/demo/pulls/7/reviews') {
    return json(res, 200, [{
      id: 11,
      user: { login: 'reviewer' },
      body: 'LGTM',
      state: 'APPROVED',
      commit_id: 'head-sha',
      submitted_at: '2026-07-23T01:00:00Z',
      html_url: 'https://github.test/review/11',
    }]);
  }
  if (req.method === 'GET' && url.pathname === '/repos/octo/demo/issues/7/comments') {
    return json(res, 200, [{
      id: 13,
      user: { login: 'reviewer' },
      body: 'Conversation',
      created_at: '2026-07-23T01:00:00Z',
      updated_at: '2026-07-23T01:00:00Z',
      html_url: 'https://github.test/comment/13',
    }]);
  }
  if (req.method === 'GET' && url.pathname === '/repos/octo/demo/pulls/7/requested_reviewers') {
    return json(res, 200, {
      users: [{ login: 'reviewer', html_url: 'https://github.test/reviewer' }],
      teams: [{ name: 'Platform', slug: 'platform', html_url: 'https://github.test/platform' }],
    });
  }
  if (req.method === 'GET' && url.pathname === '/repos/octo/demo/commits/head-sha/status') {
    return json(res, 200, {
      sha: 'head-sha',
      state: 'success',
      total_count: 1,
      statuses: [{
        context: 'ci/test',
        state: 'success',
        description: 'passed',
        target_url: 'https://ci.test',
        created_at: '2026-07-23T01:00:00Z',
        updated_at: '2026-07-23T01:00:00Z',
      }],
    });
  }
  if (req.method === 'GET' && url.pathname === '/repos/octo/demo/commits/head-sha/check-runs') {
    return json(res, 200, {
      total_count: 1,
      check_runs: [{
        id: 14,
        name: 'test',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-07-23T01:00:00Z',
        completed_at: '2026-07-23T01:01:00Z',
        details_url: 'https://ci.test/run/14',
        app: { slug: 'actions' },
      }],
    });
  }
  if (req.method === 'POST' && url.pathname === '/graphql') {
    assert.match(contentType, /^application\/json(?:;|$)/i);
    if (body.query.includes('reviewThreads')) {
      assert.deepEqual(body.variables, {
        owner: 'octo',
        repo: 'demo',
        number: 7,
        first: 100,
        after: 'cursor-1',
      });
      return json(res, 200, {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                totalCount: 1,
                pageInfo: {
                  hasNextPage: true,
                  hasPreviousPage: false,
                  startCursor: 'cursor-1',
                  endCursor: 'cursor-2',
                },
                nodes: [{
                  id: 'PRRT_thread_1',
                  isResolved: false,
                  isOutdated: false,
                  isCollapsed: false,
                  comments: {
                    totalCount: 1,
                    nodes: [{
                      id: 'PRRC_comment_12',
                      url: 'https://github.test/comment/12',
                      body: 'Inline',
                      author: { login: 'reviewer' },
                      path: 'src/a.js',
                      line: 8,
                      createdAt: '2026-07-23T01:00:00Z',
                      updatedAt: '2026-07-23T01:00:00Z',
                    }],
                  },
                }],
              },
            },
          },
        },
      });
    }
    if (body.variables.pullRequestId === 'PR_node_error') {
      return json(res, 200, { errors: [{ message: 'graphql fixture failure' }] });
    }
    if (body.query.includes('markPullRequestReadyForReview')) {
      pullDraft = false;
      return json(res, 200, {
        data: {
          markPullRequestReadyForReview: {
            pullRequest: { number: 7, isDraft: false, url: pull(7).html_url },
          },
        },
      });
    }
    if (body.query.includes('convertPullRequestToDraft')) {
      pullDraft = true;
      return json(res, 200, {
        data: {
          convertPullRequestToDraft: {
            pullRequest: { number: 7, isDraft: true, url: pull(7).html_url },
          },
        },
      });
    }
  }
  if (req.method === 'POST' && url.pathname === '/repos/octo/demo/pulls/422/requested_reviewers') {
    return json(res, 422, { message: 'unprocessable reviewer fixture' });
  }
  if (req.method === 'POST' && url.pathname === '/repos/octo/demo/pulls/7/requested_reviewers') {
    return json(res, 201, {
      requested_reviewers: body.reviewers.map((login) => ({ login })),
      requested_teams: body.team_reviewers.map((slug) => ({ slug })),
      html_url: pull(7).html_url,
    });
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

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await sleep(50);
  }
  throw new Error(`MCP server did not start. ${output}`);
}

async function callTool(name, args, id) {
  const response = await rpc('tools/call', { name, arguments: args }, id);
  if (response.error) throw new Error(response.error.message);
  return JSON.parse(response.result.content[0].text);
}

async function expectToolError(name, args, id, expected) {
  const response = await rpc('tools/call', { name, arguments: args }, id);
  assert.ok(response.error, `${name} should have failed`);
  assert.match(response.error.message, expected);
}

try {
  await waitForServer();

  const catalog = await rpc('tools/list', {}, 1);
  const byName = new Map(catalog.result.tools.map((tool) => [tool.name, tool]));
  for (const name of [
    'get_pull_request',
    'update_pull_request_draft_state',
    'request_pull_request_reviewers',
    'update_pull_request_branch',
  ]) {
    assert.ok(byName.has(name), `${name} missing from catalog`);
  }
  assert.equal(byName.get('get_pull_request').annotations.readOnlyHint, true);
  assert.equal(byName.get('update_pull_request_draft_state').annotations.idempotentHint, true);
  assert.equal(byName.get('request_pull_request_reviewers').annotations.idempotentHint, false);
  assert.equal(byName.get('update_pull_request_branch').annotations.idempotentHint, false);

  const detail = await callTool('get_pull_request', { repo: 'octo/demo', number: 7 }, 2);
  assert.equal(detail.head.sha, 'head-sha');
  assert.equal(detail.draft, true);
  assert.deepEqual(detail.labels, ['feature']);

  const diff = await callTool('get_pull_request', { repo: 'octo/demo', number: 7, method: 'get_diff' }, 3);
  assert.match(diff.diff, /\+ready/);

  const files = await callTool('get_pull_request', {
    repo: 'octo/demo', number: 7, method: 'get_files', page: 0, per_page: 999,
  }, 4);
  assert.equal(files[0].filename, 'src/a.js');
  const filesCall = calls.find((call) => call.method === 'GET' && call.path.endsWith('/pulls/7/files'));
  assert.equal(filesCall.search, '?page=1&per_page=100');

  const commits = await callTool('get_pull_request', { repo: 'octo/demo', number: 7, method: 'get_commits' }, 5);
  assert.equal(commits[0].sha, 'head-sha');

  const reviews = await callTool('get_pull_request', { repo: 'octo/demo', number: 7, method: 'get_reviews' }, 6);
  assert.equal(reviews[0].state, 'APPROVED');

  const threads = await callTool('get_pull_request', {
    repo: 'octo/demo', number: 7, method: 'get_review_comments', cursor: 'cursor-1', per_page: 200,
  }, 7);
  assert.equal(threads.threads[0].id, 'PRRT_thread_1');
  assert.equal(threads.threads[0].resolved, false);
  assert.equal(threads.total_count, 1);
  assert.equal(threads.threads[0].comments_total_count, 1);
  assert.equal(threads.threads[0].comments[0].id, 'PRRC_comment_12');
  assert.equal(threads.page_info.start_cursor, 'cursor-1');
  assert.equal(threads.page_info.end_cursor, 'cursor-2');

  const comments = await callTool('get_pull_request', { repo: 'octo/demo', number: 7, method: 'get_comments' }, 8);
  assert.equal(comments[0].body, 'Conversation');

  const requestedRead = await callTool('get_pull_request', {
    repo: 'octo/demo', number: 7, method: 'get_requested_reviewers',
  }, 9);
  assert.equal(requestedRead.users[0].login, 'reviewer');
  assert.equal(requestedRead.teams[0].slug, 'platform');

  const status = await callTool('get_pull_request', { repo: 'octo/demo', number: 7, method: 'get_status' }, 10);
  assert.equal(status.state, 'success');

  const checks = await callTool('get_pull_request', { repo: 'octo/demo', number: 7, method: 'get_check_runs' }, 11);
  assert.equal(checks.check_runs[0].conclusion, 'success');

  const draftNoop = await callTool('update_pull_request_draft_state', {
    repo: 'octo/demo', number: 7, draft: true,
  }, 12);
  assert.equal(draftNoop.changed, false);

  const ready = await callTool('update_pull_request_draft_state', {
    repo: 'octo/demo', number: 7, draft: false,
  }, 13);
  assert.equal(ready.draft, false);
  assert.equal(ready.changed, true);

  const readyNoop = await callTool('update_pull_request_draft_state', {
    repo: 'octo/demo', number: 7, draft: false,
  }, 14);
  assert.equal(readyNoop.changed, false);

  const draft = await callTool('update_pull_request_draft_state', {
    repo: 'octo/demo', number: 7, draft: true,
  }, 15);
  assert.equal(draft.draft, true);
  assert.equal(draft.changed, true);

  const secondDraftNoop = await callTool('update_pull_request_draft_state', {
    repo: 'octo/demo', number: 7, draft: true,
  }, 16);
  assert.equal(secondDraftNoop.changed, false);

  const requested = await callTool('request_pull_request_reviewers', {
    repo: 'octo/demo', number: 7, reviewers: ['alice', 'alice'], team_reviewers: ['platform', 'platform'],
  }, 17);
  assert.deepEqual(requested.requested_reviewers, ['alice']);
  assert.deepEqual(requested.requested_teams, ['platform']);

  const updated = await callTool('update_pull_request_branch', {
    repo: 'octo/demo', number: 7, expected_head_sha: 'head-sha',
  }, 18);
  assert.match(updated.message, /Updating/);

  await expectToolError('get_pull_request', { repo: 'octo/demo', number: 0 }, 19, /positive integer/);
  const callsBeforeDraftTypeErrors = calls.length;
  await expectToolError('update_pull_request_draft_state', {
    repo: 'octo/demo', number: 7,
  }, 24, /draft must be a boolean/);
  await expectToolError('update_pull_request_draft_state', {
    repo: 'octo/demo', number: 7, draft: 'false',
  }, 25, /draft must be a boolean/);
  await expectToolError('update_pull_request_draft_state', {
    repo: 'octo/demo', number: 7, draft: 0,
  }, 26, /draft must be a boolean/);
  assert.equal(calls.length, callsBeforeDraftTypeErrors, 'invalid draft types must fail before GitHub API calls');
  await expectToolError('request_pull_request_reviewers', { repo: 'octo/demo', number: 7 }, 20, /at least one reviewer/);
  await expectToolError('get_pull_request', { repo: 'octo/demo', number: 403 }, 21, /GitHub API 403: forbidden fixture/);
  await expectToolError('request_pull_request_reviewers', {
    repo: 'octo/demo', number: 422, reviewers: ['alice'],
  }, 22, /GitHub API 422: unprocessable reviewer fixture/);
  await expectToolError('update_pull_request_draft_state', {
    repo: 'octo/demo', number: 9, draft: false,
  }, 23, /GitHub GraphQL 200: graphql fixture failure/);

  const reviewerCall = calls.find((call) => call.method === 'POST' && call.path.endsWith('/pulls/7/requested_reviewers'));
  assert.deepEqual(reviewerCall.body, { reviewers: ['alice'], team_reviewers: ['platform'] });
  const branchCall = calls.find((call) => call.method === 'PUT' && call.path.endsWith('/update-branch'));
  assert.deepEqual(branchCall.body, { expected_head_sha: 'head-sha' });
  assert.equal(calls.filter((call) => call.path === '/graphql' && call.body.query.includes('markPullRequestReadyForReview')).length, 2);
  assert.equal(calls.filter((call) => call.path === '/graphql' && call.body.query.includes('convertPullRequestToDraft')).length, 1);
  assert.equal(calls.some((call) => call.path.endsWith('/pulls/7/comments')), false);

  console.log('PR lifecycle acceptance test passed: 10 read modes, review threads, strict draft typing, lifecycle mutations, pagination, annotations, and API error propagation.');
} finally {
  server.kill('SIGTERM');
  await sleep(150);
  await new Promise((resolve) => githubMock.close(resolve));
  if (output.includes('Error')) process.stderr.write(output);
}
