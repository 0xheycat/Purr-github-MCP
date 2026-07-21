// Purr GitHub MCP App compatibility layer.
//
// The resource binding and host-context pattern is adapted from the
// MIT-licensed Waishnav/devspace project: https://github.com/Waishnav/devspace
// Repository operations, authentication, and write policy remain server-side.
// This module only adds a small self-contained MCP App card around existing
// structured tool results.

export const GITHUB_MCP_APP_URI = 'ui://purr/github-workbench-v8.html';
export const GITHUB_MCP_APP_LEGACY_URIS = Object.freeze([
  'ui://purr/github-workbench.html',
  'ui://purr/github-workbench-v2.html',
  'ui://purr/github-workbench-v3.html',
  'ui://purr/github-workbench-v4.html',
  'ui://purr/github-workbench-v5.html',
  'ui://purr/github-workbench-v6.html',
  'ui://purr/github-workbench-v7.html',
]);
export const GITHUB_MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

export const GITHUB_MCP_APP_TOOL_NAMES = Object.freeze([
  'get_verification_plan',
  'compare_and_verify_pr',
]);

const GITHUB_MCP_APP_TOOLS = new Set(GITHUB_MCP_APP_TOOL_NAMES);

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
  if (!toolName || !GITHUB_MCP_APP_TOOLS.has(toolName)) return undefined;
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
      description: 'Lightweight collapsed cards for every existing GitHub MCP tool.',
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
  if (depth > 2 || !value || typeof value !== 'object') return undefined;
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
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="mcp-app-template" content="${GITHUB_MCP_APP_URI}">
<title>Purr GitHub Workbench</title>
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:CanvasText}body{padding:2px}
.card{border:1px solid color-mix(in srgb,CanvasText 14%,transparent);border-radius:9px;background:Canvas;overflow:hidden;contain:content}
summary{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px 10px;cursor:pointer;list-style:none;min-height:44px}
summary::-webkit-details-marker{display:none}.mark{font:700 10px/1 ui-monospace,monospace;color:GrayText;text-align:center}
.main{min-width:0}.title{display:block;font-size:13px;font-weight:650;line-height:1.25}.label{display:block;margin-top:2px;color:GrayText;font:10px/1.3 ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.state{display:flex;align-items:center;gap:5px;color:GrayText;font:10px/1 ui-monospace,monospace;white-space:nowrap}.dot{width:6px;height:6px;border-radius:50%;background:#22c55e}.running .dot{background:#f59e0b}.failed .dot{background:#ef4444}
.body{border-top:1px solid color-mix(in srgb,CanvasText 9%,transparent);padding:9px 10px 10px}.summary{margin:0 0 7px;font-size:12px;line-height:1.4}.rows{margin:0}.row{display:grid;grid-template-columns:92px minmax(0,1fr);gap:9px;padding:4px 0}.row+ .row{border-top:1px solid color-mix(in srgb,CanvasText 7%,transparent)}dt{color:GrayText;font-size:10px}dd{margin:0;font:10px/1.4 ui-monospace,monospace;overflow-wrap:anywhere}
.items{margin:7px 0 0;padding:0;list-style:none}.item{padding:4px 0;font:10px/1.35 ui-monospace,monospace;overflow-wrap:anywhere}.item+ .item{border-top:1px solid color-mix(in srgb,CanvasText 7%,transparent)}
.raw{margin-top:7px}.raw summary{display:block;min-height:0;padding:4px 0;color:GrayText;font:10px/1.2 ui-monospace,monospace}.raw pre{max-height:220px;overflow:auto;margin:4px 0 0;padding:7px;border-radius:6px;background:color-mix(in srgb,CanvasText 6%,transparent);font:10px/1.4 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.empty{padding:9px 10px;color:GrayText;font-size:11px}
</style>
</head>
<body><main id="app"><section class="empty">Waiting for GitHub result.</section></main>
<script>
const root=document.querySelector("#app");let card=normalize(window.openai?.toolOutput,window.openai?.toolResponseMetadata);let expanded=false;host(window.openai||{});render();
window.addEventListener("openai:set_globals",event=>{const g=event.detail?.globals||{};host(g);const next=normalize(g.toolOutput??window.openai?.toolOutput,g.toolResponseMetadata??window.openai?.toolResponseMetadata);update(next)},{passive:true});
window.addEventListener("message",event=>{if(event.source!==window.parent)return;const message=event.data;if(message?.jsonrpc!=="2.0"||message.method!=="ui/notifications/tool-result")return;update(normalize(message.params))},{passive:true});
function host(g){if(g.theme)document.documentElement.style.colorScheme=g.theme;const i=g.safeAreaInsets;if(i)document.body.style.padding=i.top+"px "+i.right+"px "+i.bottom+"px "+i.left+"px"}
function update(next){if(!next)return;if(!card||next.tool!==card.tool)expanded=false;card=next;render()}
function normalize(result,metadata){if(!result)return null;const full=result&&typeof result==="object"?result:{};const value=full.structuredContent??result;const meta=full._meta||metadata||{};if(value?.kind==="purr-github-card")return value;return{kind:"purr-github-card",tool:meta.tool||meta.card?.tool||"github",status:value?.status||value?.state||(full.isError?"failed":"ready"),isError:Boolean(full.isError),payload:value?.payload??value}}
function render(){if(!root)return;if(!card){root.innerHTML='<section class="empty">Waiting for GitHub result.</section>';return}const view=header(card.tool,card.payload);const details=node("details","card");details.open=expanded;const head=node("summary");head.append(node("span","mark",view.mark),main(view),state(card.status,card.isError));const body=node("div","body");details.append(head,body);details.addEventListener("toggle",()=>{expanded=details.open;if(details.open&&!body.dataset.ready)fill(body,card.payload)});if(expanded)fill(body,card.payload);root.replaceChildren(details)}
function main(view){const span=node("span","main");span.append(node("span","title",view.title));if(view.label)span.append(node("span","label",view.label));return span}
function state(status,isError){const tone=statusTone(status,isError);const span=node("span","state "+tone);span.append(node("span","dot"),node("span","",statusText(status,isError)));return span}
function header(tool,payload){let mark="GH",title=sentence(String(tool||"GitHub").replaceAll("_"," "));if(/pull_request|_pr$/i.test(tool)){mark="PR";title="Pull request"}else if(/commit|patch|file/i.test(tool)){mark="Δ"}else if(/branch|ref/i.test(tool)){mark="BR"}else if(/issue|comment/i.test(tool)){mark="#"}else if(/repository|directory|tree/i.test(tool)){mark="R"}else if(/verify/i.test(tool)){mark="✓"}return{mark,title,label:first(payload,["repo","full_name","path","branch","ref","sha","title","html_url"])}}
function fill(body,payload){body.dataset.ready="1";const summary=first(payload,["message","error","warning","description"]);if(summary)body.append(node("p","summary",clip(summary,600)));const rows=collectRows(payload);if(rows.length){const dl=node("dl","rows");for(const row of rows){const wrap=node("div","row");wrap.append(node("dt","",row[0]),node("dd","",row[1]));dl.append(wrap)}body.append(dl)}const items=findItems(payload);if(items.length){const ul=node("ul","items");for(const item of items)ul.append(node("li","item",line(item)));body.append(ul)}const raw=node("details","raw");raw.append(node("summary","","Raw preview"));raw.addEventListener("toggle",()=>{if(raw.open&&raw.children.length===1)raw.append(node("pre","",preview(payload)))});body.append(raw)}
function collectRows(payload){const defs=[["Status",["status","state"]],["Repository",["repo","full_name"]],["Branch",["branch","ref","new_branch"]],["Path",["path"]],["Commit",["sha","commitSha"]],["Number",["number"]],["URL",["html_url","commitUrl"]]];const out=[];for(const def of defs){const value=first(payload,def[1]);if(value!==undefined&&String(value)!=="")out.push([def[0],clip(value,800)]);if(out.length===6)break}return out}
function first(value,keys){if(!value||typeof value!=="object")return undefined;for(const key of keys){const candidate=value[key];if(["string","number","boolean"].includes(typeof candidate)&&String(candidate)!=="")return candidate}for(const key of ["data","repository","pull_request","commit","result"]){const nested=value[key];if(nested&&typeof nested==="object"&&!Array.isArray(nested)){for(const wanted of keys){const candidate=nested[wanted];if(["string","number","boolean"].includes(typeof candidate)&&String(candidate)!=="")return candidate}}}return undefined}
function findItems(value){if(Array.isArray(value))return value.slice(0,6);if(!value||typeof value!=="object")return[];for(const key of ["files","items","tree","branches","commits","issues","pull_requests","results"]){if(Array.isArray(value[key]))return value[key].slice(0,6)}if(value.data&&typeof value.data==="object")return findItems(value.data);return[]}
function line(value){if(value&&typeof value==="object"){const left=value.path||value.filename||value.name||value.title||value.number||value.sha||"item";const right=value.status||value.state||value.type;return clip(String(left)+(right?" · "+String(right):""),500)}return clip(String(value),500)}
function preview(value){try{return clip(JSON.stringify(bound(value),null,2),12000)}catch{return clip(String(value),12000)}}
function bound(value,depth=0,state={nodes:0}){if(value===null||typeof value!=="object")return value;if(depth>3||state.nodes>120)return"[truncated]";state.nodes+=1;if(Array.isArray(value))return value.slice(0,8).map(item=>bound(item,depth+1,state));const out={};for(const key of Object.keys(value).slice(0,16))out[key]=bound(value[key],depth+1,state);return out}
function statusText(status,isError){if(isError)return"failed";const value=String(status||"ready").toLowerCase();if(/success|complete|completed|ok|healthy|merged/.test(value))return"ready";return clip(value,20)}
function statusTone(status,isError){if(isError||/fail|error|cancel|reject|conflict/i.test(String(status)))return"failed";if(/run|queue|pending|draft|approval|manual|unknown/i.test(String(status)))return"running";return"ok"}
function sentence(value){const text=String(value||"").trim();return text?text[0].toUpperCase()+text.slice(1):"GitHub"}
function clip(value,limit){const text=String(value??"");return text.length>limit?text.slice(0,limit)+"…":text}
function node(tag,className="",text){const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=String(text);return element}
</script></body></html>`;
}
