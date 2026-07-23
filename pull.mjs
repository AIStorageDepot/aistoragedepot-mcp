// `npx @aistoragedepot/mcp pull` — sync your library into native slash-command files for the
// AI tools you use.
//
// Every major client now reads commands from a folder of markdown files; only the folder
// and the frontmatter dialect differ. Targets (--to=claude,cursor,vscode,windsurf,codex | all):
//   claude    ~/.claude/commands/aisd/*.md                    → /aisd:<name>
//   cursor    ~/.cursor/commands/aisd-*.md                    → /aisd-<name>
//   vscode    <VS Code User>/prompts/aisd-*.prompt.md         → /aisd-<name>      (Copilot Chat)
//   windsurf  ~/.codeium/windsurf/global_workflows/aisd-*.md  → /aisd-<name>      (Cascade)
//   codex     ~/.codex/prompts/aisd-*.md                      → /prompts:aisd-<name>
//
// Defaults to --to=claude with the **skills and prompts** in your personal library. Skills
// run as-is; prompts become commands that take input — their [fields] are declared as an
// argument-hint and filled from what you type after the command (real $ARGUMENTS where the
// tool substitutes it: claude + codex; a fill-from-my-message instruction elsewhere), with
// the AI asking for anything missing. Narrow with --types / widen with --workspaces.
// Re-runs clear only their own files (claude: its namespaced folder; others: the aisd- prefix).
import { mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";
const typeOf = (it) => (it.type?.slug || it.type?.name || "").toLowerCase();
const isPromptItem = (it) => it.type?.format === "prompt" || typeOf(it) === "prompt";

// A field token: [ name ] with an optional ` = default` (matches the monorepo's placeholders.ts).
const FIELD_RE = /\[([A-Za-z0-9 ]+)(?:=([^\]]*))?\]/g;
const yq = (s) => String(s).replace(/"/g, "'").replace(/\s+/g, " ").trim(); // YAML-safe one-liner
const fieldsOf = (body) => [...new Set([...String(body).matchAll(FIELD_RE)].map((m) => m[1].trim()).filter(Boolean))];

// Split a leading YAML frontmatter block off a body (skills carry their own). Values are
// only shallow-parsed — we just need `description` — everything else is passed through or
// dropped depending on the target.
function splitFrontmatter(body) {
  const m = String(body).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, content: String(body) };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, content: String(body).slice(m[0].length) };
}

function descFor(it, meta) {
  if (it.description) return it.description; // authored description field (first-class) wins
  if (meta.description) return meta.description; // else a description in the body's frontmatter
  return `${isPromptItem(it) ? "Prompt — " : ""}${it.title} (AIStorageDepot)`;
}

function fmFile(fm, body) {
  return ["---", ...Object.entries(fm).map(([k, v]) => `${k}: "${yq(v)}"`), "---", "", String(body).trim(), ""].join("\n");
}

// Required fields the author marked (intersected with the fields actually in this body).
const reqOf = (it, fields) => (it.requiredFields || []).filter((f) => fields.includes(f));
// A forceful "these are required — ask first" clause, or the gentle version when none are required.
const askClause = (required) =>
  required.length
    ? ` ${required.length === 1 ? "This field is" : "These fields are"} REQUIRED: ${required.map((f) => `[${f}]`).join(", ")} — if a value wasn't provided, STOP and ask me first; don't explore, run, or generate anything until I answer.`
    : ` Ask me for any value that's missing.`;

// Tail for tools that substitute $ARGUMENTS (claude, codex).
const argsTail = (fields, required = []) =>
  fields.length
    ? `\n\nInput: $ARGUMENTS\n\nFill the bracketed ${fields.length === 1 ? "field" : "fields"} in the prompt above from the input.${askClause(required)} Then carry out the prompt.`
    : "\n\n$ARGUMENTS";
// Tail for tools that just pass the typed text along with the inserted prompt.
const fillTail = (fields, required = []) =>
  `\n\nFill the bracketed ${fields.length === 1 ? "field" : "fields"} (${fields.map((f) => `[${f}]`).join(", ")}) from anything I typed along with this command.${askClause(required)} Then carry out the prompt.`;

