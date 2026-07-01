// src/extensions.js
// Extended tool pack for purr-github-MCP.
// Self-contained on purpose: it does NOT depend on server.js internals, so it can
// be wired in with a single import without refactoring the existing entrypoint.
// All limits are environment-driven. Secret scanning stays ON by design.
//
// Wire-in (src/server.js):
//   import { extraTools } from './extensions.js';
//   const tools = [ ...<existing tool objects>, ...extraTools ];
// See docs/UPGRADE.md for full instructions.

import { Buffer } from 'node:buffer';

function env(key, fallback = '') {
  return process.env[key] ?? fallback;
}
function envInt(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function splitList(raw = '') {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const config = {
  githubApiBase: env('GITHUB_API_BASE', 'https://api.github.com').replace(/\/+$/, ''),
  allowedRepos: splitList(env('ALLOWED_REPOS')),
  protectedBranches: new Set(splitList(env('PROTECTED_BRANCHES', 'main,master,production,staging,release'))),
  maxBytesPerFile: envInt('MAX_BYTES_PER_FILE', 30000),
  allowProtectedWrites: env('ALLOW_PROTECTED_WRITES', 'false').toLowerCase() === 'true',
  allowWorkflowWrites: env('ALLOW_WORKFLOW_WRITES', 'false').toLowerCase() === 'true',
};

function limitEnabled(value) {
  return Number.isFinite(value) && value > 0;
}

function validateRepo(repo) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('Invalid repo. Expected "owner/repo".');
  }
  if (config.allowedRepos.length > 0 && !config.allowedRepos.includes(repo)) {
    throw new Error('Repository "' + repo + '" is not allowed by ALLOWED_REPOS.');
  }
  const [owner, name] = repo.split('/');
  return { owner, repo: name };
}

function assertBranchWritable(branch) {
  if (typeof branch !== 'string' || !branch.trim()) throw new Error('Branch is required.');
  if (!config.allowProtectedWrites && config.protectedBranches.has(branch)) {
    throw new Error('Branch "' + branch + '" is protected. Set ALLOW_PROTECTED_WRITES=true or clear PROTECTED_BRANCHES to override.');
  }
}

function validatePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('File path is required.');
  }
  const normalized = filePath.replace(/^\/+/, '');
  if (normalized.includes('..') || (normalized.startsWith('.') && normalized.match(/^\.(env|ssh|aws|npmrc)/i))) {
    throw new Error('Path "' + filePath + '" is not allowed.');
  }
  const deniedExact = new Set(['.env', '.env.local', '.env.production', '.env.development']);
  const deniedPrefixes = ['node_modules/', 'dist/', 'build/', '.next/', '.ssh/'];
  if (!config.allowWorkflowWrites) deniedPrefixes.unshift('.github/workflows/');
  if (deniedExact.has(normalized) || deniedPrefixes.some((prefix) => normalized.startsWith(prefix))) {
    throw new Error('Path "' + filePath + '" is denied by safety policy.');
  }
  return normalized;
}

function containsSecretLikeContent(content) {
  const patterns = [
    /ghp_[A-Za-z0-9_]{20,}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /sk-[A-Za-z0-9]{20,}/,
    /xox[baprs]-[A-Za-z0-9-]{20,}/,
    /-----BEGIN (RSA |EC |OPENSSH |PRIVATE )?PRIVATE KEY-----/,
    /(api[_-]?key|secret|password|token)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}/i,
  ];
  return patterns.some((p) => p.test(content));
}

function guardContent(path, content) {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (limitEnabled(config.maxBytesPerFile) && bytes > config.maxBytesPerFile) {
    throw new Error('File "' + path + '" is too large. Max ' + config.maxBytesPerFile + ' bytes (raise MAX_BYTES_PER_FILE).');
  }
  if (content.includes('\0')) throw new Error('File "' + path + '" looks binary. Only text files are allowed.');
  if (containsSecretLikeContent(content)) {
    throw new Error('File "' + path + '" appears to contain a secret. Commit blocked.');
  }
}

async function gh(token, route, options = {}) {
  const res = await fetch(config.githubApiBase + route, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'purr-github-mcp-ext/1.0',
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = (data && data.message) ? data.message : (res.status + ' ' + res.statusText);
    throw new Error('GitHub API ' + res.status + ': ' + message);
  }
  return data;
}

function textResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

const enc = (s) => encodeURIComponent(s);
const encPath = (p) => encodeURIComponent(p).replace(/%2F/g, '/');

