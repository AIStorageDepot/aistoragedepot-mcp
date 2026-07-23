// Smoke test: spawn the server over stdio and exercise every capability.
// Usage: AISD_TOKEN=<token> AISD_BASE_URL=http://localhost:3100 node test-client.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["index.mjs"],
  env: {
    ...process.env,
    AISD_BASE_URL: process.env.AISD_BASE_URL || "http://localhost:3100",
    AISD_TOKEN: process.env.AISD_TOKEN,
  },
});

const client = new Client({ name: "smoke-test", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const resources = await client.listResources();
console.log(`RESOURCES: ${resources.resources.length}`);
for (const r of resources.resources.slice(0, 4)) console.log(`  - ${r.name} [${r.mimeType}] ${r.uri}`);

const prompts = await client.listPrompts();
console.log(`PROMPTS: ${prompts.prompts.length}`);
for (const p of prompts.prompts.slice(0, 4)) {
  console.log(`  - /${p.name}  args=[${(p.arguments || []).map((a) => a.name).join(", ")}]`);
}

const tools = await client.listTools();
console.log(`TOOLS: ${tools.tools.map((t) => t.name).join(", ")}`);

if (resources.resources[0]) {
  const r = await client.readResource({ uri: resources.resources[0].uri });
  console.log(`READ ${resources.resources[0].name}: ${JSON.stringify(r.contents[0].text.slice(0, 70))}`);
}

const promptWithArgs = prompts.prompts.find((p) => (p.arguments || []).length > 0) || prompts.prompts[0];
if (promptWithArgs) {
  const args = {};
  if (promptWithArgs.arguments?.[0]) args[promptWithArgs.arguments[0].name] = "XYZZY";
  const got = await client.getPrompt({ name: promptWithArgs.name, arguments: args });
  const text = got.messages[0].content.text;
  console.log(`GETPROMPT /${promptWithArgs.name}: filled=${text.includes("XYZZY")} text=${JSON.stringify(text.slice(0, 90))}`);
}

const search = await client.callTool({ name: "search_library", arguments: { query: "test" } });
console.log(`SEARCH: ${JSON.stringify(search.content[0].text.slice(0, 160))}`);

await client.close();
console.log("OK");
process.exit(0);