// ── per-target renderers ─────────────────────────────────────────────────────

// Claude Code: skills keep their own frontmatter verbatim; prompts get description +
// argument-hint + $ARGUMENTS; anything else gets a description wrapper.
function renderClaude(it) {
  const body = it.body || "";
  if (isPromptItem(it)) {
    const { meta, content } = splitFrontmatter(body);
    const fields = fieldsOf(content);
    const fm = { description: descFor(it, meta) };
    if (fields.length) fm["argument-hint"] = fields.map((f) => `[${f}]`).join(" ");
    return fmFile(fm, content.trim() + argsTail(fields, reqOf(it, fields)));
  }
  if (/^---\r?\n/.test(body)) return body.endsWith("\n") ? body : `${body}\n`;
  return fmFile({ description: `${it.title} (AIStorageDepot)` }, body);
}

// Codex custom prompts: same dialect as Claude (description, argument-hint, $ARGUMENTS),
// but Codex doesn't know claude-specific skill frontmatter — rebuild it clean.
function renderCodex(it) {
  const { meta, content } = splitFrontmatter(it.body || "");
  const fields = isPromptItem(it) ? fieldsOf(content) : [];
  const fm = { description: descFor(it, meta) };
  if (isPromptItem(it) && fields.length) fm["argument-hint"] = fields.map((f) => `[${f}]`).join(" ");
  return fmFile(fm, content.trim() + (isPromptItem(it) ? argsTail(fields, reqOf(it, fields)) : ""));
}

// VS Code prompt files: description + argument-hint frontmatter; typed extras arrive as
// part of the chat message (no $ARGUMENTS substitution).
function renderVscode(it) {
  const { meta, content } = splitFrontmatter(it.body || "");
  const fields = isPromptItem(it) ? fieldsOf(content) : [];
  const fm = { description: descFor(it, meta) };
  if (fields.length) fm["argument-hint"] = fields.map((f) => `[${f}]`).join(" ");
  return fmFile(fm, content.trim() + (fields.length ? fillTail(fields, reqOf(it, fields)) : ""));
}

// Windsurf workflows: description frontmatter; 12k char cap per file (enforced by caller).
function renderWindsurf(it) {
  const { meta, content } = splitFrontmatter(it.body || "");
  const fields = isPromptItem(it) ? fieldsOf(content) : [];
  return fmFile({ description: descFor(it, meta) }, content.trim() + (fields.length ? fillTail(fields, reqOf(it, fields)) : ""));
}

// Cursor commands: plain markdown — no frontmatter dialect; the body IS the prompt.
function renderCursor(it) {
  const { content } = splitFrontmatter(it.body || "");
  const fields = isPromptItem(it) ? fieldsOf(content) : [];
  return content.trim() + (fields.length ? fillTail(fields, reqOf(it, fields)) : "") + "\n";
}

// ── targets ──────────────────────────────────────────────────────────────────

function vscodeUserDir(home) {
  if (process.platform === "win32")
    return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Code", "User");
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Code", "User");
  return join(home, ".config", "Code", "User");
}

