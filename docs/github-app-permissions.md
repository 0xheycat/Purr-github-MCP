# GitHub App permission matrix for the existing Purr catalog

This matrix covers the complete 40-tool catalog on `feat/pr-lifecycle-pack`. It is an execution map, not a replacement registry.

Higher-level Purr scopes remain:

```text
github.read -> github.plan -> github.write -> github.admin
```

GitHub App repository permissions are additional provider-side requirements. Existing Purr safety gates remain authoritative even when GitHub permits an operation.

| Tool | Purr scope | GitHub API class | Minimum GitHub App permission | Notes |
|---|---|---|---|---|
| `get_authenticated_user` | `github.read` | user identity | user-to-server authorization | Resolve and validate the connected account with `GET /user`. |
| `get_repository` | `github.read` | repository metadata | Metadata: read | Private repository visibility also depends on installation/repository access. |
| `list_issues` | `github.read` | issues | Issues: read | Pull requests returned by the endpoint remain filtered by the existing handler. |
| `list_pull_requests` | `github.read` | pull requests | Pull requests: read | No handler change. |
| `get_pull_request` | `github.read` | pull requests, commits, checks, statuses | Pull requests: read; Contents: read; Checks: read; Commit statuses: read | Method-dependent: PR detail/diff/files/commits/reviews/review threads/requested reviewers use Pull requests: read; combined status uses Commit statuses: read; check runs use Checks: read. |
| `get_file` | `github.read` | contents | Contents: read | Existing unsafe-path checks remain. |
| `list_directory` | `github.read` | contents | Contents: read | Existing repository allow-list remains. |
| `create_issue` | `github.write` | issues | Issues: write | User must also be able to access the selected repository. |
| `create_repository` | `github.admin` | repository administration | Administration: write | Still requires `ALLOW_REPO_CREATE=true`; endpoint support must pass a live GitHub App fixture before production enablement. |
| `create_branch` | `github.write` | git refs | Contents: write | Existing branch-prefix and protected-branch rules remain. |
| `commit_small_text_files` | `github.write` | git data | Contents: write | Existing secret scan, path, and size limits remain. |
| `create_branch_and_commit` | `github.write` | git refs/data | Contents: write | Existing branch policy remains. |
| `create_pull_request` | `github.write` | pull requests | Pull requests: write | Source branch access is separately enforced by GitHub. |
| `get_files_batch` | `github.read` | contents | Contents: read | No new provider scopes inferred from file count. |
| `list_tree` | `github.read` | git trees | Contents: read | Existing ref input remains unchanged. |
| `compare_refs` | `github.read` | commits/compare | Contents: read | Private repository access still depends on installation selection. |
| `commit_files` | `github.write` | git data | Contents: write | Existing safety policy remains. |
| `apply_unified_diff` | `github.write` | contents/git data | Contents: write | Existing patch context checks and secret scan remain. |
| `create_branch_commit_pr` | `github.write` | contents + pull requests | Contents: write; Pull requests: write | Both provider permissions are required. |
| `commit_files_from_manifest_url` | `github.write` | contents/git data | Contents: write | Provider permission does not bypass outbound download and content checks. |
| `update_pull_request` | `github.write` | pull requests | Pull requests: write | Closing/updating remains GitHub-authorized per user. |
| `update_pull_request_draft_state` | `github.write` | pull request GraphQL mutations | Pull requests: write | Converts to draft or marks ready for review; the handler performs a read-before-write no-op check. |
| `request_pull_request_reviewers` | `github.write` | review requests | Pull requests: write | May send reviewer notifications; intentionally not marked idempotent. |
| `update_pull_request_branch` | `github.write` | pull request update branch | Pull requests: write; Contents: write | Merges the current base into the PR head subject to GitHub rules; intentionally not marked idempotent. |
| `comment_pull_request` | `github.write` | issue comments | Issues: write | PR conversation comments use the issues comments endpoint. |
| `get_verification_plan` | `github.plan` | repository contents | Contents: read | Planning remains read-only and does not execute commands. |
| `verify_mcp_deploy` | `github.read` | external HTTP probe | none | No GitHub token should be attached to the target URL unless explicitly supplied by the tool input. |
| `compare_and_verify_pr` | `github.plan` | compare + contents | Contents: read | Planning only. |
| `create_verification_comment` | `github.write` | issue comments | Issues: write | Existing manually supplied verification model remains. |
| `commit_large_file_from_url` | `github.write` | git data | Contents: write | Existing 100 MB Git blob ceiling and binary policy remain. |
| `read_operating_guide` | `github.read` | local constant | none | Must remain available regardless of repository permission. |
| `list_commits` | `github.read` | commits | Contents: read | Existing pagination remains. |
| `get_commit` | `github.read` | commits | Contents: read | Patch output remains unchanged. |
| `list_branches` | `github.read` | branches | Contents: read | Protection visibility depends on GitHub response. |
| `list_pull_request_files` | `github.read` | pull requests | Pull requests: read | Patch output remains unchanged. |
| `search_code` | `github.read` | code search | Contents: read | Search visibility is limited to repositories visible to the connected user/app. |
| `update_file` | `github.write` | contents | Contents: write | Existing protected-branch, path, size, and secret checks remain. |
| `delete_file` | `github.admin` | contents | Contents: write | Purr keeps this tool in `github.admin` because it is destructive. |
| `merge_pull_request` | `github.admin` | pull requests/merge | Pull requests: write; Contents: write | Purr keeps this tool in `github.admin`; branch protection and GitHub rules still apply. |

## Proposed GitHub App repository permissions

Initial full-tool installation profile:

```text
Metadata: read
Contents: read and write
Issues: read and write
Pull requests: read and write
Checks: read
Commit statuses: read
Administration: read and write
```

Checks and Commit statuses are required for `get_pull_request` methods `get_check_runs` and `get_status`. Existing GitHub App installations must approve those added read permissions before private-repository acceptance testing. Administration is required only for `create_repository` and must not weaken `ALLOW_REPO_CREATE`. If GitHub's live user-token endpoint does not permit the expected repository-creation operation, that tool continues to use the legacy owner route until an official supported method is verified. The tool is not removed.

## Account and repository isolation

For every GitHub-user MCP grant:

```text
subject = github:<numeric-user-id>
githubCredentialRef = random opaque reference
```

The credential record must include the numeric GitHub user ID, login snapshot, encrypted access token, encrypted refresh token when supplied, expirations, and lifecycle status. Repository access is never copied into the MCP token; GitHub remains the authority on each API request.

## Parity test

The phase-3 fixture snapshots exact tool names before and after enabling GitHub user auth and fails on any addition, removal, or rename unless separately approved.
