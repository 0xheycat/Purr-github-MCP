# Deploying Purr GitHub MCP on Manufact

Purr runs as a Node 22 HTTP service. The default `npm start` command launches the public OAuth wrapper and the existing MCP tool server behind it.

## Runtime

```text
Node.js 22+
```

Build command:

```bash
npm install --omit=dev
```

Start command:

```bash
npm start
```

Health check:

```text
/health
```

## Existing compatibility mode

The current owner connection remains supported:

```bash
PORT=3000
HOST=0.0.0.0
SERVER_TOKEN=<existing-private-mcp-token>
GITHUB_TOKEN=<existing-owner-github-token>
```

The wrapper uses the owner GitHub credential for direct valid `SERVER_TOKEN` requests. The internal MCP child binds only to loopback and does not receive either credential in its environment.

## ChatGPT OAuth

```bash
PUBLIC_BASE_URL=https://<public-host>
OAUTH_RESOURCE_URL=https://<public-host>/mcp
OAUTH_ISSUER=https://<authorization-host>
OAUTH_AUTHORIZATION_SERVERS=https://<authorization-host>
OAUTH_CLIENT_ID=chatgpt-purr-git
OAUTH_ALLOWED_REDIRECT_URIS=<exact-chatgpt-callback>
OAUTH_STORE_PATH=/var/lib/purr-github-mcp/oauth-store.json
OAUTH_TOKEN_TTL_SECONDS=3600
OAUTH_REFRESH_TOKEN_TTL_SECONDS=2592000
```

The OAuth store must be on a persistent volume.

Recommended independent keys:

```bash
OAUTH_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
OAUTH_COOKIE_KEY=<base64-encoded-32-byte-key>
OAUTH_SECRET_SOURCE=<independent-secret-source>
```

## GitHub App user login

Configure the GitHub App with:

```text
Callback URL: https://<public-host>/oauth/github/callback
Webhook URL:  https://<public-host>/oauth/github/webhooks
```

Runtime variables:

```bash
GITHUB_APP_CLIENT_ID=<github-app-client-id>
GITHUB_APP_CLIENT_SECRET=<github-app-client-secret>
GITHUB_APP_CALLBACK_URL=https://<public-host>/oauth/github/callback
GITHUB_APP_WEBHOOK_SECRET=<github-app-webhook-secret>
```

The GitHub App variables must be provided as a complete set. Partial configuration fails at startup.

Subscribe to:

```text
github_app_authorization
installation
installation_repositories
```

## Optional safety settings

```bash
ALLOWED_REPOS=0xheycat/Purr-github-MCP
PROTECTED_BRANCHES=main,master,production,staging,release
BRANCH_PREFIXES=feat/,fix/,docs/,chore/,refactor/,test/,perf/
```

These controls remain active for both owner and user-specific credentials.

## Verification

After deployment:

```bash
curl https://<public-host>/health
curl https://<public-host>/.well-known/oauth-protected-resource
curl https://<authorization-host>/.well-known/oauth-authorization-server
```

Then connect ChatGPT with:

```text
MCP URL: https://<public-host>/mcp
Authentication: OAuth
Scope: github.admin
```

Acceptance checks:

1. GitHub browser login completes.
2. `get_authenticated_user` returns the account that authorized the GitHub App.
3. All 35 tools remain listed for `github.admin`.
4. A read call and a bounded write call use the authorized user's GitHub identity.
5. The existing `SERVER_TOKEN` route still uses the owner identity.
6. Revoking the GitHub App authorization causes subsequent OAuth calls to fail.

Full setup and rollback details are in `docs/chatgpt-oauth.md`.
