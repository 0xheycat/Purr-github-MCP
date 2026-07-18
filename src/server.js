import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { extraTools } from './extensions.js';

const VERSION = '1.0.0';
const MCP_PROTOCOL_VERSION = '2024-11-05';
const GITHUB_BLOB_HARD_LIMIT_BYTES = 100_000_000;
const GITHUB_LARGE_FILE_WARNING_BYTES = 50_000_000;
const SAMPLE_BYTES = 8192;
const execFileAsync = promisify(execFile);

function env(key, fallback = '') {
  return process.env[key] ?? fallback;
}

function envInt(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(key, fallback = false) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function splitList(raw = '') {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const config = {
  host: env('HOST', '0.0.0.0'),
  port: envInt('PORT', 3000),
  authMode: env('AUTH_MODE', 'passthrough').toLowerCase(),
  serverToken: env('SERVER_TOKEN'),
  githubToken: env('GITHUB_TOKEN'),
  corsOrigin: env('CORS_ORIGIN', '*'),
  githubApiBase: env('GITHUB_API_BASE', 'https://api.github.com').replace(/\/+$/, ''),
  allowedRepos: splitList(env('ALLOWED_REPOS')),
  protectedBranches: new Set(splitList(env('PROTECTED_BRANCHES', 'main,master,production,staging,release'))),
  branchPrefixes: splitList(env('BRANCH_PREFIXES', 'feat/,fix/,docs/,chore/,refactor/,test/,perf/')),
  maxFilesPerCommit: envInt('MAX_FILES_PER_COMMIT', 0),
  maxBytesPerCommit: envInt('MAX_BYTES_PER_COMMIT', 0),
  maxBytesPerFile: envInt('MAX_BYTES_PER_FILE', 100_000_000),
  requestBodyLimit: envInt('REQUEST_BODY_LIMIT', 1_000_000),
  allowProtectedWrites: envBool('ALLOW_PROTECTED_WRITES', false),
  allowBinary: envBool('ALLOW_BINARY', false),
  allowImages: envBool('ALLOW_IMAGES', true),
  allowWorkflowWrites: envBool('ALLOW_WORKFLOW_WRITES', false),
  allowRepoCreate: envBool('ALLOW_REPO_CREATE', false),
};

const sessions = new Map();

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': config.corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    ...extra,
  };
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, corsHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }));
  res.end(JSON.stringify(body));
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data ? { data } : {}) },
  };
}

function sendSse(session, message) {
  const payload = typeof message === 'string' ? message : JSON.stringify(message);
  session.res.write(`data: ${payload}\n\n`);
}

function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  clearInterval(session.keepAlive);
  try {
    session.res.end();
  } catch {}
  sessions.delete(sessionId);
}

function limitEnabled(value) {
  return Number.isFinite(value) && value > 0;
}