// prefix'd targets share folders with the user's own files — we only ever delete our prefix.
function targetDefs(project) {
  const home = homedir();
  return {
    claude: {
      // "aisd" (2026-07-12): the folder is the slash prefix — /aisd:command beats
      // typing /aistoragedepot:command, and matches the aisd- prefix the other tools use.
      dir: project ? resolve(".claude", "commands", "aisd") : join(home, ".claude", "commands", "aisd"),
      legacyDirs: project ? [resolve(".claude", "commands", "aistoragedepot")] : [join(home, ".claude", "commands", "aistoragedepot")],
      parent: null, // Claude Code owns ~/.claude; safe to create
      ownsFolder: true,
      prefix: "",
      ext: ".md",
      render: renderClaude,
      tip: "type /aisd in a new chat (first sync: fully restart Claude Code — end claude.exe on Windows)",
    },
    cursor: {
      dir: project ? resolve(".cursor", "commands") : join(home, ".cursor", "commands"),
      parent: project ? null : join(home, ".cursor"),
      prefix: "aisd-",
      ext: ".md",
      render: renderCursor,
      tip: "type /aisd- in Cursor's Agent input",
    },
    vscode: {
      dir: project ? resolve(".github", "prompts") : join(vscodeUserDir(home), "prompts"),
      parent: project ? null : vscodeUserDir(home),
      prefix: "aisd-",
      ext: ".prompt.md",
      render: renderVscode,
      tip: "type /aisd- in Copilot Chat",
    },
    windsurf: {
      dir: project ? resolve(".windsurf", "workflows") : join(home, ".codeium", "windsurf", "global_workflows"),
      parent: project ? null : join(home, ".codeium", "windsurf"),
      prefix: "aisd-",
      ext: ".md",
      render: renderWindsurf,
      maxBytes: 12000, // Windsurf rejects workflow files past ~12k chars
      tip: "type /aisd- in Cascade",
    },
    codex: {
      dir: join(process.env.CODEX_HOME || join(home, ".codex"), "prompts"), // global only
      parent: process.env.CODEX_HOME || join(home, ".codex"),
      prefix: "aisd-",
      ext: ".md",
      render: renderCodex,
      noProject: true,
      tip: "type /prompts:aisd- (or /aisd-) in Codex — restart codex to load",
    },
  };
}

function parseArgs(argv) {
  const o = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) o[m[1]] = m[2] ?? true;
  }
  return o;
}

