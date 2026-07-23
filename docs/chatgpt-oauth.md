# ChatGPT + GitHub user OAuth

Purr GitHub MCP keeps the existing GitHub tool server unchanged and places an OAuth and credential-routing layer in front of it.

The public flow is:

```text
ChatGPT
  -> Purr OAuth 2.1 + PKCE
  -> GitHub App browser authorization
  -> encrypted GitHub user credential
  -> existing Purr GitHub MCP tools
  -> GitHub API as the authorized user
```

`src/server.js`, its tool registry, handlers, safety guards, protected-branch policy, secret scanning, payload limits, and repository controls are not replaced.

## Compatibility model

Two credential routes remain available:

```text
ChatGPT OAuth user
  -> GitHub credential reference
  -> encrypted user-to-server token
  -> existing tools

Valid legacy SERVER_TOKEN
  -> existing owner GITHUB_TOKEN
  -> existing tools
```

The internal MCP child process binds only to loopback and runs in passthrough mode. `SERVER_TOKEN` and `GITHUB_TOKEN` are removed from its environment. The public wrapper is therefore the only component allowed to select and inject a GitHub credential.

The tool catalog remains complete when the client requests `github.admin`. Current smoke coverage requires all 35 tools to remain present.

## Maintained upstream components

The implementation follows the browser OAuth and callback patterns from the official `github/github-mcp-server` project.

Node integration uses maintained Octokit packages:

```text
@octokit/oauth-app
@octokit/webhooks
```

Octokit handles GitHub authorization URLs, code exchange, user authentication, token refresh, token revocation, and signed webhook verification. Purr-specific code is limited to binding the GitHub identity to the ChatGPT OAuth transaction, encrypted persistence, credential selection, and compatibility routing.

## MCP scopes

Purr scopes are hierarchical:

```text
github.read -> github.plan -> github.write -> github.admin
```

| Scope | Access |
|---|---|
| `github.read` | repository, branch, issue, PR, commit, tree, and file reads |
| `github.plan` | read access plus verification planning tools |
| `github.write` | branch, commit, issue, PR, comment, and normal write tools |
| `github.admin` | all tools, including repository creation, merge, and delete operations |

Legacy aliases remain accepted:

```text
read:user -> github.read
user:email -> github.read
repo -> github.admin
```

GitHub permissions and Purr scopes are separate gates. A tool call succeeds only when both permit it, together with the existing Purr safety policy.

## Public endpoints

Discovery:

```text
GET /.well-known/oauth-protected-resource
GET /.well-known/oauth-protected-resource/mcp
GET /.well-known/oauth-authorization-server
GET /.well-known/openid-configuration
```

ChatGPT OAuth:

```text
GET  /oauth/authorize
POST /oauth/authorize/confirm
POST /oauth/token
POST /oauth/register
POST /oauth/revoke
```

GitHub App integration:

```text
GET  /oauth/github/callback
POST /oauth/github/webhooks
```

The owner-code consent form remains only as a compatibility fallback when GitHub App OAuth is not configured. When all GitHub App variables are present, `/oauth/authorize` redirects directly to GitHub.

## GitHub App setup

Create a GitHub App owned by the intended organization or account.

Configure:

```text
Callback URL: https://<public-host>/oauth/github/callback
Webhook URL:  https://<public-host>/oauth/github/webhooks
Webhook secret: required
Expiring user authorization tokens: enabled
```

Subscribe to these lifecycle events:

```text
github_app_authorization
installation
installation_repositories
```

The exact GitHub App permission matrix for all current tools is documented in `docs/github-app-permissions.md`.

## Required production environment

Existing compatibility credentials:

```bash
SERVER_TOKEN=<existing-private-mcp-token>
GITHUB_TOKEN=<existing-owner-github-token>
```

Public OAuth configuration:

```bash
PUBLIC_BASE_URL=https://<public-host>
OAUTH_RESOURCE_URL=https://<public-host>/mcp
OAUTH_ISSUER=https://<authorization-host>
OAUTH_AUTHORIZATION_SERVERS=https://<authorization-host>

OAUTH_CLIENT_ID=chatgpt-purr-git
OAUTH_ALLOWED_REDIRECT_URIS=<exact-chatgpt-callback>
OAUTH_TOKEN_TTL_SECONDS=3600
OAUTH_REFRESH_TOKEN_TTL_SECONDS=2592000
OAUTH_STORE_PATH=/var/lib/purr-github-mcp/oauth-store.json
```

