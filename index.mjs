#!/usr/bin/env node
// AIStorageDepot MCP server.
//
// Exposes the signed-in user's library to any MCP-aware AI client (Claude Desktop,
// Cursor, Cline, Windsurf, …) over stdio:
//   • Prompts   — prompt-format items, with their [fields] surfaced as prompt arguments.
//   • Resources — every item (rules, docs, skills, configs, prompts) readable by URI.
//   • Tools     — search_library(query) and get_item(id).
//
// Auth + target are configured via env:
//   AISD_TOKEN     (required)  a token from AIStorageDepot → Settings → API tokens.
//   AISD_BASE_URL  (optional)  defaults to https://www.aistoragedepot.com.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE_URL = (process.env.AISD_BASE_URL || "https://www.aistoragedepot.com").replace(/\/+$/, "");

// CLI mode: `npx -y @aistoragedepot/mcp pull` syncs the library to native slash-command files, then
// exits. The brief settle delay lets undici finish closing its sockets (Connection: close)
// before process.exit — a hard exit mid-teardown trips a libuv assert on Windows (Node 24)
// that prints a scary-but-harmless message after the sync succeeds.
if (process.argv[2] === "pull") {
  const { pull } = await import("./pull.mjs");
  let code = 0;
  try {
    await pull({ BASE_URL, argv: process.argv.slice(3) });
  } catch (err) {
    console.error(err?.message || err);
    code = 1;
  }
  await new Promise((r) => setTimeout(r, 50));
  process.exit(code);
}

const TOKEN = process.env.AISD_TOKEN;

if (!TOKEN) {
  console.error("AISD_TOKEN is required. Create one in AIStorageDepot → Settings → API tokens.");
  process.exit(1);
}

async function api(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
  });
  if (res.status === 401) throw new Error("AIStorageDepot rejected the token (401) — check AISD_TOKEN.");
  if (!res.ok) {
    // Surface the server's own message when it sends one (e.g. the free-plan
    // monthly pull limit returns 402 with an upgrade note) instead of a bare code.
    const detail = await res.json().then((d) => d?.error).catch(() => null);
    throw new Error(detail || `AIStorageDepot ${path} → HTTP ${res.status}`);
  }
  return res.json();
}

// Library snapshot, cached briefly so a burst of list/read calls hits the API once.
let cache = { at: 0, workspaces: [], items: [] };
async function snapshot() {
  if (cache.items.length && Date.now() - cache.at < 30_000) return cache;
  const workspaces = await api("/api/workspaces");
  // Fetch every workspace's library in parallel — the sequential loop was the slow part.
  const libs = await Promise.all(
    workspaces.map((ws) =>
      api(`/api/library?workspace=${encodeURIComponent(ws.id)}`).catch(() => ({ items: [] })),
    ),
  );
  const items = libs.flatMap((lib) => lib.items || []);
  cache = { at: Date.now(), workspaces, items };
  return cache;
}

// --- mapping helpers ---
const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "item";

const mimeFor = (it) => (it.type?.format === "json" ? "application/json" : "text/markdown");

// Stable, unique prompt name per item. On a title collision the LIBRARY NAME breaks the tie
// (code-review-pw-team beats code-review-4f2a); an id suffix is the last resort (two same-titled
// items in the same library). First occurrence keeps the clean name — items arrive
// personal-library-first, so your own copy wins it. Rebuilt deterministically from the snapshot
// so ListPrompts and GetPrompt agree.
function indexByName(items, wsNames) {
  const used = new Set();
  const byName = new Map();
  for (const it of items) {
    let name = slug(it.title);
    if (used.has(name)) {
      const ws = wsNames?.get(it.workspaceId);
      const withWs = ws ? slug(`${it.title} ${ws}`) : "";
      name = withWs && !used.has(withWs) ? withWs : `${name}-${it.id.slice(-4)}`;
    }
    while (used.has(name)) name = `${name}-${it.id.slice(-4)}`;
    used.add(name);
    byName.set(name, it);
  }
  return byName;
}

// Which items appear as slash-commands: STRICTLY the ones the user marked "/" in the app
// (item.slash — any type; prompts keep their [field] arguments, other types insert their
// content as zero-argument commands). The mark is the user's own curation, so it applies
// across every library they belong to. Servers/APIs that predate the flag simply return no
// `slash` field → an empty menu, matching the app's strict opt-in model.
// (AISD_WORKSPACES, which used to scope the automatic all-prompts menu, is retired — kept
// harmless if still set.)
function scopedPromptIndex(cache) {
  const wsNames = new Map(cache.workspaces.map((w) => [w.id, w.name]));
  return indexByName(cache.items.filter((it) => it.slash === true), wsNames);
}

