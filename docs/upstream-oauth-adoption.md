# Upstream OAuth adoption plan

## Goal

Reuse maintained provider code and test behavior while preserving Purr's working MCP implementation.

## Source-to-Purr mapping

| Maintained source | Behavior adopted | Purr destination |
|---|---|---|
| GitHub MCP `internal/oauth/flow.go` | random state, PKCE preference, fail-closed callback handling, bounded flow | `src/github-auth/service.js` and callback tests |
| GitHub MCP `internal/oauth/manager.go` | one in-flight identity flow per authorization request, cancellation, refresh-aware token source | durable Purr records plus Octokit calls |
| GitHub MCP `internal/oauth/callback.go` | exact state validation, bounded callback response, safe success/error page | `src/github-auth/http.js` |
| GitHub MCP `pkg/http/oauth/oauth.go` | OAuth route separation and structured provider errors | existing Purr OAuth router plus GitHub callback routes |
| GitHub MCP token middleware | one resolved token in request context | Purr proxy credential resolver |
| `@octokit/oauth-app` | GitHub App authorization URL, code exchange, user Octokit, token refresh and lifecycle events | `src/github-auth/octokit.js` |
| `@octokit/webhooks` | signature verification and lifecycle dispatch | `src/github-auth/webhooks.js` |

## Deliberately not adopted

- GitHub MCP's Go tool registry
- stdio loopback callback server
- device flow for the ChatGPT-hosted web authorization path
- in-memory-only token storage
- GitHub MCP tool filtering rules
- any replacement for Purr branch, path, secret, binary, or size policy

## Hosted flow differences

The official GitHub MCP OAuth document describes a local stdio client. Purr is a hosted authorization server, so it uses one fixed HTTPS callback under Purr's origin rather than a loopback callback. The security properties retained are random one-time state, expiration, callback binding, code replay rejection, provider token validation, and refresh handling.

## Provider abstraction

The Purr adapter exposes only these operations:

```text
begin({ transactionId, state, redirectUrl }) -> authorizationUrl
exchange({ code, state }) -> providerCredential
refresh(providerCredential) -> providerCredential
resolveUser(providerCredential) -> { id, login }
revoke(providerCredential) -> void
```

No tool imports Octokit. Tool handlers continue receiving only `ctx.githubToken` from the existing upstream authentication context.

## Required runtime configuration

```text
GITHUB_APP_CLIENT_ID
GITHUB_APP_CLIENT_SECRET
GITHUB_APP_CALLBACK_URL
GITHUB_APP_WEBHOOK_SECRET
```

Optional configuration is introduced only when required by a verified feature:

```text
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY
```

The client secret, webhook secret, private key, access tokens, and refresh tokens remain server-side. Configuration validation must fail before the public listener starts when GitHub user authentication is enabled but incomplete.

## Test sources

Port behavior, not source code, from maintained tests:

- invalid and mismatched state
- expired transaction
- callback replay
- provider denial
- code exchange failure
- identity lookup failure
- encrypted persistence and restart
- automatic refresh persistence
- concurrent refresh serialization
- revoked authorization
- user A/user B credential isolation
- complete tool-name parity
- legacy `SERVER_TOKEN` regression