GitHub App configuration:

```bash
GITHUB_APP_CLIENT_ID=<github-app-client-id>
GITHUB_APP_CLIENT_SECRET=<github-app-client-secret>
GITHUB_APP_CALLBACK_URL=https://<public-host>/oauth/github/callback
GITHUB_APP_WEBHOOK_SECRET=<github-app-webhook-secret>
```

All three OAuth App values and the webhook secret are required together. Partial GitHub App configuration fails at startup instead of falling back silently.

Recommended independent encryption keys:

```bash
OAUTH_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
OAUTH_COOKIE_KEY=<base64-encoded-32-byte-key>
OAUTH_SECRET_SOURCE=<independent-secret-source>
```

`OAUTH_STORE_PATH` must be on a persistent volume. The store uses an exclusive lock, revision compare-and-set, fsync, atomic rename, and file mode `0600`.

## Runtime behavior

1. ChatGPT discovers Purr's OAuth server and starts authorization with PKCE S256.
2. Purr persists the outer OAuth transaction and binds it to a signed HTTP-only cookie.
3. Purr creates a one-time GitHub state record and redirects the browser to GitHub.
4. Octokit exchanges the GitHub callback code and reads the authenticated GitHub identity.
5. The raw GitHub access and refresh tokens are encrypted with AES-256-GCM.
6. The ChatGPT authorization code is bound to a credential reference, not to a raw GitHub token.
7. ChatGPT receives opaque Purr access and refresh tokens.
8. For every OAuth `tools/call`, the wrapper resolves the bound GitHub credential and injects it into the unchanged internal MCP server.
9. Legacy `SERVER_TOKEN` requests continue to use the owner GitHub credential.
10. Expiring GitHub tokens are refreshed through a durable single-flight lease so concurrent requests do not rotate the same refresh token twice.
11. A signed `github_app_authorization.revoked` webhook marks every credential for that GitHub user revoked.
12. Installation lifecycle events are persisted for operational visibility and repository-access changes.

## Security properties

- GitHub tokens never enter ChatGPT access tokens, browser cookies, logs, or MCP responses.
- Raw ChatGPT authorization codes and tokens are stored only by SHA-256 identifier.
- GitHub credentials are encrypted with an identity-specific authenticated-encryption context.
- User A's credential reference cannot resolve User B's credential.
- Callback state and signed-cookie binding prevent transaction swapping and replay.
- Refresh rotation is single-flight across concurrent server processes using the durable store.
- Webhooks require Octokit signature verification before any credential state changes.
- Internal credential-bearing MCP traffic is loopback-only.
- Existing protected-branch, secret-scanning, and write-safety gates remain active.

## Verification

Run:

```bash
npm run check
```

The suite covers:

- ChatGPT PKCE and one-time authorization codes
- MCP refresh-token atomic rotation
- GitHub callback state binding and replay rejection
- encrypted GitHub credential persistence
- two-user credential isolation
- user-token versus owner-token routing
- single-flight GitHub token refresh
- signed revocation and credential invalidation
- installation lifecycle recording
- legacy `SERVER_TOKEN` compatibility
- scope-filtered catalog and dispatch
- 35-tool catalog parity
- large commit handling, annotations, and secret blocking

## Deployment order

1. Create the GitHub App and configure callback, webhook, permissions, and events.
2. Provision the persistent OAuth store volume and independent encryption keys.
3. Add GitHub App environment variables without removing the existing owner credentials.
4. Deploy the wrapper branch.
5. Confirm health and OAuth metadata.
6. Complete one browser authorization from ChatGPT.
7. Verify `get_authenticated_user` returns the GitHub account that authorized the app.
8. Verify one read tool and one bounded write tool.
9. Confirm all 35 tools remain listed with `github.admin`.
10. Revoke a test authorization and confirm subsequent calls are rejected.

Rollback is configuration-safe: remove the GitHub App variables and redeploy to return to the existing owner-code OAuth fallback while preserving the legacy `SERVER_TOKEN` route. Do not delete the persistent OAuth store during rollback.
