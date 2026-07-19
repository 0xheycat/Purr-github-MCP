import assert from 'node:assert/strict';
import {
  GITHUB_MCP_APP_MIME_TYPE,
  GITHUB_MCP_APP_URI,
  GITHUB_MCP_OUTPUT_SCHEMA,
  decorateGithubInitialize,
  decorateGithubToolResult,
  decorateGithubTools,
  listGithubMcpAppResources,
  readGithubMcpAppResource,
} from '../src/mcp-app.js';

const initialized = decorateGithubInitialize({
  protocolVersion: '2024-11-05',
  capabilities: { tools: {} },
});
assert.deepEqual(initialized.capabilities, {
  tools: {},
  resources: { listChanged: false },
});

const tools = decorateGithubTools([
  { name: 'get_repository', inputSchema: { type: 'object' } },
  { name: 'read_operating_guide', inputSchema: { type: 'object' } },
]);
assert.deepEqual(tools[0].outputSchema, GITHUB_MCP_OUTPUT_SCHEMA);
assert.deepEqual(tools[1].outputSchema, GITHUB_MCP_OUTPUT_SCHEMA);
assert.deepEqual(tools[0]._meta, {
  ui: { resourceUri: GITHUB_MCP_APP_URI, visibility: ['model'] },
  'openai/outputTemplate': GITHUB_MCP_APP_URI,
});
assert.equal(tools[1]._meta, undefined);

const result = decorateGithubToolResult('compare_refs', {
  content: [{ type: 'text', text: JSON.stringify({ status: 'ahead', additions: 12 }) }],
});
assert.deepEqual(result.structuredContent, {
  kind: 'purr-github-card',
  tool: 'compare_refs',
  status: 'ahead',
  isError: false,
  payload: { status: 'ahead', additions: 12 },
});
assert.deepEqual(result._meta, {
  tool: 'compare_refs',
  card: { kind: 'purr-github-card', tool: 'compare_refs' },
});

const helperResult = decorateGithubToolResult('read_operating_guide', {
  content: [{ type: 'text', text: JSON.stringify({ service: 'github' }) }],
});
assert.deepEqual(helperResult.structuredContent, {
  kind: 'purr-github-card',
  tool: 'read_operating_guide',
  status: 'ready',
  isError: false,
  payload: { service: 'github' },
});

const resources = listGithubMcpAppResources();
assert.equal(resources.length, 1);
assert.equal(resources[0].uri, GITHUB_MCP_APP_URI);
assert.equal(resources[0].mimeType, GITHUB_MCP_APP_MIME_TYPE);

const resource = readGithubMcpAppResource(GITHUB_MCP_APP_URI);
assert.equal(resource.contents[0].mimeType, GITHUB_MCP_APP_MIME_TYPE);
assert.match(resource.contents[0].text, /Purr GitHub Workbench/);
assert.match(resource.contents[0].text, /window\.openai\?\.toolOutput/);
assert.match(resource.contents[0].text, /openai:set_globals/);
assert.match(resource.contents[0].text, /ui\/notifications\/tool-result/);
assert.doesNotMatch(resource.contents[0].text, /cdn\.jsdelivr\.net|@modelcontextprotocol\/ext-apps/);
assert.equal(resource.contents[0]._meta.ui.csp, undefined);
assert.equal(readGithubMcpAppResource('ui://missing'), null);

console.log('MCP App UI tests passed');
