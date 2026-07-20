// Purr GitHub MCP App compatibility layer.
//
// Adapted from the MIT-licensed MCP App resource and host-context patterns in:
// https://github.com/Waishnav/devspace
// Repository operations, authentication, and write policy remain owned by
// Purr GitHub MCP; this module only adds resources and structured UI cards.

export const GITHUB_MCP_APP_URI = 'ui://purr/github-workbench-v3.html';
export const GITHUB_MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
export const GITHUB_MCP_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'tool', 'status', 'isError', 'payload'],
  properties: {
    kind: { type: 'string', const: 'purr-github-card' },
    tool: { type: 'string', minLength: 1 },
    status: { type: 'string', minLength: 1 },
    isError: { type: 'boolean' },
    payload: {},
  },
});

export function githubMcpAppToolMeta(toolName) {
  if (!toolName) return undefined;
  return {
    ui: {
      resourceUri: GITHUB_MCP_APP_URI,
      visibility: ['model'],
    },
    'openai/outputTemplate': GITHUB_MCP_APP_URI,
  };
}

export function decorateGithubInitialize(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const capabilities = objectRecord(result.capabilities);
  return {
    ...result,
    capabilities: {
      ...capabilities,
      resources: { listChanged: false },
    },
  };
}

export function decorateGithubTools(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool;
    const meta = githubMcpAppToolMeta(tool.name);
    return {
      ...tool,
      outputSchema: GITHUB_MCP_OUTPUT_SCHEMA,
      ...(meta
        ? {
            _meta: {
              ...objectRecord(tool._meta),
              ...meta,
            },
          }
        : {}),
    };
  });
}

export function decorateGithubToolResult(tool, result) {
  if (!tool || !result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }
  const payload = extractPayload(result);
  const isError = result.isError === true;
  return {
    ...result,
    structuredContent: {
      kind: 'purr-github-card',
      tool,
      status: inferStatus(tool, payload, isError),
      isError,
      payload,
    },
    _meta: {
      ...objectRecord(result._meta),
      tool,
      card: {
        kind: 'purr-github-card',
        tool,
      },
    },
  };
}

export function listGithubMcpAppResources() {
  return [
    {
      uri: GITHUB_MCP_APP_URI,
      name: 'purr-github-workbench',
      title: 'Purr GitHub Workbench',
      description:
        'Interactive repository, tree, file, diff, commit, issue, and pull request cards for Purr GitHub MCP.',
      mimeType: GITHUB_MCP_APP_MIME_TYPE,
    },
  ];
}

export function readGithubMcpAppResource(uri) {
  if (uri !== GITHUB_MCP_APP_URI) return null;
  return {
    contents: [
      {
        uri: GITHUB_MCP_APP_URI,
        mimeType: GITHUB_MCP_APP_MIME_TYPE,
        text: githubMcpAppHtml(),
        _meta: {
          ui: {
            prefersBorder: true,
          },
        },
      },
    ],
  };
}

function objectRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function extractPayload(result) {
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (!Array.isArray(result.content)) return result;
  const text = result.content
    .filter((entry) => entry && typeof entry === 'object' && entry.type === 'text')
    .map((entry) => typeof entry.text === 'string' ? entry.text : '')
    .filter(Boolean)
    .join('\n');
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function inferStatus(tool, payload, isError) {
  if (isError) return 'failed';
  const explicit = findString(payload, ['status', 'state', 'mergeable_state']);
  if (explicit) return explicit;
  if (/create|commit|update|delete|merge|comment|apply/i.test(tool)) return 'completed';
  return 'ready';
}

function findString(value, keys, depth = 0) {
  if (depth > 4 || !value || typeof value !== 'object') return undefined;
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  for (const key of ['data', 'repository', 'pull_request', 'commit', 'result']) {
    const found = findString(value[key], keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function githubMcpAppHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Purr GitHub Workbench</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        --card: color-mix(in srgb, Canvas 95%, CanvasText 5%);
        --border: color-mix(in srgb, CanvasText 16%, transparent);
        --muted: color-mix(in srgb, CanvasText 62%, transparent);
        --soft: color-mix(in srgb, CanvasText 7%, transparent);
        --ok: #22c55e;
        --warn: #f59e0b;
        --bad: #ef4444;
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; background: transparent; color: CanvasText; }
      body { padding: 8px; }
      button { font: inherit; color: inherit; }
      .shell { width: 100%; }
      .card {
        overflow: hidden;
        border: 1px solid var(--border);
        border-radius: 14px;
        background: var(--card);
        box-shadow: 0 10px 30px color-mix(in srgb, CanvasText 7%, transparent);
      }
      .header {
        width: 100%;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: center;
        gap: 10px;
        border: 0;
        background: transparent;
        padding: 13px 14px;
        text-align: left;
        cursor: pointer;
      }
      .icon {
        width: 30px;
        height: 30px;
        border-radius: 9px;
        display: grid;
        place-items: center;
        background: var(--soft);
        font: 700 13px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      .main { min-width: 0; }
      .title { display: block; font-weight: 650; line-height: 1.25; }
      .label {
        display: block;
        margin-top: 3px;
        color: var(--muted);
        font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .status {
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 4px 8px;
        font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        text-transform: lowercase;
      }
      .status.ok { border-color: color-mix(in srgb, var(--ok) 55%, var(--border)); }
      .status.running { border-color: color-mix(in srgb, var(--warn) 60%, var(--border)); }
      .status.failed { border-color: color-mix(in srgb, var(--bad) 60%, var(--border)); }
      .body { border-top: 1px solid var(--border); padding: 12px 14px 14px; }
      .metrics { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 10px; }
      .metric {
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 5px 7px;
        background: var(--soft);
        font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      pre {
        max-height: 380px;
        overflow: auto;
        margin: 0;
        padding: 11px;
        border-radius: 9px;
        background: color-mix(in srgb, CanvasText 6%, transparent);
        font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .empty {
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 14px;
        color: var(--muted);
        background: var(--card);
      }
    </style>
  </head>
  <body>
    <main id="app" class="shell"><section class="empty">Connecting to Purr GitHub…</section></main>
    <script>
      const root = document.querySelector("#app");
      let expanded = true;
      let card = normalizeResult(
        window.openai?.toolOutput,
        window.openai?.toolResponseMetadata
      );

      applyHostGlobals(window.openai || {});
      render();

      window.addEventListener("openai:set_globals", (event) => {
        const globals = event.detail?.globals || {};
        applyHostGlobals(globals);
        const output = globals.toolOutput ?? window.openai?.toolOutput;
        const metadata = globals.toolResponseMetadata ?? window.openai?.toolResponseMetadata;
        const next = normalizeResult(output, metadata);
        if (next) card = next;
        render();
      }, { passive: true });

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.method !== "ui/notifications/tool-result") return;
        const next = normalizeResult(message.params);
        if (next) card = next;
        render();
      }, { passive: true });

      function normalizeResult(result, metadata = {}) {
        if (result === undefined || result === null) return null;
        const full = result && typeof result === "object" ? result : {};
        const structured = full.structuredContent ?? result;
        if (structured?.kind === "purr-github-card") return structured;
        const meta = full._meta || metadata || {};
        return {
          kind: "purr-github-card",
          tool: meta.tool || "github",
          status: full.isError ? "failed" : "ready",
          isError: Boolean(full.isError),
          payload: structured ?? parseText(full.content)
        };
      }

      function applyHostGlobals(globals) {
        if (globals.theme) document.documentElement.style.colorScheme = globals.theme;
        const variables = globals.styles?.variables;
        if (variables && typeof variables === "object") {
          for (const [name, value] of Object.entries(variables)) {
            if (typeof value === "string") document.documentElement.style.setProperty(name, value);
          }
        }
        const insets = globals.safeAreaInsets;
        if (insets) {
          document.body.style.padding = insets.top + "px " + insets.right + "px " + insets.bottom + "px " + insets.left + "px";
        }
      }

      function render() {
        if (!root) return;
        if (!card) {
          root.replaceChildren(node("section", "empty", "Waiting for a tool result."));
          return;
        }

        const display = displayFor(card.tool, card.payload);
        const section = node("section", "card");
        const header = node("button", "header");
        header.type = "button";
        header.setAttribute("aria-expanded", String(expanded));
        header.addEventListener("click", () => { expanded = !expanded; render(); });
        const icon = node("span", "icon", display.icon);
        const main = node("span", "main");
        main.append(node("span", "title", display.title));
        if (display.label) main.append(node("span", "label", display.label));
        header.append(icon, main, node("span", "status " + tone(card.status, card.isError), card.status || "ready"));
        section.append(header);

        if (expanded) {
          const body = node("div", "body");
          const metrics = metricValues(card.payload);
          if (metrics.length) {
            const row = node("div", "metrics");
            for (const metric of metrics) row.append(node("span", "metric", metric));
            body.append(row);
          }
          body.append(node("pre", "", pretty(card.payload)));
          section.append(body);
        }
        root.replaceChildren(section);
      }

      function parseText(content) {
        const text = Array.isArray(content)
          ? content.filter((item) => item?.type === "text").map((item) => item.text || "").join("\\n")
          : "";
        if (!text) return {};
        try { return JSON.parse(text); } catch { return { text }; }
      }

      function displayFor(tool, payload) {
        let icon = "GH";
        let title = String(tool || "GitHub").replaceAll("_", " ");
        if (tool === "read_operating_guide") { icon = "?"; title = "Operating guide"; }
        else if (tool === "verify_mcp_deploy") { icon = "✓"; title = "MCP deployment verification"; }
        else if (/pull_request|pr$/i.test(tool)) { icon = "PR"; title = title.replaceAll("pull request", "PR"); }
        else if (/commit|patch|file/i.test(tool)) icon = "Δ";
        else if (/branch|ref/i.test(tool)) icon = "⑂";
        else if (/issue|comment/i.test(tool)) icon = "#";
        else if (/repository|directory|tree/i.test(tool)) icon = "R";
        else if (/search/i.test(tool)) icon = "?";
        return { icon, title: sentence(title), label: findLabel(payload) };
      }

      function sentence(value) {
        const normalized = String(value).trim();
        return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : "GitHub";
      }

      function findLabel(payload) {
        return deepValues(payload, ["repo", "full_name", "path", "branch", "ref", "sha", "html_url", "title"])[0];
      }

      function metricValues(payload) {
        const keys = ["number", "state", "status", "sha", "branch", "ref", "additions", "deletions", "changed_files", "files_committed", "total_count"];
        const output = [];
        const seen = new Set();
        walk(payload, 0, (key, value) => {
          if (!keys.includes(key) || seen.has(key)) return;
          if (["string", "number", "boolean"].includes(typeof value)) {
            seen.add(key);
            output.push(key + ": " + String(value));
          }
        });
        return output.slice(0, 8);
      }

      function deepValues(payload, keys) {
        const output = [];
        walk(payload, 0, (key, value) => {
          if (keys.includes(key) && typeof value === "string" && value && !output.includes(value)) output.push(value);
        });
        return output;
      }

      function walk(value, depth, visit) {
        if (depth > 4 || !value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          visit(key, child);
          if (child && typeof child === "object") walk(child, depth + 1, visit);
        }
      }

      function tone(status, isError) {
        if (isError || /fail|error|closed|conflict|reject/i.test(String(status))) return "failed";
        if (/pending|queued|running|draft|unknown/i.test(String(status))) return "running";
        return "ok";
      }

      function pretty(value) {
        if (typeof value === "string") return value;
        try { return JSON.stringify(value, null, 2); } catch { return String(value); }
      }

      function node(tag, className = "", text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
      }
    </script>
  </body>
</html>`;
}
