# ChatGPT OAuth / Remote MCP Setup

This repo can serve both sides needed for ChatGPT OAuth MCP usage:

```txt
mcp.pursr.xyz      -> MCP resource server
auth-git.pursr.xyz -> OAuth authorization server
```

No separate OAuth repo is required. Deploy this same codebase behind both domains, or route both domains to the same running app.

## Public MCP endpoints

```txt
POST /mcp
GET  /mcp
GET  /.well-known/oauth-protected-resource
GET  /.well-known/oauth-protected-resource/mcp
```

For `https://mcp.pursr.xyz/mcp`, the protected resource metadata URL is:

```txt
https://mcp.pursr.xyz/.well-known/oauth-protected-resource/mcp
```

## Public OAuth endpoints

```txt
GET  /.well-known/oauth-authorization-server
GET  /.well-known/openid-configuration
GET  /authorize
POST /authorize
POST /token
POST /register
GET  /jwks.json
```

For `https://auth-git.pursr.xyz`, the authorization server metadata URL is:

```txt
https://auth-git.pursr.xyz/.well-known/oauth-authorization-server
```

## Production env for `mcp.pursr.xyz`

```bash
AUTH_MODE=server_token
SERVER_TOKEN=<long-random-server-token>
GITHUB_TOKEN=<github-pat-or-fine-grained-token>

PUBLIC_BASE_URL=https://mcp.pursr.xyz
OAUTH_RESOURCE_URL=https://mcp.pursr.xyz/mcp
OAUTH_AUTHORIZATION_SERVERS=https://auth-git.pursr.xyz
OAUTH_RESOURCE_NAME="Purr GitHub MCP"
OAUTH_REALM=purr-github-mcp
OAUTH_SCOPES_SUPPORTED="repo read:user user:email"

OAUTH_ISSUER=https://auth-git.pursr.xyz
OAUTH_CLIENT_ID=chatgpt-purr-git
OAUTH_OWNER_CODE=<private-approval-code-you-type-in-browser>
OAUTH_JWT_SECRET=<long-random-jwt-secret-shared-with-auth-domain>
OAUTH_TOKEN_TTL_SECONDS=3600

ALLOW_PROTECTED_WRITES=false
ALLOW_REPO_CREATE=false
ALLOW_WORKFLOW_WRITES=false
ALLOW_BINARY=false
ALLOW_IMAGES=true
```

## Production env for `auth-git.pursr.xyz`

Use the same repo and same start command. The important auth env is:

```bash
AUTH_MODE=server_token
SERVER_TOKEN=<same-long-random-server-token-as-mcp>
GITHUB_TOKEN=<same-github-token-or-empty-if-only-auth-domain>

PUBLIC_BASE_URL=https://mcp.pursr.xyz
OAUTH_RESOURCE_URL=https://mcp.pursr.xyz/mcp
OAUTH_AUTHORIZATION_SERVERS=https://auth-git.pursr.xyz

OAUTH_ISSUER=https://auth-git.pursr.xyz
OAUTH_CLIENT_ID=chatgpt-purr-git
OAUTH_ALLOWED_REDIRECT_URIS=<chatgpt-callback-url-from-the-new-app-screen>
OAUTH_OWNER_CODE=<private-approval-code-you-type-in-browser>
OAUTH_JWT_SECRET=<same-long-random-jwt-secret-as-mcp>
OAUTH_TOKEN_TTL_SECONDS=3600
OAUTH_SUBJECT=0xheycat
```

If both domains route to the same process, one env set is enough as long as it includes all values above.

## ChatGPT New App setup

Use:

```txt
Name: MCP github
Server URL: https://mcp.pursr.xyz/mcp
Authentication: OAuth
```

Advanced OAuth settings:

```txt
Registration method: User-Defined OAuth Client
OAuth Client ID: chatgpt-purr-git
OAuth Client Secret: empty
Token endpoint auth method: none
Scopes: repo read:user user:email
```

Copy the callback URL shown by ChatGPT and put it into:

```bash
OAUTH_ALLOWED_REDIRECT_URIS=<callback-url>
```

Then redeploy before clicking Create or Connect.

## Runtime flow

1. ChatGPT reads `https://mcp.pursr.xyz/.well-known/oauth-protected-resource/mcp`.
2. The MCP metadata points to `https://auth-git.pursr.xyz`.
3. ChatGPT starts OAuth authorization code + PKCE.
4. `/authorize` shows a small owner approval page.
5. Enter `OAUTH_OWNER_CODE`.
6. `/token` returns a short-lived bearer token.
7. ChatGPT calls `/mcp` with that token.
8. The wrapper validates the token and proxies to the upstream MCP server with `SERVER_TOKEN`.

## Test commands

```powershell
Invoke-RestMethod "https://mcp.pursr.xyz/.well-known/oauth-protected-resource/mcp" | ConvertTo-Json -Depth 10
```

```powershell
Invoke-RestMethod "https://auth-git.pursr.xyz/.well-known/oauth-authorization-server" | ConvertTo-Json -Depth 10
```

Expected MCP metadata should include:

```json
{
  "resource": "https://mcp.pursr.xyz/mcp",
  "authorization_servers": ["https://auth-git.pursr.xyz"]
}
```

Expected auth metadata should include:

```json
{
  "issuer": "https://auth-git.pursr.xyz",
  "authorization_endpoint": "https://auth-git.pursr.xyz/authorize",
  "token_endpoint": "https://auth-git.pursr.xyz/token",
  "registration_endpoint": "https://auth-git.pursr.xyz/register",
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"]
}
```

## Security notes

- Keep write tools behind ChatGPT-side approval.
- Keep `ALLOW_REPO_CREATE=false`, `ALLOW_PROTECTED_WRITES=false`, and `ALLOW_WORKFLOW_WRITES=false` unless explicitly needed.
- Keep `OAUTH_OWNER_CODE`, `SERVER_TOKEN`, `GITHUB_TOKEN`, and `OAUTH_JWT_SECRET` private.
- Use long random values from `openssl rand -hex 32`.
