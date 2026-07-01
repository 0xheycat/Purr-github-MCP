# Security Policy

## Token handling

Do not commit `.env`, GitHub PATs, Notion tokens, private keys, or generated credentials.

The default `passthrough` mode uses the caller's `Authorization: Bearer <GitHub PAT>` as the GitHub token for that request. Use fine-grained GitHub tokens with the minimum permissions required.

## Dangerous operations

This server intentionally does not expose delete-file, merge-PR, force-push, workflow-editing, secret-writing, or infrastructure-editing tools.

## Safe-write limits

Small text commits are limited by file count, total bytes, per-file bytes, path policy, binary-content checks, and secret-like content checks.

## Reporting issues

Open a private issue or contact the maintainer before publishing security-sensitive details.
