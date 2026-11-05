// For mcp.test.ts: "the app", its MCP server alone, in its own process (its own home folder).
// Prints where its files are once they're there; a line on stdin stops it the way quitting does.
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { startMcpEndpoint } from "./app.ts";
import { endpointFile, toolsFile, type McpIdentity } from "./files.ts";

const identity = JSON.parse(process.argv[2]!) as McpIdentity;
let calls = 0;
let stopped = 0;
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const server = startMcpEndpoint(identity, createMcpHandler, () => () => {
  const mcp = new McpServer({ name: identity.appName, version: identity.version });
  mcp.registerTool("echo", { description: "Echo", inputSchema: fromJsonSchema({ type: "object", properties: { text: { type: "string" } }, required: ["text"] }) }, (args) => {
    calls++;
    return text((args as { text: string }).text);
  });
  mcp.registerTool("slow", { description: "Slow" }, (context) => new Promise((resolve) => context.mcpReq.signal.addEventListener("abort", () => (stopped++, resolve(text("stopped"))))));
  mcp.registerTool("counts", { description: "Counts", annotations: { readOnlyHint: true } }, () => ({ ...text("counts"), structuredContent: { calls, stopped } }));
  return mcp;
});
await server.publish();
console.log(JSON.stringify({ endpoint: endpointFile(identity.identifier), tools: toolsFile(identity.identifier) }));
for await (const _ of Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>) break;
server.stop();
process.exit(0);