function readBody(req, limitBytes = config.requestBodyLimit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error(`Request body too large. Max ${limitBytes} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authenticate(req) {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    return { ok: false, status: 401, error: 'Missing Authorization header. Use: Bearer <token>.' };
  }

  const bearer = match[1].trim();
  if (!bearer) {
    return { ok: false, status: 401, error: 'Empty Bearer token.' };
  }

  if (config.authMode === 'server_token') {
    if (!config.serverToken || !config.githubToken) {
      return {
        ok: false,
        status: 500,
        error: 'AUTH_MODE=server_token requires both SERVER_TOKEN and GITHUB_TOKEN.',
      };
    }
    if (bearer !== config.serverToken) {
      return { ok: false, status: 401, error: 'Invalid Bearer token.' };
    }
    return { ok: true, githubToken: config.githubToken, caller: 'server_token' };
  }

  return { ok: true, githubToken: bearer, caller: 'passthrough' };
}

function validateRepo(repo) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('Invalid repo. Expected "owner/repo".');
  }
  if (config.allowedRepos.length > 0 && !config.allowedRepos.includes(repo)) {
    throw new Error(`Repository "${repo}" is not allowed by ALLOWED_REPOS.`);
  }
  const [owner, name] = repo.split('/');
  return { owner, repo: name };
}

function validateRepoName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(name)) {
    throw new Error('Invalid repository name. Use 1-100 characters: letters, numbers, dot, underscore, or dash.');
  }
  if (name.startsWith('.') || name.endsWith('.')) {
    throw new Error('Invalid repository name: cannot start or end with a dot.');
  }
  return name;
}

function validateBranch(branch, { requirePrefix = false, protect = true } = {}) {
  if (typeof branch !== 'string' || branch.length < 1 || branch.length > 255) {
    throw new Error('Invalid branch name.');
  }
  if (branch.includes('..') || branch.startsWith('/') || branch.endsWith('/') || branch.includes('\\')) {
    throw new Error('Invalid branch name: unsafe path sequence.');
  }
  if (protect && !config.allowProtectedWrites && config.protectedBranches.has(branch)) {
    throw new Error(`Branch "${branch}" is protected. Use a feature branch instead.`);
  }
  if (requirePrefix && config.branchPrefixes.length > 0 && !config.branchPrefixes.some((prefix) => branch.startsWith(prefix))) {
    throw new Error(`Branch "${branch}" must start with one of: ${config.branchPrefixes.join(', ')}`);
  }
}

const IMAGE_SUFFIXES = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

function isImagePath(filePath) {
  const lower = filePath.toLowerCase();
  return IMAGE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function validatePath(filePath, { allowBinary = false, allowImages = config.allowImages } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('File path is required.');
  }
  const normalized = filePath.replace(/^\/+/, '');
  if (normalized.includes('..') || normalized.startsWith('.') && normalized.match(/^\.(env|ssh|aws|npmrc)/i)) {
    throw new Error(`Path "${filePath}" is not allowed.`);
  }
  const deniedExact = new Set([
    '.env', '.env.local', '.env.production', '.env.development',
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  ]);
  const deniedPrefixes = ['node_modules/', 'dist/', 'build/', '.next/', '.ssh/', 'terraform/', 'k8s/', 'kubernetes/'];
  if (!config.allowWorkflowWrites) deniedPrefixes.unshift('.github/workflows/');
  const deniedSuffixes = ['.pem', '.key', '.p12', '.pfx', '.db', '.sqlite', '.zip', '.rar', '.7z', '.tar', '.tar.gz', '.pdf'];
  const deniedImage = !allowBinary && !allowImages && isImagePath(normalized);
  const deniedBySuffix = !allowBinary && (deniedImage || deniedSuffixes.some((suffix) => normalized.toLowerCase().endsWith(suffix)));
  if (deniedExact.has(normalized) || deniedPrefixes.some((prefix) => normalized.startsWith(prefix)) || deniedBySuffix) {
    throw new Error(`Path "${filePath}" is denied by safety policy.`);
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
    /(api[_-]?key|secret|password|token)\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{16,}/i,
  ];
  return patterns.some((pattern) => pattern.test(content));
}

function validateFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('files must be a non-empty array.');
  }
  if (limitEnabled(config.maxFilesPerCommit) && files.length > config.maxFilesPerCommit) {
    throw new Error(`Too many files. Max ${config.maxFilesPerCommit}.`);
  }

  let totalBytes = 0;
  const validated = files.map((file) => {
    const path = validatePath(file?.path);
    const content = String(file?.content ?? '');
    const bytes = Buffer.byteLength(content, 'utf8');
    totalBytes += bytes;

    if (limitEnabled(config.maxBytesPerFile) && bytes > config.maxBytesPerFile) {
      throw new Error(`File "${path}" is too large. Max ${config.maxBytesPerFile} bytes.`);
    }
    if (content.includes('\0')) {
      throw new Error(`File "${path}" looks binary. Only small text files are allowed.`);
    }
    if (containsSecretLikeContent(content)) {
      throw new Error(`File "${path}" appears to contain a secret/token. Commit blocked.`);
    }
    return { path, content };
  });

  if (limitEnabled(config.maxBytesPerCommit) && totalBytes > config.maxBytesPerCommit) {
    throw new Error(`Payload too large. Max ${config.maxBytesPerCommit} bytes.`);
  }

  const unique = new Set(validated.map((file) => file.path));
  if (unique.size !== validated.length) {
    throw new Error('Duplicate file paths are not allowed in one commit.');
  }

  return validated;
}

async function githubRequest(token, route, options = {}) {
  const url = `${config.githubApiBase}${route}`;
  const res = await fetch(url, {
    ...options,
    ...(options.body && typeof options.body !== 'string' ? { duplex: 'half' } : {}),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'purr-github-mcp/1.0',
      ...(options.headers ?? {}),
    },
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.message ?? `${res.status} ${res.statusText}`;
    throw new Error(`GitHub API ${res.status}: ${message}`);
  }
  return data;
}

function assertLargeFileSize(size, path) {
  if (size > GITHUB_BLOB_HARD_LIMIT_BYTES) {
    throw new Error(`File "${path}" is ${size} bytes. GitHub blobs are limited to 100000000 bytes; use Git LFS above that.`);
  }
  if (limitEnabled(config.maxBytesPerFile) && size > config.maxBytesPerFile) {
    throw new Error(`File "${path}" is too large. Max ${config.maxBytesPerFile} bytes (raise MAX_BYTES_PER_FILE, max 100000000).`);
  }
  if (limitEnabled(config.maxBytesPerCommit) && size > config.maxBytesPerCommit) {
    throw new Error(`Commit payload is too large. Max ${config.maxBytesPerCommit} bytes (raise MAX_BYTES_PER_COMMIT).`);
  }
}

async function downloadSourceToTemp(sourceUrl, path) {
  let parsed;
  try {
    parsed = new URL(String(sourceUrl));
  } catch {
    throw new Error('source_url must be a valid http(s) URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('source_url must use http or https.');
  }

  const limit = limitEnabled(config.maxBytesPerFile)
    ? Math.min(config.maxBytesPerFile, GITHUB_BLOB_HARD_LIMIT_BYTES)
    : GITHUB_BLOB_HARD_LIMIT_BYTES;
  const tempDir = await mkdtemp(join(tmpdir(), 'purr-github-mcp-'));
  const tempPath = join(tempDir, `${Date.now()}-${randomUUID()}.upload`);
  const file = await open(tempPath, 'w');

  const res = await fetch(parsed, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    await file.close();
    await rm(tempPath, { force: true });
    throw new Error(`source_url download failed: ${res.status} ${res.statusText}`);
  }

  const declaredLength = Number.parseInt(res.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declaredLength)) assertLargeFileSize(declaredLength, path);

  let bytes = 0;
  const sampleChunks = [];
  let sampleSize = 0;
  try {
    for await (const chunk of Readable.fromWeb(res.body)) {
      bytes += chunk.length;
      if (bytes > limit) {
        throw new Error(`File "${path}" is too large. Max ${limit} bytes.`);
      }
      if (sampleSize < SAMPLE_BYTES) {
        const needed = Math.min(chunk.length, SAMPLE_BYTES - sampleSize);
        sampleChunks.push(chunk.subarray(0, needed));
        sampleSize += needed;
      }
      await file.write(chunk);
    }
  } finally {
    await file.close();
  }

  assertLargeFileSize(bytes, path);
  return {
    tempDir,
    tempPath,
    bytes,
    contentType: res.headers.get('content-type') ?? '',
    sample: Buffer.concat(sampleChunks),
  };
}

function sampleLooksBinary(sample, contentType = '') {
  if (sample.includes(0)) return true;
  if (/^(image|audio|video|application\/(zip|gzip|x-7z|octet-stream|pdf))/i.test(contentType)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return false;
  } catch {
    return true;
  }
}

async function scanTextFileForSecrets(path, displayPath) {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let carry = '';
  for await (const chunk of createReadStream(path)) {
    const text = decoder.decode(chunk, { stream: true });
    const window = carry + text;
    if (containsSecretLikeContent(window)) {
      throw new Error(`File "${displayPath}" appears to contain a secret/token. Commit blocked.`);
    }
    carry = window.slice(-2048);
  }
  const tail = carry + decoder.decode();
  if (containsSecretLikeContent(tail)) {
    throw new Error(`File "${displayPath}" appears to contain a secret/token. Commit blocked.`);
  }
}

async function* base64JsonBodyFromFile(path) {
  yield '{"content":"';
  let remainder = Buffer.alloc(0);
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    const data = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
    const wholeLength = data.length - (data.length % 3);
    if (wholeLength > 0) yield data.subarray(0, wholeLength).toString('base64');
    remainder = wholeLength < data.length ? data.subarray(wholeLength) : Buffer.alloc(0);
  }
  if (remainder.length) yield remainder.toString('base64');
  yield '","encoding":"base64"}';
}

async function createBlobFromFile(token, owner, repo, filePath) {
  return githubRequest(token, `/repos/${owner}/${repo}/git/blobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: Readable.from(base64JsonBodyFromFile(filePath)),
  });
}


function normalizeUploadedArchive(value) {
  const files = Array.isArray(value) ? value : [value];
  if (files.length !== 1) throw new Error('archive_file must contain exactly one ZIP file.');
  const file = files[0];
  if (!file || typeof file !== 'object') throw new Error('archive_file must be a ChatGPT file reference.');
  const downloadUrl = file.download_url ?? file.url;
  if (typeof downloadUrl !== 'string' || !downloadUrl) throw new Error('archive_file is missing download_url.');
  const name = typeof file.file_name === 'string' && file.file_name
    ? file.file_name
    : (typeof file.name === 'string' && file.name ? file.name : 'archive.zip');
  if (!name.toLowerCase().endsWith('.zip')) throw new Error('archive_file must be a .zip archive.');
  return { downloadUrl, name };
}

function validateZipEntry(rawEntry) {
  if (typeof rawEntry !== 'string' || !rawEntry) throw new Error('ZIP contains an empty path.');
  if (rawEntry.includes('\0') || rawEntry.includes('\\')) throw new Error(`ZIP path "${rawEntry}" is unsafe.`);
  if (rawEntry.startsWith('/') || /^[A-Za-z]:/.test(rawEntry)) throw new Error(`ZIP path "${rawEntry}" is absolute.`);
  const segments = rawEntry.split('/');
  if (segments.some((segment) => segment === '..')) throw new Error(`ZIP path "${rawEntry}" contains traversal.`);
  const withoutTrailingSlash = rawEntry.endsWith('/') ? rawEntry.slice(0, -1) : rawEntry;
  if (!withoutTrailingSlash || withoutTrailingSlash.split('/').some((segment) => !segment || segment === '.')) {
    throw new Error(`ZIP path "${rawEntry}" is not normalized.`);
  }
  return withoutTrailingSlash;
}