export const extraTools = [
  {
    name: 'list_commits',
    description: 'List commits on a branch or ref, optionally filtered by file path.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format.' },
        sha: { type: 'string', description: 'Branch, tag, or commit SHA to start from.' },
        path: { type: 'string', description: 'Only commits touching this path.' },
        per_page: { type: 'number', default: 20 },
      },
      required: ['repo'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const params = new URLSearchParams();
      if (args.sha) params.set('sha', String(args.sha));
      if (args.path) params.set('path', String(args.path));
      params.set('per_page', String(Math.min(Number(args.per_page ?? 20), 100)));
      const commits = await gh(ctx.githubToken, '/repos/' + owner + '/' + repo + '/commits?' + params.toString());
      return textResult(commits.map((c) => ({
        sha: c.sha,
        message: c.commit && c.commit.message,
        author: c.commit && c.commit.author && c.commit.author.name,
        date: c.commit && c.commit.author && c.commit.author.date,
        html_url: c.html_url,
      })));
    },
  },
  {
    name: 'get_commit',
    description: 'Get a single commit including changed files and patch stats.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format.' },
        ref: { type: 'string', description: 'Commit SHA or ref.' },
      },
      required: ['repo', 'ref'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const c = await gh(ctx.githubToken, '/repos/' + owner + '/' + repo + '/commits/' + enc(String(args.ref)));
      return textResult({
        sha: c.sha,
        message: c.commit && c.commit.message,
        author: c.commit && c.commit.author,
        stats: c.stats,
        files: (c.files || []).map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch })),
        html_url: c.html_url,
      });
    },
  },
  {
    name: 'list_branches',
    description: 'List branches for a repository with protection flag.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format.' },
        per_page: { type: 'number', default: 50 },
      },
      required: ['repo'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const perPage = Math.min(Number(args.per_page ?? 50), 100);
      const branches = await gh(ctx.githubToken, '/repos/' + owner + '/' + repo + '/branches?per_page=' + perPage);
      return textResult(branches.map((b) => ({ name: b.name, protected: b.protected, sha: b.commit && b.commit.sha })));
    },
  },
  {
    name: 'list_pull_request_files',
    description: 'List files changed in a pull request with patch and status.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format.' },
        number: { type: 'number', description: 'Pull request number.' },
        per_page: { type: 'number', default: 50 },
      },
      required: ['repo', 'number'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const perPage = Math.min(Number(args.per_page ?? 50), 100);
      const files = await gh(ctx.githubToken, '/repos/' + owner + '/' + repo + '/pulls/' + Number(args.number) + '/files?per_page=' + perPage);
      return textResult(files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch })));
    },
  },
  {
    name: 'search_code',
    description: 'Search code within a repository using GitHub code search syntax.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format.' },
        query: { type: 'string', description: 'Search terms (GitHub code search qualifiers allowed).' },
        per_page: { type: 'number', default: 20 },
      },
      required: ['repo', 'query'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const perPage = Math.min(Number(args.per_page ?? 20), 100);
      const q = String(args.query) + ' repo:' + owner + '/' + repo;
      const data = await gh(ctx.githubToken, '/search/code?q=' + enc(q) + '&per_page=' + perPage);
      return textResult((data.items || []).map((i) => ({ path: i.path, name: i.name, html_url: i.html_url })));
    },
  },
  {
    name: 'update_file',
    description: 'Create or update a single text file on a branch. Provide sha when replacing an existing file.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format.' },
        branch: { type: 'string', description: 'Target branch.' },
        path: { type: 'string', description: 'File path to write.' },
        content: { type: 'string', description: 'New UTF-8 text content.' },
        message: { type: 'string', description: 'Commit message.' },
        sha: { type: 'string', description: 'Blob sha of the file being replaced (omit when creating).' },
      },
      required: ['repo', 'branch', 'path', 'content', 'message'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      assertBranchWritable(args.branch);
      const path = validatePath(args.path);
      const content = String(args.content);
      guardContent(path, content);
      const body = {
        message: String(args.message),
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch: String(args.branch),
        ...(args.sha ? { sha: String(args.sha) } : {}),
      };
      const data = await gh(ctx.githubToken, '/repos/' + owner + '/' + repo + '/contents/' + encPath(path), {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      return textResult({ success: true, path, commit: data.commit && data.commit.sha, html_url: data.content && data.content.html_url });
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from a branch. Requires the current blob sha.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format.' },
        branch: { type: 'string', description: 'Target branch.' },
        path: { type: 'string', description: 'File path to delete.' },
        sha: { type: 'string', description: 'Current blob sha of the file.' },
        message: { type: 'string', description: 'Commit message.' },
      },
      required: ['repo', 'branch', 'path', 'sha', 'message'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      assertBranchWritable(args.branch);
      const path = validatePath(args.path);
      const data = await gh(ctx.githubToken, '/repos/' + owner + '/' + repo + '/contents/' + encPath(path), {
        method: 'DELETE',
        body: JSON.stringify({ message: String(args.message), sha: String(args.sha), branch: String(args.branch) }),
      });
      return textResult({ success: true, path, commit: data.commit && data.commit.sha });
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request. Merge method defaults to merge.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format.' },
        number: { type: 'number', description: 'Pull request number.' },
        merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], default: 'merge' },
        commit_title: { type: 'string' },
        commit_message: { type: 'string' },
      },
      required: ['repo', 'number'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const body = {
        merge_method: args.merge_method ?? 'merge',
        ...(args.commit_title ? { commit_title: String(args.commit_title) } : {}),
        ...(args.commit_message ? { commit_message: String(args.commit_message) } : {}),
      };
      const data = await gh(ctx.githubToken, '/repos/' + owner + '/' + repo + '/pulls/' + Number(args.number) + '/merge', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      return textResult({ merged: data.merged, sha: data.sha, message: data.message });
    },
  },
];

export default extraTools;
