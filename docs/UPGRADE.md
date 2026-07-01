# purr-github-MCP - Upgrade: Extended Tools + Unlimited Config

This upgrade adds an extended tool pack (`src/extensions.js`) and documents how to
remove push limits via environment variables. No existing behavior changes until you
wire in the new tools and redeploy.

## 1. Wire in the extended tools

Edit `src/server.js`:

```js
// near the other imports at the top
import { extraTools } from './extensions.js';

// where `const tools = [ ... ]` ends, append the extra tools:
const tools = [
  // ...all existing tool objects...
  ...extraTools,
];
```

Optional: expose annotations in `tools/list` so read-only tools can be
auto-approved by clients:

```js
function toolDefinitions() {
  return tools.map(({ name, description, inputSchema, annotations }) => ({
    name, description, inputSchema, ...(annotations ? { annotations } : {}),
  }));
}
```

## 2. New tools

Read-only (safe to auto-approve):
- `list_commits` - commit history for a branch/ref, optional path filter
- `get_commit` - single commit with changed files + patch
- `list_branches` - branches + protection flag
- `list_pull_request_files` - PR diff (files, patch, status)
- `search_code` - code search within the repo

Write:
- `update_file` - create/update one text file (needs sha to replace)
- `delete_file` - delete a file (needs sha)
- `merge_pull_request` - merge a PR (merge/squash/rebase)

## 3. Remove push limits (env only, no code change)

Set these on your host (for example the deploy env), then redeploy:

```bash
PROTECTED_BRANCHES=          # empty = allow direct commits to any branch
BRANCH_PREFIXES=             # empty = any branch name allowed
MAX_FILES_PER_COMMIT=100
MAX_BYTES_PER_COMMIT=1000000
MAX_BYTES_PER_FILE=1000000
ALLOW_PROTECTED_WRITES=true  # let extended write tools touch protected branches
```

## 4. Hard cap that still needs a code change

`readBody()` in `src/server.js` caps each HTTP request at ~1 MB:

```js
function readBody(req, limitBytes = 1_000_000) {
```

Raise `limitBytes` (for example `10_000_000`) if you need larger single pushes.

## 5. Kept ON by design - secret scanning

`containsSecretLikeContent()` stays enabled. Because this repo is public, committing
secrets would leak them to everyone. The extended write tools reuse the same guard.
Leave it on.

## 6. Auto-approval (client side)

Auto-approval is a client setting, not server code. In Notion, open the MCP
connection settings and choose which tools run without confirmation. The
`readOnlyHint` annotations above help clients auto-approve read-only tools.
