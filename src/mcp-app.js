// Purr GitHub MCP App compatibility layer.
//
// The resource binding and host-context pattern is adapted from the
// MIT-licensed Waishnav/devspace project: https://github.com/Waishnav/devspace
// The compact workbench keeps repository operations, authentication, and write
// policy server-side. It only adds a self-contained MCP App resource and a
// stable structured card contract for ChatGPT and other MCP App hosts.

export const GITHUB_MCP_APP_URI = 'ui://purr/github-workbench-v7.html';
export const GITHUB_MCP_APP_LEGACY_URIS = Object.freeze([
  'ui://purr/github-workbench.html',
  'ui://purr/github-workbench-v2.html',
  'ui://purr/github-workbench-v3.html',
  'ui://purr/github-workbench-v4.html',
]);
export const GITHUB_MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

const GITHUB_MCP_APP_READABLE_URIS = new Set([
  GITHUB_MCP_APP_URI,
  ...GITHUB_MCP_APP_LEGACY_URIS,
]);

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
        'Compact repository, branch, file, diff, commit, issue, pull request, upload, and verification cards.',
      mimeType: GITHUB_MCP_APP_MIME_TYPE,
    },
  ];
}

export function readGithubMcpAppResource(uri) {
  if (!GITHUB_MCP_APP_READABLE_URIS.has(uri)) return null;
  return {
    contents: [
      {
        uri,
        mimeType: GITHUB_MCP_APP_MIME_TYPE,
        text: githubMcpAppHtml(),
        _meta: {
          ui: {
            prefersBorder: false,
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
    .map((entry) => (typeof entry.text === 'string' ? entry.text : ''))
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
  if (/create|commit|update|delete|merge|comment|apply|upload/i.test(tool)) return 'completed';
  return 'ready';
}

function findString(value, keys, depth = 0) {
  if (depth > 3 || !value || typeof value !== 'object') return undefined;
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
    <meta name="mcp-app-template" content="${GITHUB_MCP_APP_URI}" />
    <title>Purr GitHub Workbench</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        --surface: color-mix(in srgb, Canvas 97%, CanvasText 3%);
        --border: color-mix(in srgb, CanvasText 15%, transparent);
        --line: color-mix(in srgb, CanvasText 9%, transparent);
        --muted: color-mix(in srgb, CanvasText 58%, transparent);
        --subtle: color-mix(in srgb, CanvasText 5%, transparent);
        --ok: #22c55e;
        --run: #f59e0b;
        --bad: #ef4444;
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; background: transparent; color: CanvasText; }
      body { padding: 4px; }
      button, summary { color: inherit; font: inherit; }
      .shell { width: 100%; }
      .card {
        overflow: hidden;
        border: 1px solid var(--border);
        border-radius: 11px;
        background: var(--surface);
        contain: layout paint style;
        content-visibility: auto;
        contain-intrinsic-size: 58px;
      }
      .header {
        width: 100%;
        display: grid;
        grid-template-columns: 20px minmax(0, 1fr) auto 14px;
        align-items: center;
        gap: 9px;
        border: 0;
        padding: 10px 12px;
        background: transparent;
        text-align: left;
        cursor: pointer;
      }
      .mark {
        color: var(--muted);
        font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        text-align: center;
      }
      .main { min-width: 0; }
      .title { display: block; font-size: 13px; font-weight: 650; line-height: 1.3; }
      .label {
        display: block;
        margin-top: 2px;
        overflow: hidden;
        color: var(--muted);
        font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .state {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--muted);
        font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        white-space: nowrap;
      }
      .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
      .state.running .dot { background: var(--run); }
      .state.failed .dot { background: var(--bad); }
      .chevron { color: var(--muted); font-size: 11px; transition: transform 120ms ease; }
      .header[aria-expanded="true"] .chevron { transform: rotate(180deg); }
      .body { border-top: 1px solid var(--line); padding: 11px 12px 12px; }
      .summary { margin: 0 0 9px; font-size: 13px; line-height: 1.45; }
      .rows { margin: 0; }
      .row {
        display: grid;
        grid-template-columns: minmax(88px, 118px) minmax(0, 1fr);
        gap: 12px;
        padding: 6px 0;
        border-bottom: 1px solid var(--line);
      }
      .row:last-child { border-bottom: 0; }
      dt { color: var(--muted); font-size: 11px; }
      dd {
        min-width: 0;
        margin: 0;
        overflow-wrap: anywhere;
        font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      .items { display: grid; gap: 6px; margin: 8px 0 0; padding: 0; list-style: none; }
      .item {
        padding: 7px 8px;
        border-radius: 7px;
        background: var(--subtle);
        font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        overflow-wrap: anywhere;
      }
      .console {
        max-height: 300px;
        overflow: auto;
        margin: 8px 0 0;
        padding: 9px 10px;
        border-radius: 7px;
        background: color-mix(in srgb, CanvasText 7%, transparent);
        font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .raw { margin-top: 9px; border-top: 1px solid var(--line); padding-top: 8px; }
      .raw > summary {
        width: fit-content;
        color: var(--muted);
        cursor: pointer;
        font: 11px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      .empty {
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 12px;
        color: var(--muted);
        background: var(--surface);
        font-size: 12px;
      }
    </style>
  </head>
  <body>
    <main id="app" class="shell"><section class="empty">Connecting to Purr GitHub…</section></main>
    <script>
      const root = document.querySelector("#app");
      let expanded = false;
      let card = normalizeResult(window.openai?.toolOutput, window.openai?.toolResponseMetadata);

      applyHostGlobals(window.openai || {});
      render();

      window.addEventListener("openai:set_globals", (event) => {
        const globals = event.detail?.globals || {};
        applyHostGlobals(globals);
        const next = normalizeResult(
          globals.toolOutput ?? window.openai?.toolOutput,
          globals.toolResponseMetadata ?? window.openai?.toolResponseMetadata
        );
        if (next) {
          const changed = !card || next.tool !== card.tool;
          card = next;
          if (changed) expanded = false;
        }
        render();
      }, { passive: true });

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.method !== "ui/notifications/tool-result") return;
        const next = normalizeResult(message.params);
        if (next) {
          const changed = !card || next.tool !== card.tool;
          card = next;
          if (changed) expanded = false;
        }
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
          tool: meta.tool || meta.card?.tool || "github",
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
        header.append(node("span", "mark", display.icon));
        const main = node("span", "main");
        main.append(node("span", "title", display.title));
        if (display.label) main.append(node("span", "label", display.label));
        header.append(main);
        const tone = statusTone(card.status, card.isError);
        const state = node("span", "state " + tone);
        state.append(node("span", "dot"), node("span", "", normalizedStatus(card.status, card.isError)));
        header.append(state, node("span", "chevron", "⌄"));
        section.append(header);
        if (expanded) section.append(renderBody(card.tool, card.payload));
        root.replaceChildren(section);
      }

      function renderBody(tool, payload) {
        const body = node("div", "body");
        const view = presentationFor(tool, payload);
        if (view.summary) body.append(node("p", "summary", view.summary));
        if (view.rows?.length) {
          const rows = node("dl", "rows");
          for (const item of view.rows) {
            const row = node("div", "row");
            row.append(node("dt", "", item[0]), node("dd", "", item[1]));
            rows.append(row);
          }
          body.append(rows);
        }
        if (view.items?.length) {
          const list = node("ul", "items");
          for (const item of view.items) list.append(node("li", "item", item));
          body.append(list);
        }
        if (view.console) body.append(node("pre", "console", view.console));
        const raw = node("details", "raw");
        raw.append(node("summary", "", "Raw"));
        raw.addEventListener("toggle", () => {
          if (raw.open && raw.children.length === 1) raw.append(node("pre", "console", pretty(payload)));
        });
        body.append(raw);
        return body;
      }

      function parseText(content) {
        const text = Array.isArray(content)
          ? content.filter((item) => item?.type === "text").map((item) => item.text || "").join("\\n")
          : "";
        if (!text) return {};
        try { return JSON.parse(text); } catch { return { text }; }
      }

      function displayFor(tool, payload) {
        const labels = {
          read_operating_guide: ["?", "Operating guide"],
          get_authenticated_user: ["A", "GitHub identity"],
          get_repository: ["R", "Repository"],
          create_repository: ["R+", "Repository created"],
          list_branches: ["⑂", "Branches"],
          create_branch: ["⑂", "Branch created"],
          list_tree: ["T", "Repository tree"],
          list_directory: ["D", "Directory"],
          get_file: ["F", "File"],
          get_files_batch: ["F", "Files"],
          list_commits: ["C", "Commits"],
          get_commit: ["C", "Commit"],
          compare_refs: ["Δ", "Reference comparison"],
          compare_and_verify_pr: ["Δ", "PR comparison"],
          list_issues: ["#", "Issues"],
          create_issue: ["#+", "Issue created"],
          list_pull_requests: ["PR", "Pull requests"],
          list_pull_request_files: ["PR", "Pull request files"],
          create_pull_request: ["PR", "Pull request created"],
          update_pull_request: ["PR", "Pull request updated"],
          merge_pull_request: ["PR", "Pull request merge"],
          comment_pull_request: ["PR", "Pull request comment"],
          create_verification_comment: ["✓", "Verification comment"],
          get_verification_plan: ["✓", "Verification plan"],
          verify_mcp_deploy: ["✓", "MCP deployment verification"],
          search_code: ["?", "Code search"],
          update_file: ["F", "File updated"],
          delete_file: ["F", "File deleted"],
          commit_small_text_files: ["C", "Commit created"],
          commit_files: ["C", "Commit created"],
          create_branch_and_commit: ["C", "Branch and commit created"],
          create_branch_commit_pr: ["PR", "Branch, commit, and PR created"],
          apply_unified_diff: ["Δ", "Patch committed"],
          commit_large_file_from_url: ["↑", "Large file committed"],
          commit_files_from_manifest_url: ["↑", "Manifest committed"],
          commit_zip_archive: ["↑", "Archive committed"]
        };
        const item = labels[tool] || ["GH", sentence(String(tool || "GitHub").replaceAll("_", " "))];
        return { icon: item[0], title: item[1], label: primaryLabel(tool, payload) };
      }

      function presentationFor(tool, payload) {
        if (/repository/i.test(tool)) return repositoryView(payload);
        if (/pull_request|_pr$/i.test(tool)) return pullRequestView(tool, payload);
        if (/compare/i.test(tool)) return compareView(payload);
        if (/commit|apply_unified_diff|update_file|delete_file|archive|manifest|large_file/i.test(tool)) return commitView(tool, payload);
        if (/branch/i.test(tool)) return branchView(payload);
        if (/tree|directory|files_batch|get_file/i.test(tool)) return fileView(tool, payload);
        if (/issue/i.test(tool)) return issueView(payload);
        if (/verification|verify_mcp/i.test(tool)) return verificationView(payload);
        const message = first(payload, ["message", "error", "warning"]);
        return {
          summary: message ? truncate(message, 700) : conciseSummary(payload),
          rows: rowsFor(payload, [
            ["Status", ["status", "state"]],
            ["Repository", ["repo", "full_name"]],
            ["Branch", ["branch", "ref"]],
            ["Path", ["path"]],
            ["SHA", ["sha", "commitSha"]]
          ]),
          console: typeof direct(payload, "text") === "string" ? truncate(direct(payload, "text"), 24000) : undefined
        };
      }

      function repositoryView(payload) {
        const name = first(payload, ["full_name", "repo", "name"]);
        const visibility = first(payload, ["private"]);
        const branch = first(payload, ["default_branch", "branch"]);
        return {
          summary: name ? String(name) + (branch ? " · " + String(branch) : "") : conciseSummary(payload),
          rows: compactRows([
            ["Repository", name],
            ["Visibility", visibility === true ? "private" : visibility === false ? "public" : undefined],
            ["Default branch", branch],
            ["Open issues", first(payload, ["open_issues_count"])],
            ["Stars", first(payload, ["stargazers_count"])],
            ["URL", first(payload, ["html_url"])]
          ])
        };
      }

      function pullRequestView(tool, payload) {
        const pr = objectAt(payload, ["pull_request"]) || payload;
        const number = first(pr, ["number"]);
        const title = first(pr, ["title"]);
        const state = first(pr, ["state", "status"]);
        const head = first(pr, ["head", "branch"]);
        const base = first(pr, ["base"]);
        const summary = number !== undefined
          ? "#" + String(number) + (title ? " · " + String(title) : "")
          : conciseSummary(payload);
        return {
          summary,
          rows: compactRows([
            ["State", state],
            ["Head", head],
            ["Base", base],
            ["Draft", first(pr, ["draft"])],
            ["Merged", first(pr, ["merged"])],
            ["SHA", first(pr, ["sha", "commitSha"])],
            ["URL", first(pr, ["html_url"])]
          ]),
          items: tool === "list_pull_requests" ? arrayAt(payload).slice(0, 10).map(prLine) : undefined
        };
      }

      function compareView(payload) {
        return {
          summary: first(payload, ["status"]) ? "Comparison status: " + String(first(payload, ["status"])) + "." : conciseSummary(payload),
          rows: compactRows([
            ["Base", first(payload, ["base"])],
            ["Head", first(payload, ["head"])],
            ["Ahead", first(payload, ["ahead_by"])],
            ["Behind", first(payload, ["behind_by"])],
            ["Changed files", countAt(payload, ["files", "changed_files"])],
            ["Commits", countAt(payload, ["commits"])]
          ]),
          items: arrayNamed(payload, "files").slice(0, 10).map(fileLine)
        };
      }

      function commitView(tool, payload) {
        const files = arrayNamed(payload, "files_committed").length
          ? arrayNamed(payload, "files_committed")
          : arrayNamed(payload, "files_changed");
        const sha = first(payload, ["commitSha", "commit", "sha"]);
        return {
          summary: /delete/i.test(tool) ? "Repository file deletion recorded." : /upload|archive|manifest|large_file/i.test(tool) ? "Repository upload recorded." : "Repository change recorded.",
          rows: compactRows([
            ["Repository", first(payload, ["repo", "full_name"])],
            ["Branch", first(payload, ["branch", "new_branch"])],
            ["Commit", sha],
            ["Files", files.length ? String(files.length) : countAt(payload, ["files"])],
            ["Bytes", first(payload, ["bytes"])],
            ["URL", first(payload, ["commitUrl", "html_url"])]
          ]),
          items: files.slice(0, 10).map((item) => typeof item === "string" ? item : fileLine(item))
        };
      }

      function branchView(payload) {
        const branches = arrayAt(payload);
        return {
          summary: branches.length ? String(branches.length) + " branches." : "Branch operation completed.",
          rows: compactRows([
            ["Repository", first(payload, ["repo"])],
            ["Base", first(payload, ["base_branch", "base"])],
            ["Branch", first(payload, ["new_branch", "branch"])],
            ["SHA", first(payload, ["sha"])]
          ]),
          items: branches.slice(0, 12).map(branchLine)
        };
      }

      function fileView(tool, payload) {
        const entries = arrayAt(payload).length ? arrayAt(payload) : arrayNamed(payload, "files");
        const content = first(payload, ["content", "text"]);
        return {
          summary: entries.length ? String(entries.length) + " repository entries." : first(payload, ["path"]) ? String(first(payload, ["path"])) : conciseSummary(payload),
          rows: compactRows([
            ["Repository", first(payload, ["repo"])],
            ["Ref", first(payload, ["ref", "branch"])],
            ["Path", first(payload, ["path"])],
            ["SHA", first(payload, ["sha"])],
            ["Size", first(payload, ["size"])]
          ]),
          items: entries.slice(0, 12).map(fileLine),
          console: /get_file/i.test(tool) && typeof content === "string" ? truncate(content, 24000) : undefined
        };
      }

      function issueView(payload) {
        const issues = arrayAt(payload);
        return {
          summary: issues.length ? String(issues.length) + " issues." : first(payload, ["number"]) !== undefined ? "Issue #" + String(first(payload, ["number"])) + "." : conciseSummary(payload),
          rows: compactRows([
            ["Number", first(payload, ["number"])],
            ["Title", first(payload, ["title"])],
            ["State", first(payload, ["state"])],
            ["URL", first(payload, ["html_url"])]
          ]),
          items: issues.slice(0, 10).map(issueLine)
        };
      }

      function verificationView(payload) {
        return {
          summary: first(payload, ["annotations_ok"]) === true ? "MCP catalog and annotations verified." : first(payload, ["notes", "message"]) || conciseSummary(payload),
          rows: compactRows([
            ["Repository", first(payload, ["repo"])],
            ["Ref", first(payload, ["ref"])],
            ["Package manager", first(payload, ["package_manager"])],
            ["Tools", first(payload, ["count"])],
            ["Annotations", first(payload, ["annotations_ok"])],
            ["URL", first(payload, ["url"])]
          ]),
          items: arrayNamed(payload, "recommended_commands").slice(0, 10).map(String)
        };
      }

      function primaryLabel(tool, payload) {
        if (/pull_request|_pr$/i.test(tool) && first(payload, ["number"]) !== undefined) return "#" + String(first(payload, ["number"]));
        return first(payload, ["repo", "full_name", "path", "branch", "new_branch", "ref", "sha", "title", "html_url"]);
      }

      function rowsFor(payload, definitions) {
        return compactRows(definitions.map((definition) => [definition[0], first(payload, definition[1])]));
      }

      function compactRows(rows) {
        return rows
          .filter((row) => row[1] !== undefined && row[1] !== null && String(row[1]) !== "")
          .map((row) => [String(row[0]), truncate(String(row[1]), 1000)]);
      }

      function first(value, keys, depth = 0, state = { nodes: 0, seen: new WeakSet() }) {
        if (depth > 3 || state.nodes > 240 || !value || typeof value !== "object") return undefined;
        if (state.seen.has(value)) return undefined;
        state.seen.add(value);
        for (const key of keys) {
          if (["string", "number", "boolean"].includes(typeof value[key]) && String(value[key]) !== "") return value[key];
        }
        const preferred = ["data", "repository", "pull_request", "commit", "result", "tools_list", "initialize"];
        for (const key of preferred) {
          if (value[key] && typeof value[key] === "object") {
            state.nodes += 1;
            const found = first(value[key], keys, depth + 1, state);
            if (found !== undefined) return found;
          }
        }
        return undefined;
      }

      function direct(value, key) {
        return value && typeof value === "object" ? value[key] : undefined;
      }

      function objectAt(value, keys) {
        if (!value || typeof value !== "object") return null;
        for (const key of keys) {
          const child = value[key];
          if (child && typeof child === "object" && !Array.isArray(child)) return child;
        }
        return null;
      }

      function arrayAt(value) {
        if (Array.isArray(value)) return value;
        if (!value || typeof value !== "object") return [];
        for (const key of ["items", "tree", "branches", "commits", "issues", "pull_requests", "results"]) {
          if (Array.isArray(value[key])) return value[key];
        }
        return [];
      }

      function arrayNamed(value, key) {
        if (!value || typeof value !== "object") return [];
        return Array.isArray(value[key]) ? value[key] : [];
      }

      function countAt(value, keys) {
        for (const key of keys) {
          if (value && typeof value === "object") {
            if (Array.isArray(value[key])) return String(value[key].length);
            if (["number", "string"].includes(typeof value[key])) return String(value[key]);
          }
        }
        return undefined;
      }

      function branchLine(value) {
        if (!value || typeof value !== "object") return truncate(String(value), 500);
        return String(value.name || value.branch || "branch") + (value.sha ? " · " + String(value.sha).slice(0, 12) : "") + (value.protected ? " · protected" : "");
      }

      function fileLine(value) {
        if (!value || typeof value !== "object") return truncate(String(value), 500);
        const path = value.path || value.filename || value.name || "file";
        const suffix = value.status || value.type || value.sha;
        return String(path) + (suffix ? " · " + truncate(String(suffix), 120) : "");
      }

      function prLine(value) {
        if (!value || typeof value !== "object") return truncate(String(value), 500);
        return "#" + String(value.number ?? "?") + " · " + String(value.title || "Pull request") + (value.state ? " · " + String(value.state) : "");
      }

      function issueLine(value) {
        if (!value || typeof value !== "object") return truncate(String(value), 500);
        return "#" + String(value.number ?? "?") + " · " + String(value.title || "Issue") + (value.state ? " · " + String(value.state) : "");
      }

      function conciseSummary(payload) {
        if (Array.isArray(payload)) return String(payload.length) + " results.";
        if (!payload || typeof payload !== "object") return truncate(String(payload ?? "Completed."), 700);
        const message = first(payload, ["message", "error", "warning"]);
        if (message) return truncate(String(message), 700);
        const status = first(payload, ["status", "state"]);
        return status ? "Result status: " + String(status) + "." : "Operation completed.";
      }

      function normalizedStatus(status, isError) {
        if (isError) return "failed";
        const value = String(status || "ready").toLowerCase();
        if (/success|complete|completed|ok|healthy|merged/.test(value)) return "ready";
        if (/manual/.test(value)) return "manual required";
        if (/approval/.test(value)) return "approval required";
        return truncate(value, 22);
      }

      function statusTone(status, isError) {
        if (isError || /fail|error|cancel|reject|conflict|unavailable/i.test(String(status))) return "failed";
        if (/run|queue|pending|progress|draft|approval|manual|unknown/i.test(String(status))) return "running";
        return "ok";
      }

      function sentence(value) {
        const text = String(value || "").trim();
        return text ? text[0].toUpperCase() + text.slice(1) : "Purr GitHub";
      }

      function pretty(value) {
        if (typeof value === "string") return truncate(value, 65536);
        try { return JSON.stringify(boundedPreview(value), null, 2); } catch { return String(value); }
      }

      function boundedPreview(value, depth = 0, state = { nodes: 0, seen: new WeakSet() }) {
        if (typeof value === "string") return truncate(value, 4000);
        if (value === null || typeof value !== "object") return value;
        if (depth > 5 || state.nodes >= 1200) return "[Preview truncated]";
        if (state.seen.has(value)) return "[Circular]";
        state.seen.add(value);
        if (Array.isArray(value)) {
          const output = [];
          const limit = Math.min(value.length, 50);
          for (let index = 0; index < limit && state.nodes < 1200; index += 1) {
            state.nodes += 1;
            output.push(boundedPreview(value[index], depth + 1, state));
          }
          if (value.length > limit) output.push("[" + String(value.length - limit) + " more items]");
          return output;
        }
        const output = {};
        let count = 0;
        for (const key in value) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          if (count >= 80 || state.nodes >= 1200) {
            output.__preview = "Additional fields omitted";
            break;
          }
          count += 1;
          state.nodes += 1;
          output[key] = boundedPreview(value[key], depth + 1, state);
        }
        return output;
      }

      function truncate(value, limit) {
        const text = String(value ?? "");
        return text.length > limit ? text.slice(0, limit) + "\\n[truncated]" : text;
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
