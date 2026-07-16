# ChatGPT OAuth for Purr GitHub MCP

This OAuth layer sits in front of the existing Purr GitHub MCP server. It does not replace the current GitHub tools, catalog, safety checks, transport, or execution logic.

The existing `SERVER_TOKEN` and passthrough authentication paths remain supported. A direct valid `SERVER_TOKEN` keeps full legacy access, so installed non-OAuth clients are not forced through the new scope model.

## What the OAuth layer adds

- OAuth 2.1 authorization code flow with mandatory PKCE S256
- persistent dynamic client registration
- opaque access and refresh tokens
- one-time authorization codes stored only by SHA-256 digest
- atomic authorization-code consumption and refresh-token rotation
- durable JSON storage with an exclusive lock, compare-and-set revisions, fsync, and atomic rename
- AES-256-GCM encrypted grant records
- signed, HTTP-only consent cookies
- bounded outbound catalog reads with timeout and redirect rejection
- scope-filtered `tools/list` and scope enforcement before `tools/call`
- compatibility validation for short-lived JWTs issued by the previous OAuth wrapper

## Scope hierarchy

The scopes are hierarchical:

```text
github.read -> github.plan -> github.write -> github.admin
```

A higher scope includes every lower scope.

| Scope | Typical access |
|---|---|
| `github.read` | repository, branch, issue, PR, commit, tree, and file reads |
| `github.plan` | read access plus verification planning tools |
| `github.write` | branch, commit, issue, PR, comment, and other normal write tools |
| `github.admin` | all tools, including repository creation, merge, and delete operations |

Tool scope is derived from its existing annotations. Read-only tools default to `github.read`; other tools default to `github.write`. Only the small plan/admin override sets need special classification. New normally annotated tools do not require changes to the OAuth service.

For compatibility with the previous ChatGPT configuration:

```text
read:user -> github.read
user:email -> github.read
repo -> github.admin
```

The broad legacy `repo` request remains full-access so an already configured ChatGPT client does not silently lose tools after deployment. New clients should request the canonical `github.*` scopes.

## Endpoints

Protected-resource discovery:

```text
GET /.well-known/oauth-protected-resource
GET /.well-known/oauth-protected-resource/mcp
```

Authorization-server discovery:

```text
GET /.well-known/oauth-authorization-server
GET /.well-known/openid-configuration
```

OAuth endpoints:

```text
GET  /oauth/authorize
POST /oauth/authorize/confirm
POST /oauth/token
POST /oauth/register
POST /oauth/revoke
```

Legacy aliases remain available:

```text
/authorize
/token
/register
/revoke
```

## Required production environment

The existing MCP server-token setup remains required for OAuth proxying:

```bash
AUTH_MODE=server_token
SERVER_TOKEN=<existing-private-server-token>
GITHUB_TOKEN=<existing-private-github-token>
```

OAuth configuration:

```bash
PUBLIC_BASE_URL=https://mcp.pursr.xyz
OAUTH_RESOURCE_URL=https://mcp.pursr.xyz/mcp
OAUTH_ISSUER=https://auth-git.pursr.xyz
OAUTH_AUTHORIZATION_SERVERS=https://auth-git.pursr.xyz

OAUTH_CLIENT_ID=chatgpt-purr-git
OAUTH_ALLOWED_REDIRECT_URIS=<exact-callback-url-shown-by-chatgpt>
OAUTH_OWNER_CODE=<private-browser-approval-code>
OAUTH_SUBJECT=0xheycat

OAUTH_TOKEN_TTL_SECONDS=3600
OAUTH_REFRESH_TOKEN_TTL_SECONDS=2592000
OAUTH_STORE_PATH=/var/lib/purr-github-mcp/oauth-store.json
```

`OAUTH_STORE_PATH` must point to a persistent volume in production. Its parent directory is created automatically. The store file is created with mode `0600`.

Encryption and cookie keys may be supplied explicitly as base64-encoded 32-byte values:

```bash
OAUTH_ENCRYPTION_KEY=<base64-32-byte-key>
OAUTH_COOKIE_KEY=<base64-32-byte-key>
```

When omitted, separate keys are derived from `OAUTH_SECRET_SOURCE`, then `OAUTH_JWT_SECRET`, then the existing `SERVER_TOKEN`. Explicit independent keys are recommended for production key management.

## ChatGPT setup

Use:

```text
Name: MCP github
Server URL: https://mcp.pursr.xyz/mcp
Authentication: OAuth
```

Recommended OAuth settings:

```text
Registration method: Dynamic Client Registration
Token endpoint auth method: none
Scopes: github.admin
```

A narrower client can request `github.read`, `github.plan`, or `github.write` instead.

The static client still works when needed:

```text
OAuth Client ID: chatgpt-purr-git
OAuth Client Secret: empty
Token endpoint auth method: none
```

## Runtime flow

1. ChatGPT reads protected-resource metadata.
2. ChatGPT discovers the authorization server.
3. ChatGPT registers a public client or uses the configured static client.
4. `/oauth/authorize` validates the exact redirect URI, resource, scope, and PKCE challenge.
5. The authorization request is persisted and bound to a signed HTTP-only cookie.
6. The owner approves once with `OAUTH_OWNER_CODE`.
7. The request is consumed and the one-time code is created in one compare-and-set transaction.
8. `/oauth/token` verifies PKCE, consumes the code, and creates encrypted access and refresh grants atomically.
9. OAuth calls are proxied to the unchanged MCP server with the existing `SERVER_TOKEN` only after scope checks pass.
10. Refresh exchanges consume the old refresh token and create the replacement refresh token plus access token in one atomic transaction.

## Verification

Run:

```bash
npm run check
```

The OAuth tests cover:

- PKCE and one-time authorization-code use
- replay rejection
- atomic concurrent refresh rotation
- durable authentication after store restart
- no raw code, access token, refresh token, or owner code in the store
- scope hierarchy and tool classification
- timeout, response-size bounding, and redirect rejection
- full wrapper integration with filtered `tools/list`
- denial of insufficient-scope `tools/call`
- unchanged direct `SERVER_TOKEN` access
