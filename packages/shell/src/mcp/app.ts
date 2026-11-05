// The app's side of its MCP server (src/mcp.ts, a factory of the official SDK): served on the loopback
// for the stdio process an agent's client starts (bridge.ts). The protocol is the SDK's; what's here
// is who may reach it, and the two files that say where it is and what it offers (files.ts).
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { createMcpHandler, McpServerFactory } from "@modelcontextprotocol/server";
import { endpointFile, IDENTITY_ENV, toolsFile, type McpAddress, type McpEndpoint, type McpIdentity } from "./files.ts";

function writeAtomic(file: string, text: string, mode?: number) {
  mkdirSync(join(file, ".."), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, mode === undefined ? undefined : { mode });
  if (mode !== undefined) chmodSync(temp, mode);
  renameSync(temp, file);
}

const sameToken = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** Between this app's two processes, which carry the same SDK: the revision without a handshake,
 *  where closing a request cancels it. */
export const MODERN_REVISION = "2026-07-28";

/** A client of the app's server. Rejects when nobody answers, before anything has run. */
export async function connectToApp(identity: McpIdentity, address: McpAddress, send: typeof fetch = fetch): Promise<Client> {
  const client = new Client({ name: `${identity.appName} bridge`, version: identity.version }, { versionNegotiation: { mode: { pin: MODERN_REVISION } } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(address.url), {
      requestInit: { headers: { authorization: `Bearer ${address.token}` } },
      fetch: (url, init) => send(url, { ...init, timeout: false } as RequestInit), // a tool takes the time it takes
    }),
  );
  return client;
}

/** Serves the app's MCP server. `load` is asked on each request: in dev, the file as it is now.
 *  `createHandler` is the SDK as src/mcp.ts imports it: it recognizes an McpServer of its own copy only,
 *  and the app's copy needn't be the shell's. */
export function startMcpEndpoint(identity: McpIdentity, createHandler: typeof createMcpHandler, load: () => McpServerFactory | Promise<McpServerFactory>): McpEndpoint {
  process.env[IDENTITY_ENV] = JSON.stringify(identity);
  const handler = createHandler(async (context) => {
    const factory = await load();
    if (typeof factory !== "function") throw new Error("src/mcp.ts: its default export must be a function returning an McpServer");
    return factory(context);
  }, { onerror: (err) => console.error("[mcp]", err) });
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0, // a tool takes the time it takes
    fetch(req) {
      // No web page (its fetch carries an Origin), through no other name (DNS rebinding), with the token.
      if (req.headers.has("origin") || req.headers.get("host") !== `127.0.0.1:${server.port}`) return new Response("Forbidden", { status: 403 });
      if (!sameToken(req.headers.get("authorization") ?? "", `Bearer ${token}`)) return new Response("Unauthorized", { status: 401 });
      if (new URL(req.url).pathname !== "/mcp") return new Response("Not found", { status: 404 });
      return handler.fetch(req);
    },
  });
  const address: McpAddress = { url: `http://127.0.0.1:${server.port}/mcp`, token };
  const endpoint = endpointFile(identity.identifier);
  writeAtomic(endpoint, JSON.stringify(address), 0o600);
  return {
    async publish() {
      try {
        // The server's own list, asked in this process: no network (nor the system's proxy) on the way.
        const client = await connectToApp(identity, address, ((url: string, init: RequestInit) => handler.fetch(new Request(url, init))) as typeof fetch);
        const tools: unknown[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools({ cursor });
          tools.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor);
        await client.close();
        writeAtomic(toolsFile(identity.identifier), JSON.stringify({ tools }));
      } catch (err) {
        console.error(`[mcp] src/mcp: ${err instanceof Error ? err.message : err}`);
      }
    },
    stop() {
      void handler.close();
      server.stop(true);
      try {
        // Ours only: another copy of the app (dev and a built one) may have taken over.
        if ((JSON.parse(readFileSync(endpoint, "utf8")) as McpAddress).token === token) rmSync(endpoint);
      } catch {}
    },
  };
}
