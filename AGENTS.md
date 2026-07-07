# AGENTS.md

## Scope

These instructions apply to agents working in this repository and to any ChatGPT/Codex-style workflow that uses this MCP server.

## Role of this server

Purr GitHub MCP is for GitHub repository operations only:

- inspect repositories, branches, commits, issues, pull requests, and files
- create branches, commits, PRs, comments, and small text-file updates
- never run install/build/lint/test commands here
- use Purr Verify MCP for runtime verification
- use Notion only for specs, plans, and project context

## Startup protocol

Before repository work:

1. Call `read_operating_guide`.
2. Confirm which repository, branch, and goal the user wants.
3. Read the relevant files before modifying anything.
4. Summarize the intended patch before write operations.
5. Use Verify MCP for build/test validation after changes.

## Hard rules

- Do not commit secrets, tokens, private keys, `.env` files, lockfile churn, generated build output, or dependency folders.
- Do not write directly to protected branches unless the server explicitly allows it.
- Do not create repositories unless `ALLOW_REPO_CREATE=true` is configured.
- Do not edit GitHub Actions workflows unless `ALLOW_WORKFLOW_WRITES=true` is configured.
- Do not run verification commands through this server.
- Do not retry failed write tools in a loop. Stop and report the exact tool, input summary, and error.
- Keep logs and diffs summarized unless the user asks for full details.

## Preferred workflow

1. Inspect: `get_repository`, `list_tree`, `get_files_batch`, `compare_refs`, or PR tools.
2. Plan: summarize target files and exact intended changes.
3. Change: create a feature/fix branch and commit small text files.
4. Verify: use Purr Verify MCP in async mode for install/build/lint/test.
5. Report: summarize commits, PRs, verification status, and remaining risks.
