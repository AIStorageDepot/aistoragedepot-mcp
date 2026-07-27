# Releasing

Three things have to move together. Skipping any one of them leaves a directory advertising a
stale version — which is exactly what happened between 0.6.4 and 0.6.7, when npm was current but
the GitHub Releases and the MCP registry were not.

## 1. npm

```bash
npm version <patch|minor|major>   # updates package.json
npm test                          # test-pull.mjs must pass
npm publish
```

## 2. GitHub tag + Release

A tag alone is not enough — directories look for a published **Release**. Glama's maintenance
grade reports "No stable releases found" without one, regardless of how many npm versions exist.

```bash
gh release create v<version> --target "$(git rev-parse HEAD)" --title "v<version>" --latest \
  --notes "…what changed…"
```

> `--target` needs the **full** commit SHA or a branch name; a short SHA is rejected with
> `Release.target_commitish is invalid`.

## 3. MCP registry

`server.json` carries its own version **twice** — the top-level `version` and
`packages[0].version` — and both must match the npm version.

```bash
# one-off: grab the publisher for your platform from
# https://github.com/modelcontextprotocol/registry/releases/latest
mcp-publisher validate
mcp-publisher login github --token "$(gh auth token)"
mcp-publisher publish
mcp-publisher logout
```

Notes:
- `login github` normally opens a browser device flow; `--token` skips that entirely, and the
  token needs **no** repository scopes (the registry never reads code).
- The server is registered under the **personal** namespace
  `io.github.aistoragedepot-admin/*`, so the publishing token must belong to that user. GitHub
  Actions OIDC would grant the *repository owner's* namespace (`io.github.AIStorageDepot/*`),
  which does **not** match — that is why this step is manual rather than a workflow.
- `description` is capped at **100 characters**; the registry rejects longer ones with a 422.
- Publishing a new version does not remove old ones; the newest semver becomes `isLatest`.

## Verify

```bash
gh release view v<version> --json tagName,isLatest
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=aistoragedepot"
```

Glama re-syncs daily, or immediately via **Admin → Repository → Sync Server** on the listing.
