# Purr GitHub MCP — Bounded Public RC Execution Plan

Status: **G1 IN PROGRESS**  
Final terminal phase: **G4**  
Scope rule: no G5, no repeated final audit, and no speculative platform expansion.

## Product target

Ship a public, professional GitHub MCP that users connect to through GitHub App authorization and MCP OAuth. Public users must not paste GitHub PATs, `SERVER_TOKEN`, owner codes, bearer tokens, or GitHub credentials into the UI. Existing GitHub tools remain the product surface and should be maximized rather than replaced by a larger platform.

Normal developer work must be governed by GitHub App installation scope, GitHub permissions, branch protection, tenant ownership, explicit MCP mutation annotations, auditability, and GitHub API responses. Static beginner-oriented blocks must not prevent legitimate workflow, lockfile, infrastructure, deployment, branch, or repository operations when GitHub permits them.

## Explicit non-goals

The public RC does not include GitLab, Bitbucket, custom git hosting, billing, enterprise RBAC, an AI review engine, a browser code editor, project management, a CI runner, artifact hosting, a GitHub replacement UI, a marketplace, or speculative tool proliferation.

## Phase G1 — Public auth foundation

Goal: replace the current single-owner credential bridge with a real public identity and repository-installation boundary while preserving an explicitly separate self-hosted compatibility mode.

Ordered atomic items:

1. ✅ Enforce exact OAuth redirect URI matching. The implicit `https://chatgpt.com/connector/oauth/` prefix fallback is removed and exact configured or dynamically registered URIs have regression coverage.
2. ✅ Add a hosted versus self-hosted deployment-mode boundary. Startup now fails closed unless `DEPLOYMENT_MODE` is explicitly `hosted` or `self-hosted`; hosted mode requires complete HTTPS OAuth configuration and distinct signing/upstream credential material, while explicit self-hosted mode preserves legacy token compatibility. Regression coverage runs in `npm run check`.
3. ✅ Replace owner-code authorization and global `OAUTH_SUBJECT` with authenticated GitHub user sessions. Hosted `/authorize` now requires the signed GitHub session, stores immutable GitHub identity on authorization codes, derives access-token identity from that code, and omits the owner-code field/check while explicit self-hosted compatibility remains intact. Regression coverage runs in `npm run check`.
4. Add GitHub App sign-in and installation selection.
5. Persist users, sessions, OAuth clients, authorization codes, refresh-token families, installations, and selected repositories.
6. Mint GitHub installation tokens just in time and never expose them to MCP clients or logs.
7. Implement MCP OAuth authorization code plus PKCE, short-lived access tokens, refresh rotation, revocation, and logout.
8. Remove hosted-default PAT passthrough, GitHub PAT as MCP bearer, global `SERVER_TOKEN` translation, and token query parameters.
9. Add selected-private-repository, nonselected-repository denial, credential-redaction, and cross-user isolation tests.

G1 acceptance gate:

- browser GitHub login passes;
- GitHub App installation and repository selection pass;
- MCP OAuth connection passes;
- selected private repository read passes;
- nonselected and uninstalled repositories are denied;
- no GitHub credential is exposed to MCP clients or logs;
- no PAT or owner-code field exists in the hosted public UI;
- legacy token mode is available only under explicit self-hosted configuration.

## Phase G2 — GitHub capabilities instead of artificial guards

Goal: remove static blocks that prevent legitimate developer work while preserving real authorization boundaries.

Ordered atomic items:

1. Inventory every static path, extension, branch-prefix, repository-creation, workflow, lockfile, Terraform, Kubernetes, deployment, archive, and database-file restriction.
2. Replace each artificial restriction with GitHub permission, installation-scope, branch-protection, and explicit mutation-semantics handling.
3. Keep `readOnlyHint` and `destructiveHint` accurate for every tool.
4. Add positive fixture tests for workflow, lockfile, Terraform, Kubernetes, deployment, branch, and authorized repository-creation operations.
5. Add negative tests proving branch protection, GitHub permission denial, uninstalled repository denial, cross-user denial, credential protection, and upstream-host validation remain enforced.

G2 acceptance gate:

- workflow, lockfile, Terraform, and Kubernetes writes pass when GitHub permits them;
- protected branch behavior matches GitHub without bypass;
- repository creation passes when authorized;
- no static branch-prefix rule remains;
- no hidden mutation or permission bypass exists.

## Phase G3 — Maximize and verify the existing tool set

Goal: preserve the current tool surface and make every existing tool reliable, consistent, and testable.

Ordered atomic items:

1. Generate a canonical inventory of every exposed tool, schema, annotation, and mutation class.
2. Build a dedicated fixture repository and bounded integration harness.
3. Invoke 100% of exposed tools across success, permission failure, pagination, rate limit, stale SHA, no-op, and validation paths.
4. Normalize request IDs, structured GitHub errors, rate-limit metadata, retry hints, pagination cursors, exact mutation results, head SHA reporting, stale-SHA recovery guidance, and explicit no-op detection.
5. Add only connection-status tools that are strictly necessary for public operation and unavailable through the current surface.

G3 acceptance gate:

- every exposed tool is invoked by the fixture suite;
- read and authorized mutation tools pass;
- no tool silently no-ops or falsely reports mutation;
- failures are actionable;
- existing names and schemas remain compatible unless a documented security correction requires a bounded change.

## Phase G4 — Public UI, operational cleanup, and RC closure

Goal: expose only the minimal public product surface and close unsafe operational shortcuts.

Ordered atomic items:

1. Provide Landing, Continue with GitHub, Install GitHub App, Repositories, MCP Connection, Permissions, Active Sessions, optional API Keys, Audit Activity, and Documentation.
2. Keep `/health` public and minimal.
3. Remove or restrict `/debug` and `/debug/errors` to administrator access.
4. Remove the global `http.createServer` monkey patch and use explicit structured request and error logging.
5. Complete public onboarding, self-hosted compatibility documentation, deployment configuration, and release closure.
6. Run the final auth, OAuth, all-tool fixture, repository isolation, redaction, typecheck, lint, test, build, and onboarding gates.

G4 acceptance gate:

- GitHub App and MCP OAuth pass;
- all-tool fixture passes;
- selected public/private repository access and cross-user isolation pass;
- token redaction passes;
- typecheck, lint, tests, and build pass;
- onboarding passes;
- no PAT or owner-code public UI remains;
- no public debug leak remains.

When all gates pass, record `PUBLIC_RC=ACCEPTED`, freeze scope, and stop implementation. There is no G5.

## Per-run execution contract

Each run performs one bounded atomic item plus directly related test fixes and verification. Every mutation must be based on the exact current head. Commits remain small, phase-labelled, and resumable. Pull requests remain draft and are never merged without owner approval.

Transient failures receive at most four bounded retries in the same run. The same permanent blocker on three consecutive runs becomes `NEEDS_OWNER_ACTION`; mutation stops for that blocker instead of looping.

## Current next item

**G1.4 — Add GitHub App sign-in and installation selection, beginning with the bounded login/callback route and signed user-session creation.**