async function readFileSample(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function base64EncodeUtf8(input) {
  return Buffer.from(input, 'utf8').toString('base64');
}

function base64DecodeUtf8(input) {
  return Buffer.from(String(input).replace(/\s/g, ''), 'base64').toString('utf8');
}

async function getBranchSha(token, owner, repo, branch) {
  const data = await githubRequest(token, `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
  return data.commit.sha;
}

async function createTreeCommitAndUpdate(token, owner, repo, branch, files, commitMessage) {
  const parentSha = await getBranchSha(token, owner, repo, branch);
  const parentCommit = await githubRequest(token, `/repos/${owner}/${repo}/git/commits/${parentSha}`);
  const treeEntries = await Promise.all(files.map(async (file) => {
    const blob = await githubRequest(token, `/repos/${owner}/${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
    });
    return { path: file.path, mode: '100644', type: 'blob', sha: blob.sha };
  }));

  const tree = await githubRequest(token, `/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree: treeEntries }),
  });

  const commit = await githubRequest(token, `/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message: commitMessage, tree: tree.sha, parents: [parentSha] }),
  });

  await githubRequest(token, `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });

  return { commitSha: commit.sha, commitUrl: commit.html_url ?? `https://github.com/${owner}/${repo}/commit/${commit.sha}` };
}

async function createCommitFromTreeEntries(token, owner, repo, branch, treeEntries, commitMessage) {
  const parentSha = await getBranchSha(token, owner, repo, branch);
  const parentCommit = await githubRequest(token, `/repos/${owner}/${repo}/git/commits/${parentSha}`);
  const tree = await githubRequest(token, `/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree: treeEntries }),
  });

  const commit = await githubRequest(token, `/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message: commitMessage, tree: tree.sha, parents: [parentSha] }),
  });

  await githubRequest(token, `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });

  return { commitSha: commit.sha, commitUrl: commit.html_url ?? `https://github.com/${owner}/${repo}/commit/${commit.sha}` };
}

async function createBranchRef(token, owner, repo, baseBranch, newBranch) {
  validateBranch(baseBranch, { protect: false });
  validateBranch(newBranch, { requirePrefix: true, protect: false });
  const sha = await getBranchSha(token, owner, repo, baseBranch);
  await githubRequest(token, `/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha }),
  });
  return sha;
}

async function createPullRequest(token, owner, repo, args) {
  const pr = await githubRequest(token, `/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: String(args.title),
      body: String(args.body ?? ''),
      head: String(args.head),
      base: String(args.base ?? 'main'),
      draft: Boolean(args.draft),
    }),
  });
  return { number: pr.number, title: pr.title, html_url: pr.html_url, state: pr.state };
}

async function getFileContent(token, owner, repo, path, ref) {
  const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const data = await githubRequest(token, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}${refQuery}`);
  if (Array.isArray(data) || data.type !== 'file') throw new Error(`Path "${path}" is not a file.`);
  return {
    path: data.path,
    sha: data.sha,
    size: data.size,
    content: data.encoding === 'base64' ? base64DecodeUtf8(data.content) : String(data.content ?? ''),
  };
}

async function getFileContentOrNull(token, owner, repo, path, ref) {
  try {
    return await getFileContent(token, owner, repo, path, ref);
  } catch (error) {
    if (String(error?.message ?? '').includes('GitHub API 404')) return null;
    throw error;
  }
}

async function createTreeEntriesForTextFiles(token, owner, repo, files) {
  return Promise.all(files.map(async (file) => {
    const blob = await githubRequest(token, `/repos/${owner}/${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
    });
    return { path: file.path, mode: '100644', type: 'blob', sha: blob.sha };
  }));
}

