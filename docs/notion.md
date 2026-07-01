# Notion Setup

## Endpoint

Use your deployed MCP URL:

```text
https://your-app.manufact.app/mcp
```

## Authentication

Choose Bearer token auth.

### Recommended: passthrough mode

Server env:

```bash
AUTH_MODE=passthrough
```

Notion token value:

```text
github_pat_xxx
```

The GitHub PAT should have only the minimum scopes needed:

- read-only repo inspection: repository read permissions,
- issue creation: issues read/write,
- PR creation / branch commits: contents read/write + pull requests read/write.

### Alternative: server-token mode

Server env:

```bash
AUTH_MODE=server_token
SERVER_TOKEN=<random-notion-facing-secret>
GITHUB_TOKEN=<github_pat_xxx>
```

Notion token value:

```text
<random-notion-facing-secret>
```

## First test

Call:

```text
get_authenticated_user
```

Expected output:

```json
{
  "login": "0xheycat",
  "id": 123,
  "name": "...",
  "html_url": "https://github.com/0xheycat"
}
```
