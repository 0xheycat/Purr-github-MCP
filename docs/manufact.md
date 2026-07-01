# Deploying purr-github-MCP on Manufact

This project is prepared as a simple Node 22 HTTP service.

## 1. Push the repo to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/0xheycat/purr-github-MCP.git
git push -u origin main
```

## 2. Create a Manufact deployment

Use the GitHub repository as the source.

Runtime:

```text
Node.js 22+
```

Start command:

```bash
npm start
```

Health check:

```text
/health
```

## 3. Environment variables

Recommended for Notion personal workflow:

```bash
PORT=3000
HOST=0.0.0.0
AUTH_MODE=passthrough
```

Stricter hosted mode:

```bash
PORT=3000
HOST=0.0.0.0
AUTH_MODE=server_token
SERVER_TOKEN=<random-secret-for-notion>
GITHUB_TOKEN=<github_pat_xxx>
```

Optional safety settings:

```bash
ALLOWED_REPOS=0xheycat/purr-github-MCP
PROTECTED_BRANCHES=main,master,production,staging,release
BRANCH_PREFIXES=feat/,fix/,docs/,chore/,refactor/,test/,perf/
```

## 4. Verify deployment

```bash
curl https://your-manufact-url/health
```

Then test MCP:

```bash
curl -s https://your-manufact-url/mcp \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## 5. Connect Notion

MCP URL:

```text
https://your-manufact-url/mcp
```

Auth type:

```text
Bearer Token
```