function parseUnifiedDiff(diff) {
  const lines = String(diff).replace(/\r\n/g, '\n').split('\n');
  const files = [];
  let current = null;
  let hunk = null;

  for (const line of lines) {
    if (line.startsWith('--- ')) {
      current = { oldPath: line.slice(4).trim().replace(/^a\//, ''), newPath: null, hunks: [] };
      files.push(current);
      hunk = null;
      continue;
    }
    if (current && line.startsWith('+++ ')) {
      current.newPath = line.slice(4).trim().replace(/^b\//, '');
      continue;
    }
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (current && match) {
      hunk = { oldStart: Number(match[1]), lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (hunk && (/^[ +\-]/.test(line) || line === '\\ No newline at end of file')) {
      if (!line.startsWith('\\')) hunk.lines.push(line);
    }
  }

  return files.filter((file) => file.newPath && file.hunks.length > 0);
}

function applyDiffHunks(original, hunks, path) {
  const originalHadFinalNewline = original.endsWith('\n');
  const originalLines = originalHadFinalNewline ? original.slice(0, -1).split('\n') : (original ? original.split('\n') : []);
  const output = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const target = Math.max(hunk.oldStart - 1, 0);
    while (cursor < target) output.push(originalLines[cursor++]);
    for (const rawLine of hunk.lines) {
      const op = rawLine[0];
      const text = rawLine.slice(1);
      if (op === ' ') {
        if (originalLines[cursor] !== text) throw new Error(`Patch context mismatch in "${path}".`);
        output.push(originalLines[cursor++]);
      } else if (op === '-') {
        if (originalLines[cursor] !== text) throw new Error(`Patch removal mismatch in "${path}".`);
        cursor += 1;
      } else if (op === '+') {
        output.push(text);
      }
    }
  }

  while (cursor < originalLines.length) output.push(originalLines[cursor++]);
  return `${output.join('\n')}${originalHadFinalNewline ? '\n' : ''}`;
}

async function fetchJsonFromUrl(sourceUrl, limitBytes = config.requestBodyLimit) {
  const parsed = new URL(String(sourceUrl));
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('manifest_url must use http or https.');
  const res = await fetch(parsed, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`manifest_url download failed: ${res.status} ${res.statusText}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of Readable.fromWeb(res.body)) {
    size += chunk.length;
    if (limitEnabled(limitBytes) && size > limitBytes) throw new Error(`Manifest too large. Max ${limitBytes} bytes.`);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function packageManagerFromFiles(files) {
  const paths = new Set(files.map((file) => file.path));
  if (paths.has('bun.lockb') || paths.has('bun.lock')) return 'bun';
  if (paths.has('pnpm-lock.yaml')) return 'pnpm';
  if (paths.has('yarn.lock')) return 'yarn';
  if (paths.has('package-lock.json')) return 'npm';
  return 'npm';
}

function verificationCommands(packageManager, scripts = {}) {
  const run = packageManager === 'npm' ? 'npm run' : `${packageManager} run`;
  const install = packageManager === 'bun' ? 'bun install --frozen-lockfile'
    : packageManager === 'pnpm' ? 'pnpm install --frozen-lockfile'
      : packageManager === 'yarn' ? 'yarn install --frozen-lockfile'
        : 'npm ci';
  const commands = [install];
  for (const name of ['check', 'lint', 'typecheck', 'test', 'build']) {
    if (scripts[name]) commands.push(`${run} ${name}`);
  }
  if (commands.length === 1 && scripts.start) commands.push(`${run} start`);
  return commands;
}

async function listRootTree(token, owner, repo, ref = 'main') {
  const data = await githubRequest(token, `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}`);
  return data.tree ?? [];
}

function textResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

const tools = [
  {
    name: 'get_authenticated_user',
    description: 'Return the GitHub account for the Bearer token currently used by this MCP request.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      const user = await githubRequest(ctx.githubToken, '/user');
      return textResult({ login: user.login, id: user.id, name: user.name, html_url: user.html_url });
    },
  },
  {
    name: 'get_repository',
    description: 'Fetch repository metadata for an owner/repo repository.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string', description: 'Repository in owner/repo format.' } },
      required: ['repo'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const data = await githubRequest(ctx.githubToken, `/repos/${owner}/${repo}`);
      return textResult({
        full_name: data.full_name,
        private: data.private,
        default_branch: data.default_branch,
        description: data.description,
        open_issues_count: data.open_issues_count,
        stargazers_count: data.stargazers_count,
        html_url: data.html_url,
      });
    },
  },
  {
    name: 'list_issues',
    description: 'List repository issues. Pull requests are excluded from the returned list.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' },
        per_page: { type: 'number', default: 20 },
      },
      required: ['repo'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const state = args.state ?? 'open';
      const perPage = Math.min(Number(args.per_page ?? 20), 100);
      const items = await githubRequest(ctx.githubToken, `/repos/${owner}/${repo}/issues?state=${encodeURIComponent(state)}&per_page=${perPage}`);
      return textResult(items
        .filter((issue) => !issue.pull_request)
        .map((issue) => ({ number: issue.number, title: issue.title, state: issue.state, user: issue.user?.login, html_url: issue.html_url })));
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests for a repository.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' },
        per_page: { type: 'number', default: 20 },
      },
      required: ['repo'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const state = args.state ?? 'open';
      const perPage = Math.min(Number(args.per_page ?? 20), 100);
      const prs = await githubRequest(ctx.githubToken, `/repos/${owner}/${repo}/pulls?state=${encodeURIComponent(state)}&per_page=${perPage}`);
      return textResult(prs.map((pr) => ({ number: pr.number, title: pr.title, state: pr.state, draft: pr.draft, head: pr.head?.ref, base: pr.base?.ref, html_url: pr.html_url })));
    },
  },
  {
    name: 'get_file',
    description: 'Read a small text file from a repository branch or ref.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format.' },
        path: { type: 'string', description: 'File path to read.' },
        ref: { type: 'string', description: 'Optional branch, tag, or SHA.' },
      },
      required: ['repo', 'path'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const safePath = validatePath(args.path);
      const ref = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : '';
      const data = await githubRequest(ctx.githubToken, `/repos/${owner}/${repo}/contents/${encodeURIComponent(safePath).replace(/%2F/g, '/')}${ref}`);
      if (Array.isArray(data) || data.type !== 'file') throw new Error(`Path "${safePath}" is not a file.`);
      const content = data.encoding === 'base64' ? base64DecodeUtf8(data.content) : String(data.content ?? '');
      return textResult({ path: data.path, sha: data.sha, size: data.size, content });
    },
  },
  {
    name: 'list_directory',
    description: 'List files and folders at a repository path.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format.' },
        path: { type: 'string', description: 'Directory path. Empty string means repository root.', default: '' },
        ref: { type: 'string', description: 'Optional branch, tag, or SHA.' },
      },
      required: ['repo'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const safePath = args.path ? validatePath(args.path) : '';
      const encodedPath = safePath ? `/${encodeURIComponent(safePath).replace(/%2F/g, '/')}` : '';
      const ref = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : '';
      const data = await githubRequest(ctx.githubToken, `/repos/${owner}/${repo}/contents${encodedPath}${ref}`);
      if (!Array.isArray(data)) throw new Error(`Path "${safePath}" is not a directory.`);
      return textResult(data.map((item) => ({ name: item.name, path: item.path, type: item.type, size: item.size, html_url: item.html_url })));
    },
  },
  {
    name: 'create_issue',
    description: 'Create a GitHub issue.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format.' },
        title: { type: 'string' },
        body: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
      },
      required: ['repo', 'title'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const data = await githubRequest(ctx.githubToken, `/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        body: JSON.stringify({ title: String(args.title), body: String(args.body ?? ''), labels: Array.isArray(args.labels) ? args.labels : undefined }),
      });
      return textResult({ number: data.number, title: data.title, html_url: data.html_url });
    },
  },
  {
    name: 'create_repository',
    description: 'Create a new GitHub repository for the authenticated user or an organization. Requires ALLOW_REPO_CREATE=true.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        owner: { type: 'string', description: 'Optional org/user owner. Omit to create under authenticated user.' },
        private: { type: 'boolean', default: true },
        description: { type: 'string' },
        auto_init: { type: 'boolean', default: false },
        gitignore_template: { type: 'string', description: 'Optional GitHub gitignore template, e.g. Node.' },
        license_template: { type: 'string', description: 'Optional license template, e.g. mit.' },
      },
      required: ['name'],
    },
    handler: async (args, ctx) => {
      if (!config.allowRepoCreate) {
        throw new Error('Repository creation is disabled. Set ALLOW_REPO_CREATE=true to enable create_repository.');
      }
      const name = validateRepoName(args.name);
      const owner = args.owner ? String(args.owner) : '';
      if (owner && !/^[A-Za-z0-9_.-]+$/.test(owner)) throw new Error('Invalid owner.');
      const endpoint = owner ? `/orgs/${encodeURIComponent(owner)}/repos` : '/user/repos';
      const fullName = owner ? `${owner}/${name}` : null;
      if (fullName && config.allowedRepos.length > 0 && !config.allowedRepos.includes(fullName)) {
        throw new Error(`Repository "${fullName}" is not allowed by ALLOWED_REPOS.`);
      }
      const data = await githubRequest(ctx.githubToken, endpoint, {
        method: 'POST',
        body: JSON.stringify({
          name,
          private: args.private !== false,
          description: args.description ? String(args.description) : undefined,
          auto_init: Boolean(args.auto_init),
          gitignore_template: args.gitignore_template ? String(args.gitignore_template) : undefined,
          license_template: args.license_template ? String(args.license_template) : undefined,
        }),
      });
      return textResult({
        success: true,
        full_name: data.full_name,
        private: data.private,
        default_branch: data.default_branch,
        html_url: data.html_url,
        clone_url: data.clone_url,
      });
    },
  },
  {
    name: 'create_branch',
    description: 'Create a new branch from an existing base branch. New branch must use a safe prefix.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format.' },
        base_branch: { type: 'string', default: 'main' },
        new_branch: { type: 'string', description: 'New branch name, e.g. fix/login-bug.' },
      },
      required: ['repo', 'new_branch'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const base = args.base_branch ?? 'main';
      validateBranch(base, { protect: false });
      validateBranch(args.new_branch, { requirePrefix: true, protect: false });
      const sha = await getBranchSha(ctx.githubToken, owner, repo, base);
      await githubRequest(ctx.githubToken, `/repos/${owner}/${repo}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${args.new_branch}`, sha }),
      });
      return textResult({ success: true, repo: `${owner}/${repo}`, base_branch: base, new_branch: args.new_branch });
    },
  },
  {
    name: 'commit_small_text_files',
    description: 'Commit up to 5 small text files to an existing non-protected branch. Secret-like content and unsafe paths are blocked.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format.' },
        branch: { type: 'string', description: 'Existing target branch. Must not be protected.' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
        },
        commit_message: { type: 'string' },
      },
      required: ['repo', 'branch', 'files', 'commit_message'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      validateBranch(args.branch, { protect: true });
      const files = validateFiles(args.files);
      const commit = await createTreeCommitAndUpdate(ctx.githubToken, owner, repo, args.branch, files, String(args.commit_message));
      return textResult({ success: true, repo: `${owner}/${repo}`, branch: args.branch, files_committed: files.map((file) => file.path), ...commit });
    },
  },
  {
    name: 'create_branch_and_commit',
    description: 'Create a prefixed feature/fix branch from a base branch and commit up to 5 small text files.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format.' },
        base_branch: { type: 'string', default: 'main' },
        new_branch: { type: 'string' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
        },
        commit_message: { type: 'string' },
      },
      required: ['repo', 'new_branch', 'files', 'commit_message'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const base = args.base_branch ?? 'main';
      validateBranch(base, { protect: false });
      validateBranch(args.new_branch, { requirePrefix: true, protect: false });
      const files = validateFiles(args.files);
      const sha = await getBranchSha(ctx.githubToken, owner, repo, base);
      await githubRequest(ctx.githubToken, `/repos/${owner}/${repo}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${args.new_branch}`, sha }),
      });
      const commit = await createTreeCommitAndUpdate(ctx.githubToken, owner, repo, args.new_branch, files, String(args.commit_message));
      return textResult({ success: true, repo: `${owner}/${repo}`, base_branch: base, new_branch: args.new_branch, files_committed: files.map((file) => file.path), ...commit });
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from an existing head branch into a base branch.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format.' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string', description: 'Source/head branch.' },
        base: { type: 'string', description: 'Target/base branch.', default: 'main' },
        draft: { type: 'boolean', default: false },
      },
      required: ['repo', 'title', 'head'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      validateBranch(args.head, { protect: false });
      validateBranch(args.base ?? 'main', { protect: false });
      const pr = await githubRequest(ctx.githubToken, `/repos/${owner}/${repo}/pulls`, {
        method: 'POST',
        body: JSON.stringify({ title: String(args.title), body: String(args.body ?? ''), head: args.head, base: args.base ?? 'main', draft: Boolean(args.draft) }),
      });
      return textResult({ number: pr.number, title: pr.title, html_url: pr.html_url, state: pr.state });
    },
  },
  {
    name: 'get_files_batch',
    description: 'Read multiple text files from one repository ref in a single call.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format.' },
        paths: { type: 'array', items: { type: 'string' } },
        ref: { type: 'string', description: 'Optional branch, tag, or SHA.' },
      },
      required: ['repo', 'paths'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      if (!Array.isArray(args.paths) || args.paths.length === 0) throw new Error('paths must be a non-empty array.');
      if (limitEnabled(config.maxFilesPerCommit) && args.paths.length > Math.max(config.maxFilesPerCommit, 25)) {
        throw new Error(`Too many paths. Max ${Math.max(config.maxFilesPerCommit, 25)}.`);
      }
      const files = [];
      for (const rawPath of args.paths) {
        const path = validatePath(rawPath, { allowBinary: true });
        files.push(await getFileContent(ctx.githubToken, owner, repo, path, args.ref));
      }
      return textResult({ repo: `${owner}/${repo}`, ref: args.ref ?? null, files });
    },
  },
  {
    name: 'list_tree',
    description: 'List repository tree entries for a branch/ref/SHA, optionally recursive.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format.' },
        ref: { type: 'string', default: 'main' },
        recursive: { type: 'boolean', default: true },
      },
      required: ['repo'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const ref = encodeURIComponent(String(args.ref ?? 'main'));
      const recursive = args.recursive === false ? '' : '?recursive=1';
      const data = await githubRequest(ctx.githubToken, `/repos/${owner}/${repo}/git/trees/${ref}${recursive}`);
      return textResult({
        sha: data.sha,
        truncated: Boolean(data.truncated),
        tree: (data.tree ?? []).map((item) => ({ path: item.path, type: item.type, mode: item.mode, size: item.size, sha: item.sha })),
      });
    },
  },
  {
    name: 'compare_refs',
    description: 'Compare two refs and return commits plus changed file summaries.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format.' },
        base: { type: 'string' },
        head: { type: 'string' },
        include_patch: { type: 'boolean', default: false },
      },
      required: ['repo', 'base', 'head'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const data = await githubRequest(ctx.githubToken, `/repos/${owner}/${repo}/compare/${encodeURIComponent(args.base)}...${encodeURIComponent(args.head)}`);
      return textResult({
        status: data.status,
        ahead_by: data.ahead_by,
        behind_by: data.behind_by,
        commits: (data.commits ?? []).map((commit) => ({ sha: commit.sha, message: commit.commit?.message, html_url: commit.html_url })),
        files: (data.files ?? []).map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          ...(args.include_patch ? { patch: file.patch } : {}),
        })),
      });
    },
  },
  {
    name: 'commit_files',
    description: 'Commit many UTF-8 text files in one call, optionally creating a new branch first.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        branch: { type: 'string', description: 'Existing target branch, unless new_branch is set.' },
        base_branch: { type: 'string', default: 'main' },
        new_branch: { type: 'string', description: 'Optional branch to create before committing.' },
        files: {
          type: 'array',
          items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
        },
        commit_message: { type: 'string' },
      },
      required: ['repo', 'files', 'commit_message'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const targetBranch = args.new_branch ? String(args.new_branch) : String(args.branch ?? '');
      if (!targetBranch) throw new Error('branch or new_branch is required.');
      if (args.new_branch) await createBranchRef(ctx.githubToken, owner, repo, args.base_branch ?? 'main', targetBranch);
      validateBranch(targetBranch, { protect: true });
      const files = validateFiles(args.files);
      const treeEntries = await createTreeEntriesForTextFiles(ctx.githubToken, owner, repo, files);
      const commit = await createCommitFromTreeEntries(ctx.githubToken, owner, repo, targetBranch, treeEntries, String(args.commit_message));
      return textResult({ success: true, repo: `${owner}/${repo}`, branch: targetBranch, files_committed: files.map((file) => file.path), ...commit });
    },
  },
  {
    name: 'apply_unified_diff',
    description: 'Apply a unified diff to text files, secret-scan the results, and commit once.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        branch: { type: 'string' },
        diff: { type: 'string' },
        commit_message: { type: 'string' },
      },
      required: ['repo', 'branch', 'diff', 'commit_message'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      validateBranch(args.branch, { protect: true });
      const patches = parseUnifiedDiff(args.diff);
      if (patches.length === 0) throw new Error('No file hunks found in diff.');
      const files = [];
      const treeEntries = [];
      for (const patch of patches) {
        const deleting = patch.newPath === '/dev/null';
        const path = validatePath(deleting ? patch.oldPath : patch.newPath);
        if (deleting) {
          treeEntries.push({ path, mode: '100644', type: 'blob', sha: null });
          continue;
        }
        const existing = patch.oldPath === '/dev/null' ? null : await getFileContentOrNull(ctx.githubToken, owner, repo, path, args.branch);
        files.push({ path, content: applyDiffHunks(existing?.content ?? '', patch.hunks, path) });
      }
      const validated = validateFiles(files);
      treeEntries.push(...await createTreeEntriesForTextFiles(ctx.githubToken, owner, repo, validated));
      const commit = await createCommitFromTreeEntries(ctx.githubToken, owner, repo, args.branch, treeEntries, String(args.commit_message));
      return textResult({ success: true, repo: `${owner}/${repo}`, branch: args.branch, files_changed: treeEntries.map((entry) => entry.path), ...commit });
    },
  },
  {
    name: 'create_branch_commit_pr',
    description: 'Create a branch, commit text files, and open a pull request in one approval-friendly workflow call.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        base_branch: { type: 'string', default: 'main' },
        new_branch: { type: 'string' },
        files: {
          type: 'array',
          items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
        },
        commit_message: { type: 'string' },
        pr_title: { type: 'string' },
        pr_body: { type: 'string' },
        draft: { type: 'boolean', default: false },
      },
      required: ['repo', 'new_branch', 'files', 'commit_message', 'pr_title'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const base = args.base_branch ?? 'main';
      await createBranchRef(ctx.githubToken, owner, repo, base, args.new_branch);
      const files = validateFiles(args.files);
      const treeEntries = await createTreeEntriesForTextFiles(ctx.githubToken, owner, repo, files);
      const commit = await createCommitFromTreeEntries(ctx.githubToken, owner, repo, args.new_branch, treeEntries, String(args.commit_message));
      const pr = await createPullRequest(ctx.githubToken, owner, repo, {
        title: args.pr_title,
        body: args.pr_body,
        head: args.new_branch,
        base,
        draft: args.draft,
      });
      return textResult({ success: true, repo: `${owner}/${repo}`, branch: args.new_branch, files_committed: files.map((file) => file.path), commit, pull_request: pr });
    },
  },
  {
    name: 'commit_zip_archive',
    description: 'Accept one uploaded ZIP file, validate and secret-scan its entries, then commit the complete archive tree to an existing branch in one Git commit.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    _meta: { 'openai/fileParams': ['archive_file'] },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        branch: { type: 'string' },
        archive_file: {
          type: 'object',
          properties: {
            file_id: { type: 'string' },
            download_url: { type: 'string' },
            file_name: { type: 'string' },
            mime_type: { type: 'string' },
          },
          required: ['file_id', 'download_url'],
        },
        commit_message: { type: 'string' },
        expected_head: { type: 'string', description: 'Optional exact branch HEAD required before commit.' },
        expected_file_count: { type: 'number', description: 'Optional exact number of non-directory ZIP entries.' },
      },
      required: ['repo', 'branch', 'archive_file', 'commit_message'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      validateBranch(args.branch, { protect: true });
      const archive = normalizeUploadedArchive(args.archive_file);
      const expectedHead = args.expected_head ? String(args.expected_head) : null;
      if (expectedHead) {
        const currentHead = await getBranchSha(ctx.githubToken, owner, repo, args.branch);
        if (currentHead !== expectedHead) throw new Error(`Branch HEAD mismatch. Expected ${expectedHead}, found ${currentHead}.`);
      }

      let downloaded;
      let extractDir;
      try {
        downloaded = await downloadSourceToTemp(archive.downloadUrl, archive.name);
        extractDir = await mkdtemp(join(tmpdir(), 'purr-github-zip-'));
        const listed = await execFileAsync('unzip', ['-Z1', downloaded.tempPath], {
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024,
        });
        const rawEntries = listed.stdout.split(/\r?\n/).filter(Boolean);
        if (rawEntries.length === 0) throw new Error('ZIP archive is empty.');

        const files = [];
        const seen = new Set();
        for (const rawEntry of rawEntries) {
          const normalized = validateZipEntry(rawEntry);
          if (rawEntry.endsWith('/')) continue;
          const path = validatePath(normalized, { allowBinary: true, allowImages: true });
          if (path !== normalized) throw new Error(`ZIP path "${rawEntry}" changed during normalization.`);
          if (seen.has(path)) throw new Error(`ZIP contains duplicate path "${path}".`);
          seen.add(path);
          files.push({ rawEntry, path });
        }
        if (files.length === 0) throw new Error('ZIP archive contains no files.');
        if (limitEnabled(config.maxFilesPerCommit) && files.length > config.maxFilesPerCommit) {
          throw new Error(`Too many files. Max ${config.maxFilesPerCommit}.`);
        }
        if (args.expected_file_count !== undefined && files.length !== Number(args.expected_file_count)) {
          throw new Error(`ZIP file count mismatch. Expected ${Number(args.expected_file_count)}, found ${files.length}.`);
        }

        await execFileAsync('unzip', ['-qq', downloaded.tempPath, '-d', extractDir], {
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024,
        });

        const extractRoot = `${await realpath(extractDir)}/`;
        const treeEntries = [];
        let totalBytes = 0;
        for (const file of files) {
          const filePath = join(extractDir, file.path);
          const resolved = await realpath(filePath);
          if (!resolved.startsWith(extractRoot)) throw new Error(`ZIP path "${file.path}" escaped the extraction root.`);
          const info = await lstat(filePath);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error(`ZIP path "${file.path}" is not a regular file.`);
          assertLargeFileSize(info.size, file.path);
          totalBytes += info.size;
          if (limitEnabled(config.maxBytesPerCommit) && totalBytes > config.maxBytesPerCommit) {
            throw new Error(`Commit payload is too large. Max ${config.maxBytesPerCommit} bytes.`);
          }
          const sample = await readFileSample(filePath);
          if (!sampleLooksBinary(sample, '')) await scanTextFileForSecrets(filePath, file.path);
          const blob = await createBlobFromFile(ctx.githubToken, owner, repo, filePath);
          treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
        }

        if (expectedHead) {
          const currentHead = await getBranchSha(ctx.githubToken, owner, repo, args.branch);
          if (currentHead !== expectedHead) throw new Error(`Branch HEAD changed during upload. Expected ${expectedHead}, found ${currentHead}.`);
        }
        const commit = await createCommitFromTreeEntries(ctx.githubToken, owner, repo, args.branch, treeEntries, String(args.commit_message));
        return textResult({
          success: true,
          repo: `${owner}/${repo}`,
          branch: args.branch,
          archive: archive.name,
          files_committed: treeEntries.map((entry) => entry.path),
          file_count: treeEntries.length,
          bytes: totalBytes,
          ...commit,
        });
      } finally {
        if (extractDir) await rm(extractDir, { recursive: true, force: true });
        if (downloaded?.tempPath) await rm(downloaded.tempPath, { force: true });
        if (downloaded?.tempDir) await rm(downloaded.tempDir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'commit_files_from_manifest_url',
    description: 'Download a JSON manifest of files/source_url entries and commit all blobs in one call.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        branch: { type: 'string' },
        manifest_url: { type: 'string', description: 'HTTP(S) JSON: {"files":[{"path":"...","source_url":"..."}]}' },
        commit_message: { type: 'string' },
      },
      required: ['repo', 'branch', 'manifest_url', 'commit_message'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      validateBranch(args.branch, { protect: true });
      const manifest = await fetchJsonFromUrl(args.manifest_url);
      const items = manifest?.files;
      if (!Array.isArray(items) || items.length === 0) throw new Error('manifest.files must be a non-empty array.');
      if (limitEnabled(config.maxFilesPerCommit) && items.length > config.maxFilesPerCommit) throw new Error(`Too many files. Max ${config.maxFilesPerCommit}.`);
      const downloads = [];
      let totalBytes = 0;
      try {
        const treeEntries = [];
        for (const item of items) {
          const path = validatePath(item?.path, { allowBinary: config.allowBinary, allowImages: config.allowImages });
          const downloaded = await downloadSourceToTemp(item?.source_url, path);
          downloads.push(downloaded);
          totalBytes += downloaded.bytes;
          if (limitEnabled(config.maxBytesPerCommit) && totalBytes > config.maxBytesPerCommit) throw new Error(`Commit payload is too large. Max ${config.maxBytesPerCommit} bytes.`);
          const isBinary = sampleLooksBinary(downloaded.sample, downloaded.contentType);
          const imageAllowed = config.allowImages && isImagePath(path);
          if (isBinary && !config.allowBinary && !imageAllowed) throw new Error(`File "${path}" looks binary. Set ALLOW_BINARY=true to enable non-image binary commits.`);
          if (!isBinary) await scanTextFileForSecrets(downloaded.tempPath, path);
          const blob = await createBlobFromFile(ctx.githubToken, owner, repo, downloaded.tempPath);
          treeEntries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
        }
        const commit = await createCommitFromTreeEntries(ctx.githubToken, owner, repo, args.branch, treeEntries, String(args.commit_message));
        return textResult({ success: true, repo: `${owner}/${repo}`, branch: args.branch, files_committed: treeEntries.map((entry) => entry.path), bytes: totalBytes, ...commit });
      } finally {
        await Promise.all(downloads.flatMap((item) => [
          rm(item.tempPath, { force: true }),
          rm(item.tempDir, { recursive: true, force: true }),
        ]));
      }
    },
  },
  {
    name: 'update_pull_request',
    description: 'Update pull request title, body, base branch, or open/closed state.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        number: { type: 'number' },
        title: { type: 'string' },
        body: { type: 'string' },
        base: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed'] },
      },
      required: ['repo', 'number'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const data = await githubRequest(ctx.githubToken, `/repos/${owner}/${repo}/pulls/${Number(args.number)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...(args.title ? { title: String(args.title) } : {}),
          ...(args.body !== undefined ? { body: String(args.body) } : {}),
          ...(args.base ? { base: String(args.base) } : {}),
          ...(args.state ? { state: String(args.state) } : {}),
        }),
      });
      return textResult({ number: data.number, title: data.title, state: data.state, html_url: data.html_url });
    },
  },
  {
    name: 'comment_pull_request',
    description: 'Add a top-level conversation comment to a pull request.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        number: { type: 'number' },
        body: { type: 'string' },
      },
      required: ['repo', 'number', 'body'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const data = await githubRequest(ctx.githubToken, `/repos/${owner}/${repo}/issues/${Number(args.number)}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: String(args.body) }),
      });
      return textResult({ id: data.id, html_url: data.html_url });
    },
  },
  {
    name: 'get_verification_plan',
    description: 'Inspect repository metadata and suggest local verification commands without executing code.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        ref: { type: 'string', default: 'main' },
      },
      required: ['repo'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const ref = args.ref ?? 'main';
      const tree = await listRootTree(ctx.githubToken, owner, repo, ref);
      const packageFile = await getFileContentOrNull(ctx.githubToken, owner, repo, 'package.json', ref);
      const pkg = packageFile ? JSON.parse(packageFile.content) : {};
      const packageManager = packageManagerFromFiles(tree);
      return textResult({
        repo: `${owner}/${repo}`,
        ref,
        package_manager: packageManager,
        engines: pkg.engines ?? {},
        scripts: pkg.scripts ?? {},
        recommended_commands: packageFile ? verificationCommands(packageManager, pkg.scripts ?? {}) : [],
        notes: packageFile
          ? 'Run these locally or in a self-hosted runner because this MCP server does not execute shell commands.'
          : 'No package.json found at repository root.',
      });
    },
  },
  {
    name: 'verify_mcp_deploy',
    description: 'Verify a live MCP-over-HTTP endpoint: root, health, initialize, tools/list, and annotation sanity.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Base MCP endpoint URL, e.g. https://host/mcp.' },
        bearer_token: { type: 'string', description: 'Optional token. If omitted, uses a dummy bearer for public passthrough auth checks.' },
      },
      required: ['url'],
    },
    handler: async (args) => {
      const mcpUrl = new URL(String(args.url));
      const rootUrl = new URL('/', mcpUrl);
      const healthUrl = new URL('/health', mcpUrl);
      const token = args.bearer_token ? String(args.bearer_token) : 'mcp-verification-dummy-token';
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const root = await fetch(rootUrl);
      const health = await fetch(healthUrl);
      const init = await fetch(mcpUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      const list = await fetch(mcpUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      const rootBody = await root.text();
      const healthBody = await health.text();
      const initBody = await init.json().catch(async () => ({ raw: await init.text() }));
      const listBody = await list.json().catch(async () => ({ raw: await list.text() }));
      const tools = listBody.result?.tools ?? [];
      const readTools = tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name);
      const writeTools = tools.filter((tool) => tool.annotations?.readOnlyHint === false).map((tool) => tool.name);
      return textResult({
        url: String(mcpUrl),
        root: { status: root.status, ok: root.ok, body_preview: rootBody.slice(0, 500) },
        health: { status: health.status, ok: health.ok, body_preview: healthBody.slice(0, 500) },
        initialize: { status: init.status, ok: init.ok, serverInfo: initBody.result?.serverInfo ?? null },
        tools_list: { status: list.status, ok: list.ok, count: tools.length },
        read_only_tools: readTools,
        write_tools: writeTools,
        annotations_ok: tools.length > 0 && readTools.length > 0,
      });
    },
  },
  {
    name: 'compare_and_verify_pr',
    description: 'Compare base/head refs and suggest verification commands for changed files without running code.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        base: { type: 'string', default: 'main' },
        head: { type: 'string' },
      },
      required: ['repo', 'head'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const base = args.base ?? 'main';
      const compare = await githubRequest(ctx.githubToken, `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(args.head)}`);
      const tree = await listRootTree(ctx.githubToken, owner, repo, args.head);
      const packageFile = await getFileContentOrNull(ctx.githubToken, owner, repo, 'package.json', args.head);
      const pkg = packageFile ? JSON.parse(packageFile.content) : {};
      const packageManager = packageManagerFromFiles(tree);
      const files = (compare.files ?? []).map((file) => file.filename);
      const commands = packageFile ? verificationCommands(packageManager, pkg.scripts ?? {}) : [];
      return textResult({
        repo: `${owner}/${repo}`,
        base,
        head: args.head,
        status: compare.status,
        ahead_by: compare.ahead_by,
        changed_files: files,
        package_manager: packageManager,
        recommended_commands: commands,
        extra_checks: {
          docs_only: files.length > 0 && files.every((file) => file.endsWith('.md') || file.startsWith('docs/')),
          package_changed: files.some((file) => ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'yarn.lock'].includes(file)),
          server_changed: files.some((file) => file.startsWith('src/') || file.startsWith('scripts/')),
        },
      });
    },
  },
  {
    name: 'create_verification_comment',
    description: 'Post a pull request comment with manually supplied verification results.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        number: { type: 'number' },
        summary: { type: 'string' },
        commands: { type: 'array', items: { type: 'string' } },
        results: { type: 'array', items: { type: 'string' } },
      },
      required: ['repo', 'number', 'summary'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      const commands = Array.isArray(args.commands) ? args.commands : [];
      const results = Array.isArray(args.results) ? args.results : [];
      const body = [
        '## Verification',
        '',
        String(args.summary),
        '',
        commands.length ? `Commands:\n${commands.map((cmd) => `- \`${cmd}\``).join('\n')}` : '',
        results.length ? `Results:\n${results.map((item) => `- ${item}`).join('\n')}` : '',
      ].filter(Boolean).join('\n\n');
      const data = await githubRequest(ctx.githubToken, `/repos/${owner}/${repo}/issues/${Number(args.number)}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      return textResult({ id: data.id, html_url: data.html_url });
    },
  },
  {
    name: 'commit_large_file_from_url',
    description: 'Download one large file from source_url server-side, create a Git blob, and commit it to an existing branch. Images are allowed by ALLOW_IMAGES=true; other binary files require ALLOW_BINARY=true.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format.' },
        branch: { type: 'string', description: 'Existing target branch. Protected branches require ALLOW_PROTECTED_WRITES=true.' },
        path: { type: 'string', description: 'Repository file path to create or overwrite.' },
        source_url: { type: 'string', description: 'HTTP(S) URL that the server can download. Avoid giant JSON-RPC payloads.' },
        commit_message: { type: 'string' },
      },
      required: ['repo', 'branch', 'path', 'source_url', 'commit_message'],
    },
    handler: async (args, ctx) => {
      const { owner, repo } = validateRepo(args.repo);
      validateBranch(args.branch, { protect: true });
      const path = validatePath(args.path, { allowBinary: config.allowBinary, allowImages: config.allowImages });
      let downloaded;
      try {
        downloaded = await downloadSourceToTemp(args.source_url, path);
        const isBinary = sampleLooksBinary(downloaded.sample, downloaded.contentType);
        const imageAllowed = config.allowImages && isImagePath(path);
        if (isBinary && !config.allowBinary && !imageAllowed) {
          throw new Error(`File "${path}" looks binary. Set ALLOW_BINARY=true to enable non-image binary large-file commits.`);
        }
        if (!isBinary) await scanTextFileForSecrets(downloaded.tempPath, path);
        const blob = await createBlobFromFile(ctx.githubToken, owner, repo, downloaded.tempPath);
        const commit = await createCommitFromTreeEntries(ctx.githubToken, owner, repo, args.branch, [
          { path, mode: '100644', type: 'blob', sha: blob.sha },
        ], String(args.commit_message));
        return textResult({
          success: true,
          repo: `${owner}/${repo}`,
          branch: args.branch,
          path,
          bytes: downloaded.bytes,
          binary: isBinary,
          github_warning: downloaded.bytes > GITHUB_LARGE_FILE_WARNING_BYTES
            ? 'GitHub warns on blobs larger than 50MB and blocks blobs above 100MB. Use Git LFS if this grows further.'
            : undefined,
          ...commit,
        });
      } finally {
        if (downloaded?.tempPath) await rm(downloaded.tempPath, { force: true });
        if (downloaded?.tempDir) await rm(downloaded.tempDir, { recursive: true, force: true });
      }
    },
  },
  ...extraTools,
];

