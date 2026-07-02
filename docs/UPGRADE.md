# purr-github-MCP - Upgrade: Extended Tools + Large Files

This upgrade wires in the extended tool pack and adds a large-file path that does
not send giant base64 payloads through MCP JSON-RPC.

## Design decision

Chosen strategy: `source_url` ingestion.

The client provides a reachable HTTP(S) URL, then the MCP server downloads the
file server-side into a temporary file, validates size/path/binary policy, scans
text files for secret-like content, and streams a base64 JSON blob body to the
GitHub Git Data API.

| Path | Best for | Request body | Server memory | Limit |
| --- | --- | --- | --- | --- |
| `commit_small_text_files` | normal text edits | inline JSON | buffers request body | env limits |
| `commit_large_file_from_url` | large text or binary files | small JSON with URL | streams via temp file | max 100MB GitHub blob |
| Git LFS | files above 100MB or recurring large binaries | pointer file | external LFS storage | required above GitHub blob cap |

Alternatives considered:

- Chunked/multipart endpoint: useful, but it adds a non-MCP upload lifecycle and
  state cleanup surface. `source_url` is simpler for mcp-use.com and Notion.
- Git LFS pointer flow: correct above 100MB, but GitHub's LFS upload API/auth
  flow is separate from the normal Git Data API. This server documents when LFS
  is required instead of faking support.

GitHub warns on repository blobs larger than 50MB and blocks Git blobs above
100,000,000 bytes. Above that, use Git LFS.

## New and wired tools

Read-only:

- `list_commits`
- `get_commit`
- `list_branches`
- `list_pull_request_files`
- `search_code`
- `get_files_batch`
- `list_tree`
- `compare_refs`
- `get_verification_plan`
- `verify_mcp_deploy`
- `compare_and_verify_pr`

Write:

- `update_file`
- `create_repository`
- `delete_file`
- `merge_pull_request`
- `commit_large_file_from_url`
- `commit_files`
- `apply_unified_diff`
- `create_branch_commit_pr`
- `commit_files_from_manifest_url`
- `update_pull_request`
- `comment_pull_request`
- `create_verification_comment`

All tools now expose MCP `annotations` through `tools/list`. Read tools set
`readOnlyHint:true`. Delete, merge, overwrite, and commit tools set
`destructiveHint:true` where approval should be requested by the client. The
server does not fake read-only hints on write tools.

## Approval-friendly coding workflows

Use these tools to avoid approval prompts per small operation:

- `get_files_batch`: read many files in one read-only call.
- `list_tree`: inspect repository structure in one read-only call.
- `compare_refs`: review branch vs base changes in one read-only call.
- `commit_files`: commit many text files at once, optionally creating a branch.
- `apply_unified_diff`: send one unified diff and commit once.
- `create_branch_commit_pr`: create branch, commit files, and open a PR in one
  write workflow call.
- `commit_files_from_manifest_url`: commit many source-url files from one JSON
  manifest, useful for generated assets.
- `update_pull_request` and `comment_pull_request`: PR housekeeping without
  leaving the MCP flow.
- `get_verification_plan`: inspect package metadata and recommend local commands.
- `verify_mcp_deploy`: live-check root, health, initialize, tools/list, and
  annotation exposure for a deployed MCP URL.
- `compare_and_verify_pr`: compare refs and recommend verification commands when
  GitHub Actions is unavailable.
- `create_verification_comment`: post manual/local verification results back to
  a PR.

Recommended auto-approval policy: auto-approve read-only tools only. Keep write
workflow tools as a single confirmation boundary instead of approving each file.

## Large-file usage

Call `commit_large_file_from_url`:

```json
{
  "repo": "0xheycat/Purr-github-MCP",
  "branch": "feat/assets",
  "path": "assets/demo.zip",
  "source_url": "https://example.com/demo.zip",
  "commit_message": "Add demo asset"
}
```

Rules:

- `source_url` must be `http` or `https` and reachable by the deployed server.
- Binary-looking files require `ALLOW_BINARY=true`.
- Text files are still secret-scanned before GitHub upload.
- The server stores the download in a temporary file and removes it after the
  commit attempt.
- GitHub still receives base64 JSON, because that is how the Git blob API works,
  but the body is streamed from disk instead of built as one huge in-memory
  string.

## Environment variables

`0` or empty disables the server-side limit where noted.

```bash
# Auth
AUTH_MODE=passthrough
SERVER_TOKEN=
GITHUB_TOKEN=

# Scope
ALLOWED_REPOS=0xheycat/Purr-github-MCP

# Request and GitHub endpoints
REQUEST_BODY_LIMIT=1000000
GITHUB_API_BASE=https://api.github.com

# Branch/path safety
PROTECTED_BRANCHES=main,master,production,staging,release
BRANCH_PREFIXES=feat/,fix/,docs/,chore/,refactor/,test/,perf/
ALLOW_PROTECTED_WRITES=false
ALLOW_WORKFLOW_WRITES=false
ALLOW_REPO_CREATE=false

# Commit limits
MAX_FILES_PER_COMMIT=5
MAX_BYTES_PER_COMMIT=100000000
MAX_BYTES_PER_FILE=100000000

# Binary large files
ALLOW_BINARY=true
```

For mcp-use.com large-file deploys, keep `REQUEST_BODY_LIMIT` small unless you
also need inline text commits above 1MB. Prefer `source_url` for large files:

```bash
REQUEST_BODY_LIMIT=1000000
MAX_BYTES_PER_FILE=100000000
MAX_BYTES_PER_COMMIT=100000000
MAX_FILES_PER_COMMIT=0
ALLOW_BINARY=true
PROTECTED_BRANCHES=main,master,production,staging,release
BRANCH_PREFIXES=feat/,fix/,docs/,chore/,refactor/,test/,perf/
ALLOW_PROTECTED_WRITES=false
ALLOW_WORKFLOW_WRITES=false
ALLOW_REPO_CREATE=false
GITHUB_API_BASE=https://api.github.com
```

## Migration / deploy

1. Deploy this branch or merge the PR.
2. Set the mcp-use.com environment variables above.
3. Redeploy/restart the mcp-use.com service.
4. Reconnect the MCP connection in Notion so it refreshes `tools/list` and sees
   the new annotations.
5. Use `commit_large_file_from_url` for large files instead of embedding file
   content in JSON-RPC.

## Validation

Run:

```bash
npm run check
```

The smoke test starts local mock GitHub and source servers and verifies:

- `tools/list` exposes annotations.
- text secret scanning still blocks a secret-like payload.
- an inline JSON-RPC commit above 1MB works when `REQUEST_BODY_LIMIT` is raised.
- the 80MB `source_url` large-file path reaches the mock GitHub blob endpoint.