export async function pull({ BASE_URL, argv }) {
  const o = parseArgs(argv);
  const token = o.token || process.env.AISD_TOKEN;
  if (!token) {
    console.error(
      "A token is required. Pass --token=aisd_… (create one in AIStorageDepot → Settings → API tokens), or set AISD_TOKEN.",
    );
    process.exit(1);
  }
  const api = async (p) => {
    // Connection: close — keep-alive sockets left open at exit trip a libuv assert on
    // Windows (Node 24), printing a scary (but harmless) message after the sync finishes.
    const r = await fetch(BASE_URL + p, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", Connection: "close" },
    });
    if (r.status === 401) throw new Error("Token rejected (401) — check it in Settings → API tokens.");
    if (!r.ok) {
      // Prefer the server's message (e.g. the free-plan pull limit's 402 upgrade note).
      const detail = await r.json().then((d) => d?.error).catch(() => null);
      throw new Error(detail || `${p} → HTTP ${r.status}`);
    }
    return r.json();
  };

  // Which tools to write for. Default: claude. --to=cursor,vscode | all.
  const DEFS = targetDefs(!!o.project);
  const toRaw = String(o.to || "claude").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const targets = toRaw.includes("all") ? Object.keys(DEFS) : toRaw;
  const unknown = targets.filter((t) => !DEFS[t]);
  if (unknown.length) {
    console.error(`Unknown --to target(s): ${unknown.join(", ")}. Valid: ${Object.keys(DEFS).join(", ")}, all.`);
    process.exit(1);
  }
  if (o.dir && targets.length > 1) {
    console.error("--dir only makes sense with a single --to target.");
    process.exit(1);
  }

  // Which item types to pull. Default: skills + prompts. --types=skill | prompt | all.
  const TYPES = String(o.types || "skill,prompt").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const wantType = (it) => {
    const t = typeOf(it);
    const isSkill = t === "skill";
    const isPrompt = isPromptItem(it);
    if (TYPES.includes("all")) return isSkill || isPrompt;
    return (TYPES.includes("skill") && isSkill) || (TYPES.includes("prompt") && isPrompt) || TYPES.includes(t);
  };

  const workspaces = await api("/api/workspaces");
  // Scope: default your personal library; --workspaces="A,B" | "all".
  const names = String(o.workspaces || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  let scope;
  if (names.includes("all") || names.includes("*")) scope = workspaces;
  else if (names.length) scope = workspaces.filter((w) => names.includes((w.name || "").toLowerCase()));
  else scope = workspaces.filter((w) => w.type === "PERSONAL");

  const libs = await Promise.all(
    scope.map((w) => api(`/api/library?workspace=${encodeURIComponent(w.id)}`).catch(() => ({ items: [] }))),
  );
  const items = libs.flatMap((l) => (l.items || []).filter(wantType));
  const wsNameById = new Map(scope.map((w) => [w.id, w.name])); // library-name tie-break on title collisions

  // Inline @aisd:<slug> references (resolved server-side, access-controlled) so every pulled command
  // file is self-contained. Only items that declare references make the round-trip.
  for (const it of items) {
    if (it.references?.length) {
      try {
        const r = await api(`/api/items/${encodeURIComponent(it.id)}/resolved`);
        if (typeof r?.body === "string") it.body = r.body;
      } catch { /* keep the raw body on any error */ }
    }
  }

  for (const tname of targets) {
    const t = DEFS[tname];
    if (t.noProject && o.project) console.log(`  (${tname} has no per-project location — writing globally)`);
    // Don't invent config folders for tools that aren't installed (claude is exempt: it's
    // our home target and Claude Code tolerates a pre-made commands dir).
    if (t.parent && !existsSync(t.parent)) {
      console.log(`↷ ${tname} skipped — ${t.parent} not found (is it installed? use --to without it, or install first)`);
      continue;
    }
    const dir = o.dir && targets.length === 1 ? resolve(String(o.dir)) : t.dir;
    if (t.ownsFolder) await rm(dir, { recursive: true, force: true }); // clean re-sync of OUR folder only
    // Migrate away from renamed folders we used to own (e.g. commands/aistoragedepot →
    // commands/aisd, 2026-07-12) — otherwise old pulls linger as duplicate commands.
    for (const legacy of t.legacyDirs ?? []) await rm(legacy, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    if (!t.ownsFolder) {
      // shared folder: remove only files we wrote before (our prefix)
      const existing = await readdir(dir).catch(() => []);
      await Promise.all(
        existing.filter((n) => n.startsWith(t.prefix) && n.endsWith(t.ext)).map((n) => rm(join(dir, n), { force: true })),
      );
    }

    const used = new Set();
    let n = 0;
    let skipped = 0;
    for (const it of items) {
      // Clean names; on a title collision the LIBRARY NAME breaks the tie, then the type,
      // then an id suffix as the last resort — matching the MCP slash-menu naming.
      let name = slug(it.title);
      if (used.has(name)) {
        const ws = wsNameById.get(it.workspaceId);
        const withWs = ws ? slug(`${it.title} ${ws}`) : "";
        const withType = slug(`${it.title} ${typeOf(it) || "item"}`);
        name = withWs && !used.has(withWs) ? withWs : !used.has(withType) ? withType : `${slug(it.title)}-${it.id.slice(-4)}`;
      }
      while (used.has(name)) name = `${name}-${it.id.slice(-4)}`;
      used.add(name);
      const content = t.render(it);
      if (t.maxBytes && content.length > t.maxBytes) {
        console.log(`  ! ${tname}: skipped "${it.title}" — over the ${t.maxBytes}-char limit`);
        skipped++;
        continue;
      }
      await writeFile(join(dir, `${t.prefix}${name}${t.ext}`), content, "utf8");
      n++;
    }
    console.log(`✓ ${tname} — ${n} command${n === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped)` : ""} → ${dir}`);
    console.log(`  ${t.tip}`);
  }

  // Pulled files are static copies — the only moment we can warn about staleness is now.
  // (updateAvailable comes computed from the API and already honors "skip this version".)
  const stale = items.filter((it) => it.updateAvailable);
  if (stale.length) {
    console.log(`\n⬆ ${stale.length} of your item${stale.length === 1 ? " is" : "s are"} behind ${stale.length === 1 ? "its" : "their"} source:`);
    for (const it of stale.slice(0, 10)) {
      console.log(`  • "${it.title}"${it.sourceWorkspaceName ? ` — source in ${it.sourceWorkspaceName}` : ""}${it.sourceCurrentVersion != null ? ` is at v${it.sourceCurrentVersion} (you have v${it.sourceVersion})` : ""}`);
    }
    if (stale.length > 10) console.log(`  …and ${stale.length - 10} more.`);
    console.log(`  Open AIStorageDepot to review and get the latest, then re-run pull.`);
  }
}