function toolDefinitions() {
  return tools.map(({ name, description, inputSchema, annotations, _meta }) => ({
    name,
    description,
    inputSchema,
    ...(annotations ? { annotations } : {}),
    ...(_meta ? { _meta } : {}),
  }));
}

async function handleRpc(msg, ctx) {
  if (Array.isArray(msg)) {
    const responses = [];
    for (const item of msg) {
      const response = await handleRpc(item, ctx);
      if (response) responses.push(response);
    }
    return responses;
  }

  const id = msg?.id;
  const method = msg?.method;

  try {
    if (!method) return jsonRpcError(id, -32600, 'Invalid JSON-RPC request. Missing method.');

    if (method === 'initialize') {
      return jsonRpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'purr-github-MCP', version: VERSION },
      });
    }

    if (method === 'notifications/initialized') {
      return null;
    }

    if (method === 'tools/list') {
      return jsonRpcResult(id, { tools: toolDefinitions() });
    }

    if (method === 'tools/call') {
      const toolName = msg?.params?.name;
      const args = msg?.params?.arguments ?? {};
      const tool = tools.find((item) => item.name === toolName);
      if (!tool) return jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
      const result = await tool.handler(args, ctx);
      return jsonRpcResult(id, result);
    }

    return jsonRpcError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    return jsonRpcError(id, -32000, error?.message ?? String(error));
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (url.pathname === '/' && req.method === 'GET') {
    sendJson(res, 200, {
      name: 'purr-github-MCP',
      version: VERSION,
      endpoints: {
        health: 'GET /health',
        mcp: 'POST /mcp',
        sse: 'GET /mcp',
      },
      auth: config.authMode === 'server_token'
        ? 'Authorization: Bearer <SERVER_TOKEN>'
        : 'Authorization: Bearer <GitHub PAT>',
      tools: tools.length,
    });
    return;
  }

  if (url.pathname === '/health' && req.method === 'GET') {
    sendJson(res, 200, {
      status: 'ok',
      name: 'purr-github-MCP',
      version: VERSION,
      auth_mode: config.authMode,
      tools: tools.length,
      sessions: sessions.size,
    });
    return;
  }

  if (url.pathname !== '/mcp') {
    sendJson(res, 404, { error: 'Not found', available_endpoints: ['/', '/health', '/mcp'] });
    return;
  }

  if (req.method === 'GET') {
    const auth = authenticate(req);
    if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });

    const sessionId = randomUUID();
    res.writeHead(200, corsHeaders({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Mcp-Session-Id': sessionId,
    }));

    const session = {
      id: sessionId,
      res,
      githubToken: auth.githubToken,
      keepAlive: setInterval(() => {
        const current = sessions.get(sessionId);
        if (current) sendSse(current, { type: 'ping', ts: new Date().toISOString() });
      }, 15_000),
    };
    sessions.set(sessionId, session);
    res.write(`event: endpoint\ndata: /mcp?sessionId=${sessionId}\n\n`);
    req.on('close', () => closeSession(sessionId));
    return;
  }

  if (req.method === 'DELETE') {
    const sessionId = url.searchParams.get('sessionId') || req.headers['mcp-session-id'];
    if (sessionId) closeSession(String(sessionId));
    sendJson(res, 200, { status: 'closed' });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const auth = authenticate(req);
  if (!auth.ok) return sendJson(res, auth.status, { error: auth.error });

  let body;
  try {
    body = JSON.parse(await readBody(req, config.requestBodyLimit));
  } catch (error) {
    return sendJson(res, 400, { error: error?.message ?? 'Invalid JSON body.' });
  }

  const ctx = { githubToken: auth.githubToken, caller: auth.caller };
  const response = await handleRpc(body, ctx);
  const sessionId = url.searchParams.get('sessionId') || req.headers['mcp-session-id'];
  const session = sessionId ? sessions.get(String(sessionId)) : null;

  if (session && response) {
    sendSse(session, response);
    sendJson(res, 202, { status: 'accepted' }, { 'Mcp-Session-Id': session.id });
    return;
  }

  if (response === null) {
    sendJson(res, 202, { status: 'accepted' });
    return;
  }

  sendJson(res, 200, response, sessionId ? { 'Mcp-Session-Id': String(sessionId) } : {});
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    sendJson(res, 500, { error: error?.message ?? String(error) });
  });
});

server.listen(config.port, config.host, () => {
  console.log(`purr-github-MCP v${VERSION}`);
  console.log(`HTTP server: http://${config.host}:${config.port}`);
  console.log(`Auth mode: ${config.authMode}`);
  console.log(`Tools: ${tools.length}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  for (const id of sessions.keys()) closeSession(id);
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