// MCP argument names should be simple identifiers; map them back to the original
// "[placeholder]" text so we can substitute into the body.
function argMap(placeholders) {
  const m = new Map();
  const used = new Set();
  for (const p of placeholders || []) {
    let a = slug(p).replace(/-/g, "_");
    while (used.has(a)) a += "_";
    used.add(a);
    m.set(a, p);
  }
  return m;
}

// A field token: [ name ] with an optional ` = default`. Mirrors the monorepo's placeholders.ts.
const FIELD_RE = /\[([A-Za-z0-9 ]+)(?:=([^\]]*))?\]/g;
// Substitute by field name: a supplied value → the token's own default → the literal token.
function resolveFields(body, values) {
  return String(body).replace(FIELD_RE, (whole, rawName, rawDefault) => {
    const name = rawName.trim();
    if (!name) return whole;
    const v = values[name];
    if (v != null && String(v).trim() !== "") return String(v);
    const def = rawDefault != null ? rawDefault.trim() : "";
    return def.length > 0 ? def : whole;
  });
}
function fillBody(body, placeholders, args) {
  const values = {};
  for (const [argName, original] of argMap(placeholders)) {
    const val = args?.[argName];
    if (val != null && val !== "") values[original] = val;
  }
  return resolveFields(body, values); // also applies each [Field = default] when its arg is omitted
}

// Header prepended to TEMPLATE items (prompt-format, has [fields]) wherever the raw body is
// served — get_item / resources/read. The prompts surface announces `required` arguments, but an
// agent reaching the same item through the TOOLS surface gets bare text with no signal that it's
// a fill-in-the-blanks form, so it uses it as-is. One block = scannable field list + instruction.
function templateHeader(it) {
  const isTemplate = (it.type?.format === "prompt" || (it.placeholders?.length ?? 0) > 0) && (it.placeholders?.length ?? 0) > 0;
  if (!isTemplate) return "";
  const req = new Set(it.requiredFields ?? []);
  const defs = it.fieldDefaults ?? {};
  const fields = it.placeholders
    .map((p) => (defs[p] != null ? `[${p}] (default: ${defs[p]})` : `[${p}]${req.has(p) ? " (required)" : ""}`))
    .join(" · ");
  return (
    `[Template — collect values before use]\n` +
    `This is a fill-in-the-blanks template, not finished content. Fields: ${fields}.\n` +
    `Ask the user for any required value they haven't provided, substitute every [field], then use the result. The template follows the --- line.\n` +
    `---\n`
  );
}

// Heads-up prepended wherever a STALE COPY's content is served (get_item / resources/read /
// prompts/get): the tracked source moved past the version this copy was made from and the user
// didn't skip it. "" when up to date, skipped, or not a copy (updateAvailable comes computed
// from the API; older servers simply never send it).
function updateNotice(it) {
  if (!it.updateAvailable) return "";
  const where = it.sourceWorkspaceName ? ` in "${it.sourceWorkspaceName}"` : "";
  const vs = it.sourceVersion != null && it.sourceCurrentVersion != null ? ` (you have v${it.sourceVersion}; it's at v${it.sourceCurrentVersion})` : "";
  return (
    `[Heads up — a newer version of "${it.title}" exists]\n` +
    `This is a copy, and its original${where} has moved ahead${vs}. ` +
    `Tell the user: they can open AIStorageDepot to review and get the latest, or skip this version to silence this notice. The content follows the --- line.\n` +
    `---\n`
  );
}

// Short flag for list descriptions so a stale copy is visible in the slash menu / picker.
function updateFlag(it) {
  if (!it.updateAvailable) return "";
  return it.sourceCurrentVersion != null ? ` ⬆ newer version available (v${it.sourceCurrentVersion})` : " ⬆ newer version available";
}

// Which MCP arg-names are required (their [placeholder] was marked required by the author).
function requiredArgNames(placeholders, requiredFields = [], defaults = {}) {
  const req = new Set(requiredFields);
  const out = new Set();
  // A field with a declared default is optional — the default is used when the arg is omitted.
  for (const [argName, original] of argMap(placeholders)) if (req.has(original) && !(original in defaults)) out.add(argName);
  return out;
}

