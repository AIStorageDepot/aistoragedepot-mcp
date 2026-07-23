# @aistoragedepot/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes **your
[AIStorageDepot](https://www.aistoragedepot.com) library** to any MCP-aware AI client —
Claude Desktop, Cursor, Cline, Windsurf, and others.

Your stored content shows up where you actually work:

- **Prompts** → the items you mark with **/** in the app become MCP prompts (slash-commands) — any type, with each prompt's
  `[field]` surfaced as a prompt argument you fill in.
- **Resources** → every item (rules, docs, skills, MCP configs, prompts) is readable at
  `aisd://item/<id>`, so an agent can pull "my coding rules" or "my project guidelines"
  into context on demand.
- **Tools** → `search_library(query)` and `get_item(id)` let an agent find and fetch
  anything in your library programmatically.

## Setup

> **👉 Easiest path:** step-by-step instructions for each app (config-file locations and all)
> are at **<https://www.aistoragedepot.com/connect>**. The manual version:

1. In AIStorageDepot, go to **Settings → API tokens** and create a token (free for
   individuals). Copy it.
2. Add the server to your MCP client's config. Example (Claude Desktop /
   `claude_desktop_config.json`, Cursor `~/.cursor/mcp.json`, etc.):

```json
{
  "mcpServers": {
    "aisd": {
      "command": "npx",
      "args": ["-y", "@aistoragedepot/mcp"],
      "env": {
        "AISD_TOKEN": "aisd_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

3. Restart the client. The items you marked **/** appear as slash-commands; everything is available as
   resources; and the `search_library` / `get_item` tools are ready.

## Configuration

| Env var | Required | Default | Notes |
| --- | --- | --- | --- |
| `AISD_TOKEN` | yes | — | Token from Settings → API tokens. Has full access to your account — keep it secret. |
| `AISD_BASE_URL` | no | `https://www.aistoragedepot.com` | Point at a self-hosted / dev instance if needed. |
| `AISD_WORKSPACES` | no | — | **Retired.** Your slash menu is now the items you mark **/** in the app (strict opt-in); this variable is ignored. Search and resources still cover every workspace. |

## Slash-commands (`pull`)

Not every client turns MCP prompts into `/` slash-commands (some only use the tools). To get
your library as **native** slash-commands, sync it to command files — for every AI tool you
use, not just Claude:

```bash
npx -y @aistoragedepot/mcp pull --token=aisd_your_token --to=all
```

| Target | Writes to | Commands appear as |
| --- | --- | --- |
| `claude` *(default)* | `~/.claude/commands/aisd/` | `/aisd:<name>` |
| `cursor` | `~/.cursor/commands/` | `/aisd-<name>` |
| `vscode` | your VS Code profile's `prompts/` folder (Copilot Chat) | `/aisd-<name>` |
| `windsurf` | `~/.codeium/windsurf/global_workflows/` (Cascade) | `/aisd-<name>` |
| `codex` | `~/.codex/prompts/` | `/prompts:aisd-<name>` |

Tools that aren't installed are skipped automatically. Each tool gets its own dialect
(frontmatter, argument hints, `$ARGUMENTS` where supported). **Skills** run as-is.
**Prompts** take input: their `[fields]` show as an argument hint, and whatever you type
after the command fills them —

```
/aisd:cold-outreach Jane at Globex, about our payments API
```

— with the AI asking for any value you left out.

| Option | Default | |
| --- | --- | --- |
| `--to=…` | `claude` | Which tools to write commands for — comma list, or `all`. |
| `--token=…` | `AISD_TOKEN` env | Your API token. |
| `--types=…` | `skill,prompt` | Which item types become commands (e.g. `skill` for skills only). |
| `--workspaces="A,B"` | your personal library | Which workspaces to pull (names, or `all`). |
| `--project` | off | Write into the current repo instead: `.claude/commands/`, `.cursor/commands/`, `.github/prompts/`, `.windsurf/workflows/`. |
| `--dir=<path>` | per-target | Write somewhere else entirely (single `--to` only). |

Re-runs are safe: each target only clears its own files (claude: its namespaced folder;
the others: only files with the `aisd-` prefix — your own commands are never touched).

## Notes

- Read-only in v0.1 (it surfaces and fetches your content; it doesn't write back).
- The library snapshot is cached for ~30s, so a burst of calls hits the API once.
- Revoke a token any time in Settings → API tokens; the server loses access immediately.

## Local development

```bash
npm install
AISD_TOKEN=<token> AISD_BASE_URL=http://localhost:3100 npm run test:client
```
