# Contributing

PRs are welcome.

## Rules

- Keep the server dependency-light.
- Do not add tools that delete, force-push, merge, or bypass review by default.
- Every write tool must include safety checks.
- Keep docs updated when tools or auth modes change.
- Run `npm run check` before opening a PR.

## Commit style

Use clear conventional prefixes when possible:

```text
feat: add repo health tool
fix: tighten path validation
docs: update Notion setup guide
```
