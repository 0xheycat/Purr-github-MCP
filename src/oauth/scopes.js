export const OAUTH_SCOPES = Object.freeze([
  'github.read',
  'github.plan',
  'github.write',
  'github.admin',
]);

const RANK = new Map(OAUTH_SCOPES.map((scope, index) => [scope, index]));
const LEGACY_SCOPE_ALIASES = new Map([
  ['read:user', 'github.read'],
  ['user:email', 'github.read'],
  // The original ChatGPT setup requested GitHub's broad `repo` scope.
  // Preserve that installed-client behavior as full MCP access.
  ['repo', 'github.admin'],
]);
const PLAN_TOOLS = new Set(['get_verification_plan', 'compare_and_verify_pr']);
const ADMIN_TOOLS = new Set(['create_repository', 'merge_pull_request', 'delete_file']);

export function normalizeRequestedScopes(raw) {
  const requested = String(raw ?? '').split(/\s+/).filter(Boolean);
  const values = requested.length === 0 ? ['github.read'] : requested;
  const canonical = values.map((scope) => LEGACY_SCOPE_ALIASES.get(scope) ?? scope);
  if (canonical.some((scope) => !RANK.has(scope))) throw new Error('unsupported_scope');
  return Object.freeze([...new Set(canonical)].sort((a, b) => RANK.get(a) - RANK.get(b)));
}

export function scopeAllows(granted, required) {
  const requiredRank = RANK.get(required);
  if (requiredRank === undefined) return false;
  return granted.some((scope) => (RANK.get(scope) ?? -1) >= requiredRank);
}

export function requiredScopeForTool(tool) {
  if (OAUTH_SCOPES.includes(tool?.oauthScope)) return tool.oauthScope;
  if (ADMIN_TOOLS.has(tool?.name)) return 'github.admin';
  if (PLAN_TOOLS.has(tool?.name)) return 'github.plan';
  return tool?.annotations?.readOnlyHint === true ? 'github.read' : 'github.write';
}

export function securitySchemesForTool(tool) {
  return Object.freeze([{ type: 'oauth2', scopes: [requiredScopeForTool(tool)] }]);
}
