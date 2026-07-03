# 🐾 purr-github-MCP

A lightweight, production-grade [MCP](https://modelcontextprotocol.io) server that connects AI agents (Notion, Claude, custom workflows) to GitHub via a Bearer-authenticated HTTP endpoint.

![Runtime](https://img.shields.io/badge/runtime-Node.js%2022+-3C873A?style=for-the-badge&logo=node.js&logoColor=white)
![MCP](https://img.shields.io/badge/protocol-MCP-7C3AED?style=for-the-badge)
![Auth](https://img.shields.io/badge/auth-Bearer%20Token-111827?style=for-the-badge)
![Deploy](https://img.shields.io/badge/deploy-Manufact-0EA5E9?style=for-the-badge)
![License](https://img.shields.io/badge/license-MIT-F59E0B?style=for-the-badge)

**Quick Start** · **Authentication** · **Notion Setup** · **Manufact Deploy** · **Tools** · **Configuration** · **Roadmap**

---

## Features

- **MCP over HTTP** — single endpoint (`POST /mcp`, `GET /mcp`) compatible with any MCP client.
- **Zero runtime dependencies** — uses Node 22 native `fetch` and `http`. No `bun`, no `@octokit`, no additional frameworks.
- **Two auth modes** — passthrough (client sends its own GitHub PAT) or server-token (proxy with a shared GitHub token).
- **Safe write tools** — branch prefix enforcement, protected branch blocking, file size/content guards.
- **Cloud-native** — ready for Manufact, Fly.io, Railway, or any Node host.

---

## Quick Start

```bash
git clone https://github.com/0xheycat/purr-github-MCP.git
cd purr-github-MCP
cp .env.example .env
npm run check
npm start
```

Server starts on `PORT` or `3000` by default.

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "name": "purr-github-MCP",
  "version": "1.0.0"
}
```

---

## Authentication

### 1. Passthrough — recommended for Notion

The agent sends its own GitHub PAT directly. No shared token lives on the server.

```bash
AUTH_MODE=passthrough
```

```http
Authorization: Bearer github_pat_xxx
```

### 2. Server token

The agent authenticates with a server-side secret; the server proxies with `GITHUB_TOKEN`.

```bash
AUTH_MODE=server_token
SERVER_TOKEN=your-notion-facing-secret
GITHUB_TOKEN=github_pat_xxx
```

```http
Authorization: Bearer your-notion-facing-secret
```

---

## Notion MCP setup

| Field | Value |
|---|---|
| Endpoint | `https://your-host/mcp` |
| Auth type | Bearer Token |
| Token | `github_pat_xxx` |

First smoke test: call `get_authenticated_user`. If it returns your GitHub login, the chain is working.

---

## Manufact deployment

This repo deploys as a standard Node HTTP service.

### Required env

```bash
PORT=3000
HOST=0.0.0.0
AUTH_MODE=passthrough
```

### For server-token mode

```bash
AUTH_MODE=server_token
SERVER_TOKEN=<random-secret>
GITHUB_TOKEN=<github_pat_or_fine_grained_token>
```

### Start

```bash
npm start
```

### Health

```
GET /health
```

### MCP

```
POST /mcp
GET  /mcp
```

Full deployment notes in [`docs/manufact.md`](docs/manufact.md).

---

## Tools

### Read-only

| Tool | Description |
|---|---|
| `get_authenticated_user` | Verify the GitHub account associated with the Bearer token. |
| `get_repository` | Read repository metadata. |
| `list_issues` | List repository issues (excludes PRs). |
| `list_pull_requests` | List pull requests. |
| `get_file` | Read a small text file from a branch or ref. |
| `list_directory` | List files and folders at a repository path. |

### Write

| Tool | Description | Safeguards |
|---|---|---|
| `create_issue` | Create a GitHub issue. | Requires repo access. |
| `create_branch` | Create a feature/fix/docs/etc. branch. | Prefix enforced. |
| `commit_small_text_files` | Commit small text files to an existing branch. | Protected branches blocked. |
| `create_branch_and_commit` | Create a branch and commit text files. | Prefix + file safety enforced. |
| `create_pull_request` | Open a PR from an existing branch. | No direct merge. |

No delete, force-push, workflow editing, secrets management, or direct merge tools are exposed.

---

## Safety model

The server blocks risky operations by default.

### Protected branches

Direct commits to these branches are refused:

```
main, master, production, staging, release
```

Override with:

```bash
PROTECTED_BRANCHES=main,master,production
```

### Branch prefix enforcement

New branches must start with one of:

```
feat/, fix/, docs/, chore/, refactor/, test/, perf/
```

Override with:

```bash
BRANCH_PREFIXES=feat/,fix/,docs/
```

### File-level guards

`commit_small_text_files` and `create_branch_and_commit` enforce:

- Maximum 5 files per commit
- Maximum 50 KB total payload
- Maximum 30 KB per file
- No secret-like tokens or dangerous paths (`.env`, private keys, DB files, archives, PDFs, build output, CI workflow edits). Common image assets are allowed by default; other binary files remain opt-in.

---

## Environment reference

| Variable | Default | Description |
|---|---:|---|
| `PORT` | `3000` | HTTP port. |
| `HOST` | `0.0.0.0` | Bind address. |
| `AUTH_MODE` | `passthrough` | `passthrough` or `server_token`. |
| `SERVER_TOKEN` | empty | Required for `server_token` mode. |
| `GITHUB_TOKEN` | empty | Required for `server_token` mode. |
| `ALLOWED_REPOS` | empty | Optional comma-separated `owner/repo` allowlist. |
| `PROTECTED_BRANCHES` | `main,master,production,staging,release` | Blocks commits to these branches. |
| `BRANCH_PREFIXES` | `feat/,fix/,docs/,chore/,refactor/,test/,perf/` | Required prefixes for new branches. |
| `MAX_FILES_PER_COMMIT` | `5` | Per-commit file limit. |
| `MAX_BYTES_PER_COMMIT` | `50000` | Total payload limit. |
| `MAX_BYTES_PER_FILE` | `30000` | Per-file payload limit. |
| `CORS_ORIGIN` | `*` | CORS origin. Tighten in production. |

---

## Local validation

```bash
npm run check
```

Runs:

1. `node --check src/server.js`
2. `scripts/smoke-test.mjs` — starts a local server, checks `/health`, initializes MCP, and verifies tools list.

---

## Repository structure

```text
purr-github-MCP/
├── src/server.js              # HTTP MCP server
├── scripts/smoke-test.mjs     # Smoke tests
├── docs/
│   ├── manufact.md            # Deployment guide
│   └── notion.md              # Notion integration guide
├── .github/workflows/ci.yml   # CI pipeline
├── .env.example               # Environment template
├── Dockerfile                 # Container build
├── Procfile                   # Process runner hint
├── SECURITY.md
├── CONTRIBUTING.md
├── CHANGELOG.md
└── LICENSE
```

---

## Roadmap

- OAuth flow for multi-user hosted usage
- Richer PR triage tools with CI status summaries
- Issue-to-branch workflow helpers
- Per-tool rate-limit reporting
- Optional repository-level policy configuration

---

## License

MIT — use it, adapt it, ship it.