// A "stop and ask first" instruction for any required field missing from the args — prepended to the
// prompt so even clients that ignore `required` don't run half-blank. "" when nothing's missing.
function missingRequiredPreamble(placeholders, requiredFields = [], args = {}, defaults = {}) {
  const req = new Set(requiredFields);
  const missing = [];
  for (const [argName, original] of argMap(placeholders)) {
    if (!req.has(original)) continue;
    if (original in defaults) continue; // a declared default satisfies the requirement
    const v = args?.[argName];
    if (v == null || v === "") missing.push(original);
  }
  if (!missing.length) return "";
  const list = missing.map((f) => `[${f}]`).join(", ");
  const one = missing.length === 1;
  return (
    `⚠ Before doing anything else, ask me for a value for ${one ? "this field" : "these fields"}: ${list}. ` +
    `Do not explore, run, generate, or take any action until I answer. Then substitute my ${one ? "answer" : "answers"} ` +
    `for ${one ? "that field" : "those fields"} and carry out the prompt below.\n\n`
  );
}

// "aisd" (2026-07-12): some clients namespace slash commands by the server name —
// /aisd:command beats typing /aistoragedepot:command. (Users who registered the
// server under another key keep their own prefix; this is the self-reported name.)
const server = new Server(
  { name: "aisd", version: "0.6.0" },
  { capabilities: { resources: {}, prompts: {}, tools: {} } },
);

// If an item includes @aisd:<slug> references, ask the API to inline them for THIS user (access-
// controlled server-side). Only called when the item declares references, so most reads skip it.
async function resolveBody(it) {
  if (!it.references?.length) return it.body;
  try {
    const r = await api(`/api/items/${it.id}/resolved`);
    return typeof r?.body === "string" ? r.body : it.body;
  } catch {
    return it.body;
  }
}

// ---- Resources: every item, readable at aisd://item/<id> ----
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const { items, workspaces } = await snapshot();
  const wsNames = new Map(workspaces.map((w) => [w.id, w.name]));
  return {
    resources: items.map((it) => ({
      uri: `aisd://item/${it.id}`,
      name: it.title,
      description: `${it.description ? it.description + " · " : ""}${it.type?.name || "Item"} · in ${wsNames.get(it.workspaceId) ?? "?"}${it.placeholders?.length ? ` · fill-in template (${it.placeholders.length} field${it.placeholders.length === 1 ? "" : "s"})` : ""}${it.tags?.length ? " · " + it.tags.join(", ") : ""}${updateFlag(it)}`,
      mimeType: mimeFor(it),
    })),
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const { uri } = req.params;
  const id = uri.replace(/^aisd:\/\/item\//, "");
  const { items } = await snapshot();
  const it = items.find((x) => x.id === id);
  if (!it) throw new Error(`Unknown resource: ${uri}`);
  return { contents: [{ uri, mimeType: mimeFor(it), text: updateNotice(it) + templateHeader(it) + (await resolveBody(it)) }] };
});

// ---- Prompts: prompt-format items, [fields] → arguments ----
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  const prompts = [];
  const snap = await snapshot();
  const wsNames = new Map(snap.workspaces.map((w) => [w.id, w.name]));
  for (const [name, it] of scopedPromptIndex(snap)) {
    const am = argMap(it.placeholders);
    const req = requiredArgNames(it.placeholders, it.requiredFields, it.fieldDefaults);
    prompts.push({
      name,
      description: it.description
        ? `${it.description}${updateFlag(it)}`
        : `${it.type?.name || "Item"}: “${it.title}” (in ${wsNames.get(it.workspaceId) ?? "?"} · AIStorageDepot)${updateFlag(it)}`,
      arguments: [...am.keys()].map((a) => {
        const orig = am.get(a);
        const def = it.fieldDefaults?.[orig];
        return { name: a, description: `Value for [${orig}]${def != null ? ` (default: ${def})` : ""}`, required: req.has(a) };
      }),
    });
  }
  return { prompts };
});

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const it = scopedPromptIndex(await snapshot()).get(req.params.name);
  if (!it) throw new Error(`Unknown prompt: ${req.params.name}`);
  const args = req.params.arguments || {};
  const text = updateNotice(it) + missingRequiredPreamble(it.placeholders, it.requiredFields, args, it.fieldDefaults) + fillBody(await resolveBody(it), it.placeholders, args);
  return {
    description: it.title,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
});

