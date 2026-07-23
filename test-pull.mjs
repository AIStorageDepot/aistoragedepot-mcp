// Automated test for the `pull` subcommand's file layout — most importantly the
// 2026-07-12 aisd rename: claude commands land in ~/.claude/commands/aisd/ and a
// leftover commands/aistoragedepot folder from an older pull is cleaned up, while
// the user's OWN files in ~/.claude/commands are never touched.
//
// Self-contained: serves a fake API on localhost and points homedir at a temp dir
// (os.homedir() reads USERPROFILE/HOME, so overriding the env is enough — the same
// trick used for the original manual pull testing). Run: `npm test` (no token needed).
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pull } from "./pull.mjs";

let pass = 0;
let fail = 0;
const check = (ok, label) => {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  ok ? pass++ : fail++;
};

// ── fake library API ─────────────────────────────────────────────────────────
const ITEMS = [
  {
    id: "itm_skill_01",
    workspaceId: "ws1",
    title: "Ship Checklist",
    type: { slug: "skill" },
    body: "---\ndescription: How we ship\n---\nRun the gate, then deploy.",
  },
  {
    id: "itm_prompt_01",
    workspaceId: "ws1",
    title: "Greet Someone",
    type: { slug: "prompt", format: "prompt" },
    body: "Write a warm greeting to [Name].",
    requiredFields: ["Name"],
  },
  {
    // Parity fixture (0.6.0): an authored description field + a [Field = default].
    id: "itm_prompt_02",
    workspaceId: "ws1",
    title: "Deploy App",
    type: { slug: "prompt", format: "prompt" },
    description: "Deploy the app to an environment",
    body: "Deploy to [Env = staging] with [Region].",
    requiredFields: [],
  },
];

const srv = createServer((req, res) => {
  if (req.headers.authorization !== "Bearer aisd_test_token") {
    res.writeHead(401).end(JSON.stringify({ error: "bad token" }));
    return;
  }
  const url = new URL(req.url, "http://x");
  let body = null;
  if (url.pathname === "/api/workspaces") body = [{ id: "ws1", name: "My Library", type: "PERSONAL" }];
  if (url.pathname === "/api/library") body = url.searchParams.get("workspace") === "ws1" ? { items: ITEMS } : { items: [] };
  if (!body) {
    res.writeHead(404).end(JSON.stringify({ error: "not found" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const BASE_URL = `http://127.0.0.1:${srv.address().port}`;

// ── fake home with a legacy pull + a user's own command file ────────────────
const home = await mkdtemp(join(tmpdir(), "aisd-pull-test-"));
process.env.USERPROFILE = home; // windows homedir()
process.env.HOME = home; // posix homedir()

const commands = join(home, ".claude", "commands");
const legacyDir = join(commands, "aistoragedepot");
await mkdir(legacyDir, { recursive: true });
await writeFile(join(legacyDir, "stale-old-pull.md"), "old pulled command\n", "utf8");
const userDir = join(commands, "my-own-stuff");
await mkdir(userDir, { recursive: true });
await writeFile(join(userDir, "keep-me.md"), "the user's own command\n", "utf8");
await writeFile(join(commands, "loose-user-file.md"), "also the user's\n", "utf8");

try {
  await pull({ BASE_URL, argv: ["--token=aisd_test_token", "--to=claude"] });

  const aisdDir = join(commands, "aisd");
  const written = existsSync(aisdDir) ? await readdir(aisdDir) : [];
  check(written.includes("ship-checklist.md") && written.includes("greet-someone.md"), "writes commands into commands/aisd (→ /aisd:<name>)");
  check(!existsSync(legacyDir), "legacy commands/aistoragedepot folder is removed (no duplicate stale commands)");
  check(existsSync(join(userDir, "keep-me.md")) && existsSync(join(commands, "loose-user-file.md")), "the user's own files in commands/ survive");

  const skill = existsSync(join(aisdDir, "ship-checklist.md")) ? await readFile(join(aisdDir, "ship-checklist.md"), "utf8") : "";
  check(skill.includes("description: How we ship") && skill.includes("Run the gate"), "skill keeps its own frontmatter verbatim");

  const prompt = existsSync(join(aisdDir, "greet-someone.md")) ? await readFile(join(aisdDir, "greet-someone.md"), "utf8") : "";
  check(prompt.includes('argument-hint: "[Name]"') && prompt.includes("$ARGUMENTS"), "prompt declares its [field] as argument-hint + $ARGUMENTS");
  check(prompt.includes("REQUIRED: [Name]") && prompt.includes("STOP and ask me first"), "required field carries the forceful ask clause");

  // Parity (0.6.0): authored description wins, and [Field = default] is recognized by the grammar.
  const deploy = existsSync(join(aisdDir, "deploy-app.md")) ? await readFile(join(aisdDir, "deploy-app.md"), "utf8") : "";
  check(deploy.includes('description: "Deploy the app to an environment"'), "authored description field is used in the command frontmatter");
  check(deploy.includes('argument-hint: "[Env] [Region]"'), "a [Field = default] is picked up in argument-hint (defaults grammar)");
  check(deploy.includes("Deploy to [Env = staging] with [Region]."), "the body keeps the [Field = default] token so the default is visible");

  // Second run must be a clean re-sync of OUR folder, still without touching user files.
  await writeFile(join(aisdDir, "orphan-from-last-sync.md"), "should be cleared\n", "utf8");
  await pull({ BASE_URL, argv: ["--token=aisd_test_token", "--to=claude"] });
  const resync = await readdir(aisdDir);
  check(!resync.includes("orphan-from-last-sync.md") && resync.includes("ship-checklist.md"), "re-sync clears only our own folder");
  check(existsSync(join(userDir, "keep-me.md")), "user files still intact after re-sync");
} finally {
  await new Promise((r) => srv.close(r));
  await rm(home, { recursive: true, force: true });
}

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
// No hard process.exit(): on Windows/Node 24 it trips a libuv assert while undici
// sockets are still closing (same gotcha pull.mjs works around). Exit naturally.
process.exitCode = fail ? 1 : 0;
