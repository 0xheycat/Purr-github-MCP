# ChatGPT OAuth / Remote MCP Setup

This deployment keeps the existing Bearer-token MCP behavior and adds OAuth protected-resource discovery so ChatGPT Apps and other remote MCP clients can discover how to authenticate.

## Public endpoints

```txt
POST /mcp
GET  /mcp
GET  /.well-known/oauth-protected-resource
GET  /.well-known/oauth-protected-resource/mcp
```

For `https://mcp.pursr.xyz/mcp`, the protected resource metadata URL should be:

```txt
https://mcp.pursr.xyz/.well-known/oauth-protected-resource/mcp
```

## Required production env

```bash
PUBLIC_BASE_URL=https://mcp.pursr.xyz
OAUTH_RESOURCE_URL=https://mcp.pursr.xyz/mcp
OAUTH_RESOURCE_NAME="Purr GitHub MCP"
OAUTH_REALM=purr-github-mcp
OAUTH_SCOPES_SUPPORTED=repo,read:user,user:email
```

## OAuth authorization server

Set this when you have an OAuth issuer that can mint access tokens accepted by this server:

```bash
OAUTH_AUTHORIZATION_SERVERS=https://auth.pursr.xyz
```

Until a real authorization server is deployed, clients can still call the MCP endpoint with the existing bearer modes:

```bash
AUTH_MODE=passthrough
# Authorization: Bearer <GitHub PAT>
```

or:

```bash
AUTH_MODE=server_token
SERVER_TOKEN=<client-facing-secret>
GITHUB_TOKEN=<github_pat_or_fine_grained_token>
# Authorization: Bearer <SERVER_TOKEN>
```

## ChatGPT connector target

Use this as the MCP server URL:

```txt
https://mcp.pursr.xyz/mcp
```

If ChatGPT asks for OAuth, it should discover the metadata endpoint above. If it only supports bearer-token setup in your environment, use the existing Authorization bearer mode.

## Security notes

- Keep write tools behind client-side approval.
- Prefer `AUTH_MODE=server_token` for a single trusted ChatGPT connector install.
- Prefer a real OAuth authorization server for multi-user public installs.
- Keep `ALLOW_REPO_CREATE=false` and `ALLOW_WORKFLOW_WRITES=false` unless explicitly needed.