// ---- Tools: search + fetch ----
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_library",
      description:
        "Search your AIStorageDepot library (prompts, rules, docs, skills, configs) by keyword across titles, bodies, tags, and categories. Returns matching items with their aisd://item/<id> resource URIs. By default every library you belong to is searched; pass `library` ONLY when the user names a specific one.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keyword(s) to search for." },
          library: {
            type: "string",
            description:
              'Optional — search only the library whose name contains this text (e.g. "mycompany", "platform"). Omit it unless the user explicitly names a library.',
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_item",
      description:
        "Fetch the full content of one library item by its id or aisd://item/<id> URI (e.g. from a search_library result). The response leads with the item's title, type, version, and which library it came from.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "The item id, or an aisd://item/<id> URI." } },
        required: ["id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (name === "search_library") {
      const q = String(args?.query || "").trim();
      if (q.length < 2) return { content: [{ type: "text", text: "Enter at least 2 characters." }] };
      const { workspaces } = await snapshot();
      // Optional library filter — STRICTLY opt-in: omitted/blank means every library
      // (the default). A name matching nothing fails loudly with the real library
      // names; never a silent fallback to everything (mirrors the hosted server).
      const libArg = String(args?.library || "").trim().toLowerCase();
      const scope = libArg ? workspaces.filter((w) => w.name.toLowerCase().includes(libArg)) : workspaces;
      if (libArg && !scope.length) {
        return {
          content: [{ type: "text", text: `No library named like “${String(args.library).trim()}”. Your libraries: ${workspaces.map((w) => w.name).join(", ")}.` }],
        };
      }
      const inScope = libArg ? ` in ${scope.map((w) => `“${w.name}”`).join(", ")}` : "";
      const ids = scope.map((w) => w.id).join(",");
      const results = await api(`/api/search?q=${encodeURIComponent(q)}&workspaces=${encodeURIComponent(ids)}`);
      if (!results.length) return { content: [{ type: "text", text: `No matches for “${q}”${inScope}.` }] };
      // Proximity preference (mirrors the hosted server): when copies of an item coexist,
      // the one "closest" to the user wins — personal beats team beats company beats the
      // examples. The stable sort keeps recency within a shelf, and on a TITLE collision
      // the preference is said out loud — agents follow instructions, not implications.
      const PROXIMITY = { PERSONAL: 0, TEAM: 1, COMPANY: 2, CURATED: 3, WELCOME: 3 };
      results.sort((a, b) => (PROXIMITY[a.workspaceType] ?? 9) - (PROXIMITY[b.workspaceType] ?? 9));
      const titleCount = new Map();
      for (const r of results) {
        const k = r.title.toLowerCase();
        titleCount.set(k, (titleCount.get(k) ?? 0) + 1);
      }
      const seenTitle = new Set();
      const lines = results.map((r) => {
        const k = r.title.toLowerCase();
        const dup = (titleCount.get(k) ?? 0) > 1;
        const closest = !seenTitle.has(k);
        seenTitle.add(k);
        const hint = dup ? (closest ? "  ← closest copy, prefer this one" : "  (a farther copy of the same title)") : "";
        return `• ${r.title} — ${r.typeName} (in ${r.workspaceName})${hint}  →  aisd://item/${r.id}`;
      });
      return { content: [{ type: "text", text: `${results.length} match(es) for “${q}”${inScope}:\n${lines.join("\n")}` }] };
    }
    if (name === "get_item") {
      const id = String(args?.id || "").replace(/^aisd:\/\/item\//, "");
      const { items, workspaces } = await snapshot();
      const it = items.find((x) => x.id === id);
      if (!it) return { content: [{ type: "text", text: `No item with id ${id}.` }], isError: true };
      // Lead with a human-readable identity (mirrors the hosted server) — a raw id means
      // nothing to the person reading the agent's output. Same bracketed-preamble style
      // as the stale notice, so agents strip it the same way when writing file content.
      const wsName = new Map(workspaces.map((w) => [w.id, w.name]));
      const identity = `[“${it.title}” — ${it.type?.name || "Item"} v${it.version}, from your “${wsName.get(it.workspaceId) ?? "?"}” library]\n\n`;
      return { content: [{ type: "text", text: identity + updateNotice(it) + templateHeader(it) + (await resolveBody(it)) }] };
    }
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`AIStorageDepot MCP server connected → ${BASE_URL}`);
