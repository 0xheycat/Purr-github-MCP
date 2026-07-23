# 🐾 Purr GitHub MCP

A Node.js MCP server that connects ChatGPT, Notion, and other agents to GitHub through a guarded HTTP tool layer.

![Runtime](https://img.shields.io/badge/runtime-Node.js%2022+-3C873A?style=for-the-badge&logo=node.js&logoColor=white)
![MCP](https://img.shields.io/badge/protocol-MCP-7C3AED?style=for-the-badge)
![Auth](https://img.shields.io/badge/auth-OAuth%20%2B%20Bearer-111827?style=for-the-badge)
![Deploy](https://img.shields.io/badge/deploy-Manufact-0EA5E9?style=for-the-badge)
![License](https://img.shields.io/badge/license-MIT-F59E0B?style=for-the-badge)

## What it provides

- MCP over HTTP at `POST /mcp`.
- ChatGPT OAuth 2.1 authorization-code flow with mandatory PKCE S256.
- GitHub App browser login for per-user GitHub credentials.
- Legacy Bearer and owner-token compatibility routes.
- 40 GitHub tools with the existing safety policies preserved, including pull request lifecycle, checks, review threads, reviewer requests, and branch updates.
- Durable encrypted OAuth and GitHub credential storage.
- Refresh-token rotation, single-flight GitHub refresh, and signed revocation webhooks.
- Protected-branch, repository allowlist, payload, path, and secret-scanning guards.

The GitHub tool registry and handlers remain in `src/server.js`. OAuth, user identity, and credential selection are implemented by the public wrapper without rewriting those tools.

## Architecture

```text
ChatGPT
  -> Purr OAuth + PKCE
  -> GitHub App browser authorization
  -> encrypted GitHub user credential reference
  -> public credential router
  -> loopback-only existing MCP server
  -> GitHub API as that user
```

Compatibility access remains available:

```text
valid SERVER_TOKEN
  -> existing owner GITHUB_TOKEN
  -> existing tools
```

The internal MCP child runs only on loopback. The public wrapper removes the owner credentials from the child environment and injects the correct GitHub credential per request.

## Maintained upstream components

The GitHub login design follows the official `github/github-mcp-server` OAuth patterns.

Runtime integration uses maintained Octokit packages:

```text
@octokit/oauth-app
@octokit/webhooks
```

Octokit handles GitHub authorization URLs, code exchange, refresh, revocation, and webhook signature verification.

## Quick start

```bash
git clone https://github.com/0xheycat/Purr-github-MCP.git
cd Purr-github-MCP
npm install
npm run check
npm start
```

The public server starts on `PORT`, default `3000`.

```bash
curl http://localhost:3000/health
```

## Authentication modes

### ChatGPT OAuth with GitHub user login

Configure the public OAuth server and a GitHub App. ChatGPT connects to:

```text
https://<public-host>/mcp
```

Requested Purr scopes are hierarchical:

```text
github.read -> github.plan -> github.write -> github.admin
```

A client requesting `github.admin` receives the complete current tool catalog. GitHub's own user and GitHub App permissions are enforced again when a tool executes.

See [`docs/chatgpt-oauth.md`](docs/chatgpt-oauth.md).

### Legacy owner route

```bash
SERVER_TOKEN=<private-mcp-token>
GITHUB_TOKEN=<owner-github-token>
```

A direct valid `SERVER_TOKEN` continues to use the owner GitHub credential and receives the existing full catalog.

### Direct passthrough clients

The bare server still supports direct GitHub Bearer credentials for trusted internal or local integrations. The hosted OAuth wrapper itself controls access to its loopback child.

## GitHub App endpoints

```text
GET  /oauth/github/callback
POST /oauth/github/webhooks
```

Required GitHub App events:

```text
github_app_authorization
installation
installation_repositories
```

The full permission matrix for the current tools is in [`docs/github-app-permissions.md`](docs/github-app-permissions.md).

## Core production environment

```bash
PORT=3000
HOST=0.0.0.0

SERVER_TOKEN=<existing-private-mcp-token>
GITHUB_TOKEN=<existing-owner-github-token>

PUBLIC_BASE_URL=https://<public-host>
OAUTH_RESOURCE_URL=https://<public-host>/mcp
OAUTH_ISSUER=https://<authorization-host>
OAUTH_AUTHORIZATION_SERVERS=https://<authorization-host>
OAUTH_CLIENT_ID=chatgpt-purr-git
OAUTH_ALLOWED_REDIRECT_URIS=<exact-chatgpt-callback>
OAUTH_STORE_PATH=/var/lib/purr-github-mcp/oauth-store.json

GITHUB_APP_CLIENT_ID=<github-app-client-id>
GITHUB_APP_CLIENT_SECRET=<github-app-client-secret>
GITHUB_APP_CALLBACK_URL=https://<public-host>/oauth/github/callback
GITHUB_APP_WEBHOOK_SECRET=<github-app-webhook-secret>
```

Use a persistent volume for `OAUTH_STORE_PATH`. Independent encryption and cookie keys are recommended:

```bash
OAUTH_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
OAUTH_COOKIE_KEY=<base64-encoded-32-byte-key>
OAUTH_SECRET_SOURCE=<independent-secret-source>
```

Partial GitHub App configuration fails at startup rather than silently downgrading.

## Safety model

Existing controls apply regardless of whether a request uses the owner credential or a GitHub user credential.

### Protected branches

Direct commits are blocked by default on:

```text
main, master, production, staging, release
```

### Branch prefixes

New branches must use an approved prefix such as:

```text
feat/, fix/, docs/, chore/, refactor/, test/, perf/
```

### Write guards

Write tools enforce repository policy, file-count and byte limits, dangerous-path blocking, secret-like content detection, and operation-specific controls. Large and binary writes remain available only through the bounded tools intended for them.

## Verification

```bash
npm run check
```

The suite covers:

- ChatGPT PKCE and refresh rotation
- GitHub callback binding and replay rejection
- encrypted user credentials and user isolation
- user-token versus owner-token routing
- concurrent GitHub refresh serialization
- signed authorization revocation
- installation lifecycle tracking
- scope-filtered tool dispatch
- legacy compatibility
- 40-tool smoke parity
- large commits, annotations, and secret blocking

## Deployment

Docker:

```bash
docker build -t purr-github-mcp .
docker run --rm -p 3000:3000 --env-file .env purr-github-mcp
```

Manufact and process-runner deployments use:

```bash
npm install --omit=dev
npm start
```

See [`docs/manufact.md`](docs/manufact.md) for deployment and [`docs/chatgpt-oauth.md`](docs/chatgpt-oauth.md) for GitHub App setup, acceptance checks, and rollback.

## Repository structure

```text
Purr-github-MCP/
├── src/server.js                 # existing GitHub MCP tools and guards
├── src/oauth-wrapper.js          # public OAuth and routing entrypoint
├── src/oauth/                    # durable ChatGPT OAuth primitives
├── src/github-auth/              # GitHub App identity and lifecycle adapter
├── scripts/                      # OAuth, routing, lifecycle, and smoke tests
├── docs/                         # architecture, permissions, and deployment
├── Dockerfile
├── Procfile
└── package.json
```

## License

MIT
