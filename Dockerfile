# Minimal image for MCP registries and graders that run the server in a container.
#
# No AISD_TOKEN is required to boot: with no token the server starts in anonymous
# "sample mode" and serves a free, read-only sample of the public AIStorageDepot
# prebuilt library — so it starts and answers introspection (tools/resources/prompts)
# with no credentials at all. Set AISD_TOKEN to serve your own & team libraries instead.

FROM node:22-alpine

WORKDIR /app

# Only the single runtime dependency (@modelcontextprotocol/sdk), installed from the lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The server itself (index.mjs speaks MCP over stdio; pull.mjs is the optional CLI).
COPY index.mjs pull.mjs ./

ENTRYPOINT ["node", "index.mjs"]
