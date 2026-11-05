// What an agent's client starts: the app's own executable with `--mcp` (`bun bridge.ts` in dev),
// no window, no native layer. An MCP server over stdio on one side (the SDK's), a client of the
// running app on the other (app.ts): tools run in the app, with its state, whoever calls them.
//
// A client starts its servers when it starts, so the app isn't opened for that: the list comes from
// the file the app left. Calling a tool opens it.
import { existsSync, readFileSync } from "node:fs";
import { Server, type CallToolRequest, type CallToolResult, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { connectToApp } from "./app.ts";
import { endpointFile, toolsFile, type McpAddress, type McpIdentity } from "./files.ts";

const LAUNCH_TIMEOUT_MS = 30_000;
/** A tool takes the time it takes; the client that called it has its own limit. Most a timer holds. */
const NO_TIMEOUT = 2 ** 31 - 1;

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
};

/** Opens the built app, in the background. False under `vite dev`: that one is started by hand. */
export function openApp(execPath = process.execPath, platform = process.platform): boolean {
  if (execPath.endsWith("/bun") || execPath.endsWith("\\bun.exe")) return false;
  const bundle = platform === "darwin" ? /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)?.[1] : undefined;
  const command = bundle ? ["open", "-g", bundle] : [process.env.APPIMAGE ?? execPath];
  Bun.spawn(command, { stdio: ["ignore", "ignore", "ignore"], detached: true }).unref();
  return true;
}

export function createBridge(identity: McpIdentity, open: () => boolean = openApp) {
  const label = identity.appName;
  const endpoint = endpointFile(identity.identifier);
  const list = toolsFile(identity.identifier);

  let opening: Promise<void> | null = null;
  /** Opens the app (once, for callers at the same time) and waits for it to say `ready`. */
  const whenOpen = (ready: () => boolean) =>
    (opening ??= (async () => {
      if (!open()) throw new Error(`${label} isn't running: start it (vite dev)`);
      for (const end = Date.now() + LAUNCH_TIMEOUT_MS; Date.now() < end; await Bun.sleep(100)) if (ready()) return;
      throw new Error(`${label} didn't start within ${LAUNCH_TIMEOUT_MS / 1000} s`);
    })().finally(() => (opening = null)));

  /** The running app, opened when nobody answers. Only this is tried again: nothing has run yet. */
  async function reach() {
    const known = readJson<McpAddress>(endpoint);
    if (known) {
      try {
        return await connectToApp(identity, known);
      } catch {}
    }
    await whenOpen(() => {
      const now = readJson<McpAddress>(endpoint);
      return !!now && now.token !== known?.token;
    });
    return connectToApp(identity, readJson<McpAddress>(endpoint)!);
  }

  return {
    async tools(): Promise<Tool[]> {
      if (!existsSync(list)) await whenOpen(() => existsSync(list));
      return readJson<{ tools: Tool[] }>(list)?.tools ?? [];
    },
    async call(params: CallToolRequest["params"], signal: AbortSignal): Promise<CallToolResult> {
      let client: Awaited<ReturnType<typeof reach>>;
      try {
        client = await reach();
      } catch (err) {
        if (signal.aborted) throw err;
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
      try {
        return (await client.callTool(params, { signal, timeout: NO_TIMEOUT })) as CallToolResult;
      } finally {
        void client.close().catch(() => {});
      }
    },
  };
}

/** Stdio until the client closes it (how MCP ends a server). Never returns: this process does nothing else. */
export async function runMcpBridge(identity: McpIdentity): Promise<never> {
  // stdout is the protocol's alone.
  console.log = console.info = console.debug = console.error;
  // A proxy in the environment isn't for the way to the app.
  process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1"].filter(Boolean).join(",");
  process.env.no_proxy = process.env.NO_PROXY;
  const bridge = createBridge(identity);
  serveStdio(() => {
    const server = new Server({ name: identity.appName, version: identity.version }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async () => ({ tools: await bridge.tools() }));
    server.setRequestHandler("tools/call", (request, context) => bridge.call(request.params, context.mcpReq.signal));
    return server;
  });
  await new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
  // What was written, out before leaving.
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(0);
}

if (import.meta.main) await runMcpBridge(JSON.parse(process.argv[2]!) as McpIdentity);
