// The stdio process against "the app", spawned as a client would, with the official SDK's own clients
// in both eras; who may reach the app; a client's config. The protocol itself is the SDK's, not tested
// here. No window anywhere: the "app" here is its MCP server alone, each in its own process, in a home
// folder of this test (a process reads its home once, when it starts).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { connectToApp, MODERN_REVISION } from "./app.ts";
import { openApp } from "./bridge.ts";
import { addServer, clientConfigPath, clientPresent, MCP_CLIENTS, removeServer, serverCommand, serverName } from "./clients.ts";
import type { McpAddress, McpIdentity } from "./files.ts";

const dir = mkdtempSync(join(tmpdir(), "sd-mcp-"));
const envHome = { HOME: dir, USERPROFILE: dir, XDG_DATA_HOME: join(dir, "data"), APPDATA: join(dir, "roaming") };
const here = (file: string) => new URL(file, import.meta.url).pathname;
const identity: McpIdentity = { identifier: "dev.test.mcp", appName: "Test App", version: "1.0.0" };

async function startApp(id: McpIdentity = identity) {
  const proc = Bun.spawn(["bun", here("./fixture-app.ts"), JSON.stringify(id)], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { ...process.env, ...envHome } });
  const reader = proc.stdout.getReader();
  let line = "";
  while (!line.includes("\n")) line += new TextDecoder().decode((await reader.read()).value);
  const files = JSON.parse(line) as { endpoint: string; tools: string };
  return { proc, ...files, quit: () => (proc.stdin.write("quit\n"), proc.stdin.flush(), proc.exited) };
}

/** A client of the bridge, as an agent's client is. `modern`: 2026-07-28; otherwise `initialize` first. */
async function client(id: McpIdentity = identity, { modern = true, env = {} as Record<string, string> } = {}) {
  const c = new Client({ name: "test", version: "1" }, modern ? { versionNegotiation: { mode: { pin: MODERN_REVISION } } } : {});
  await c.connect(new StdioClientTransport({ command: "bun", args: [here("./bridge.ts"), JSON.stringify(id)], env: { ...(process.env as Record<string, string>), ...envHome, ...env }, stderr: "inherit" }));
  return c;
}

const names = (tools: { name: string }[]) => tools.map((t) => t.name);
const textOf = (result: { content?: unknown }) => (result.content as { text: string }[])[0]?.text;
const counts = async (c: Client) => (await c.callTool({ name: "counts", arguments: {} })).structuredContent as { calls: number; stopped: number };

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => {
  app?.proc.kill();
  await app?.proc.exited;
  rmSync(dir, { recursive: true, force: true });
});

test("the app's files: where it is for its user only, what its tools are for anyone it starts", () => {
  expect(app.endpoint.startsWith(dir)).toBe(true);
  expect(names(JSON.parse(readFileSync(app.tools, "utf8")).tools)).toEqual(["echo", "slow", "counts"]);
  expect(JSON.parse(readFileSync(app.endpoint, "utf8")).url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  if (process.platform !== "win32") expect(statSync(app.endpoint).mode & 0o777).toBe(0o600);
});

test("who may reach the app: its token, no web page, under no other name", async () => {
  const address = JSON.parse(readFileSync(app.endpoint, "utf8")) as McpAddress;
  const direct = await connectToApp(identity, address);
  const before = (await counts(direct)).calls;
  const post = (headers: Record<string, string>, url = address.url) => fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text: "x" } } }) });
  const bearer = `Bearer ${address.token}`;
  expect((await post({})).status).toBe(401);
  expect((await post({ authorization: "Bearer nope" })).status).toBe(401);
  expect((await post({ authorization: bearer, origin: "https://evil.example" })).status).toBe(403);
  expect((await post({ authorization: bearer, host: "evil.example" })).status).toBe(403);
  expect((await post({ authorization: bearer }, address.url.replace("/mcp", "/other"))).status).toBe(404);
  expect((await counts(direct)).calls).toBe(before); // none of those ran it
  await direct.close();
});

test("a modern client: the list from the file, the call in the running app", async () => {
  const c = await client();
  expect(c.getNegotiatedProtocolVersion()).toBe(MODERN_REVISION);
  expect(names((await c.listTools()).tools)).toEqual(["echo", "slow", "counts"]);
  expect(textOf(await c.callTool({ name: "echo", arguments: { text: "héllo\nworld" } }))).toBe("héllo\nworld");
  const wrong = await c.callTool({ name: "echo", arguments: {} });
  expect(wrong.isError).toBe(true);
  await expect(c.callTool({ name: "missing", arguments: {} })).rejects.toMatchObject({ code: -32602 });
  await c.close();
}, 20_000);

test("a legacy client: initialize, then the same tools", async () => {
  const c = await client(identity, { modern: false });
  expect(c.getNegotiatedProtocolVersion()).not.toBe(MODERN_REVISION);
  expect(names((await c.listTools()).tools)).toEqual(["echo", "slow", "counts"]);
  expect(textOf(await c.callTool({ name: "echo", arguments: { text: "ok" } }))).toBe("ok");
  await expect(c.callTool({ name: "missing", arguments: {} })).rejects.toMatchObject({ code: -32602 });
  await c.close();
}, 20_000);

test("a call canceled reaches the tool, in the app", async () => {
  const c = await client();
  const { stopped } = await counts(c);
  const abort = new AbortController();
  const slow = c.callTool({ name: "slow", arguments: {} }, { signal: abort.signal });
  await Bun.sleep(150);
  abort.abort();
  await expect(slow).rejects.toThrow();
  for (let i = 0; i < 40 && (await counts(c)).stopped === stopped; i++) await Bun.sleep(50);
  expect((await counts(c)).stopped).toBe(stopped + 1);
  await c.close();
}, 20_000);

test("closing stdin ends the process, and stops what's running", async () => {
  const c = await client();
  const { stopped } = await counts(c);
  await c.close();
  const proc = Bun.spawn(["bun", here("./bridge.ts"), JSON.stringify(identity)], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...envHome } });
  const send = (message: object) => (proc.stdin.write(`${JSON.stringify(message)}\n`), proc.stdin.flush());
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "c", version: "1" } } });
  const reader = proc.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("2025-11-25");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "slow", arguments: {} } });
  await Bun.sleep(200);
  proc.stdin.end();
  expect(await proc.exited).toBe(0);
  const other = await client();
  for (let i = 0; i < 40 && (await counts(other)).stopped === stopped; i++) await Bun.sleep(50);
  expect((await counts(other)).stopped).toBe(stopped + 1);
  await other.close();
}, 20_000);

test("a proxy in the environment isn't used to reach the app", async () => {
  const c = await client(identity, { env: { HTTP_PROXY: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9" } });
  expect(textOf(await c.callTool({ name: "echo", arguments: { text: "direct" } }))).toBe("direct");
  await c.close();
}, 20_000);

test("the app quit: its address gone, the list still there, a call says what to do", async () => {
  const gone: McpIdentity = { ...identity, identifier: "dev.test.gone", appName: "Gone" };
  const other = await startApp(gone);
  expect(existsSync(other.endpoint)).toBe(true);
  await other.quit();
  expect(existsSync(other.endpoint)).toBe(false);
  const c = await client(gone);
  expect((await c.listTools()).tools.length).toBe(3);
  const called = await c.callTool({ name: "echo", arguments: { text: "x" } });
  expect(called.isError).toBe(true);
  expect(textOf(called)).toMatch(/Gone isn't running/);
  await c.close();
}, 20_000);

test("the app crashed: its address left behind, nobody answering, same", async () => {
  const dead: McpIdentity = { ...identity, identifier: "dev.test.dead", appName: "Dead" };
  const other = await startApp(dead);
  other.proc.kill(9);
  await other.proc.exited;
  expect(existsSync(other.endpoint)).toBe(true);
  const c = await client(dead);
  const called = await c.callTool({ name: "echo", arguments: { text: "x" } });
  expect(called.isError).toBe(true);
  expect(textOf(called)).toMatch(/Dead isn't running/);
  await c.close();
}, 20_000);

test("never run: no list yet, and it says so instead of hanging", async () => {
  const c = await client({ ...identity, identifier: "dev.test.never", appName: "Never" });
  await expect(c.listTools()).rejects.toThrow(/Never isn't running/);
  await c.close();
}, 20_000);

test("what opens the app: not Bun itself; a .app through `open`", () => {
  expect(openApp("/usr/local/bin/bun")).toBe(false);
  expect(openApp("C:\\bun\\bun.exe")).toBe(false);
});

// A client's config.
test("a client's config: this server added and removed, everything else staying", () => {
  const file = join(dir, "client", "mcp.json");
  addServer(file, "notes", { command: "/a", args: ["--mcp"] });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpServers: { notes: { command: "/a", args: ["--mcp"] } } });
  writeFileSync(file, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "/o" }, notes: { command: "/old" } } }));
  addServer(file, "notes", { command: "/b", args: [] });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ theme: "dark", mcpServers: { other: { command: "/o" }, notes: { command: "/b", args: [] } } });
  removeServer(file, "notes");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ theme: "dark", mcpServers: { other: { command: "/o" } } });
  removeServer(file, "notes"); // nothing to do, nothing rewritten
  removeServer(join(dir, "nowhere.json"), "notes");
  expect(existsSync(join(dir, "nowhere.json"))).toBe(false);
});

test("a client's config that isn't JSON: an error, and what's there stays", () => {
  const file = join(dir, "broken.json");
  writeFileSync(file, "{ // the user's comment\n}");
  expect(() => addServer(file, "notes", { command: "/a", args: [] })).toThrow(/isn't valid JSON/);
  expect(() => removeServer(file, "notes")).toThrow(/isn't valid JSON/);
  expect(readFileSync(file, "utf8")).toBe("{ // the user's comment\n}");
  writeFileSync(file, "[]");
  expect(() => addServer(file, "notes", { command: "/a", args: [] })).toThrow(/isn't a JSON object/);
});

test("Codex's TOML: added and removed in the text, its comments and the rest as they were", () => {
  const file = join(dir, "codex", "config.toml");
  const start = '# my settings\nmodel = "x"\n\n[mcp_servers.other] # kept\ncommand = "/o"\nargs = ["a"]\n\n# about profiles\n[profiles.fast]\nmodel = "y"\n';
  mkdirSync(join(dir, "codex"), { recursive: true });
  writeFileSync(file, start);
  const server = { command: 'C:\\Apps\\My "App".exe', args: ["--mcp", '{"a":"b"}'] };
  addServer(file, "notes", server);
  const added = readFileSync(file, "utf8");
  expect(added.startsWith(start.trimEnd())).toBe(true);
  expect(Bun.TOML.parse(added)).toEqual({ model: "x", mcp_servers: { other: { command: "/o", args: ["a"] }, notes: server }, profiles: { fast: { model: "y" } } });
  // Again, and with a table of its own in the middle: one entry, what it is now.
  addServer(file, "notes", { command: "/new", args: [] });
  expect((Bun.TOML.parse(readFileSync(file, "utf8")) as any).mcp_servers.notes).toEqual({ command: "/new", args: [] });
  writeFileSync(file, start.replace("# about profiles", '[mcp_servers.notes]\ncommand = "/old"\n[mcp_servers.notes.env]\nA = "1"\n\n# about profiles'));
  addServer(file, "notes", server);
  expect((Bun.TOML.parse(readFileSync(file, "utf8")) as any).mcp_servers.notes).toEqual(server);
  expect(readFileSync(file, "utf8")).toContain("# about profiles\n[profiles.fast]");
  removeServer(file, "notes");
  expect(readFileSync(file, "utf8")).toContain("# my settings");
  expect(Bun.TOML.parse(readFileSync(file, "utf8"))).toEqual(Bun.TOML.parse(start));
  removeServer(file, "notes"); // nothing to do
  // The only server: nothing of it left, and an empty file is fine.
  writeFileSync(file, "");
  addServer(file, "notes", server);
  removeServer(file, "notes");
  expect(readFileSync(file, "utf8")).toBe("");
});

test("Codex's TOML it can't edit safely: an error, and what's there stays", () => {
  const file = join(dir, "codex", "other.toml");
  for (const text of ["not toml at all [", 'mcp_servers = { other = { command = "/o" } }\n']) {
    writeFileSync(file, text);
    expect(() => addServer(file, "notes", { command: "/a", args: [] })).toThrow(/nothing was changed/);
    expect(readFileSync(file, "utf8")).toBe(text);
  }
  // Its name inside a string isn't its table.
  const inString = 'note = """\n[mcp_servers.notes]\ncommand = "/fake"\n"""\n';
  writeFileSync(file, inString);
  expect(() => addServer(file, "notes", { command: "/a", args: [] })).toThrow(/nothing was changed/);
  expect(readFileSync(file, "utf8")).toBe(inString);
});

test("a config stays what it was: private, and a link stays a link", () => {
  if (process.platform === "win32") return;
  for (const name of ["private.json", "private.toml"]) {
    const file = join(dir, name);
    writeFileSync(file, "", { mode: 0o600 });
    addServer(file, "notes", { command: "/a", args: [] });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const real = join(dir, `real-${name}`);
    writeFileSync(real, "", { mode: 0o640 });
    const link = join(dir, `link-${name}`);
    symlinkSync(real, link);
    addServer(link, "notes", { command: "/a", args: [] });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toContain("/a");
    expect(statSync(real).mode & 0o777).toBe(0o640);
  }
  const fresh = join(dir, "fresh", "new.json");
  addServer(fresh, "notes", { command: "/a", args: [] });
  expect(statSync(fresh).mode & 0o777).toBe(0o600);
});

test("which clients are here: their files, their folder from the environment, their command on PATH", () => {
  const home = join(dir, "clients-home");
  mkdirSync(home, { recursive: true });
  const none = { PATH: "" };
  const present = (env: Record<string, string> = none, platform = "darwin") => MCP_CLIENTS.filter((c) => clientPresent(c, platform, home, env));
  expect(present()).toEqual([]);
  mkdirSync(join(home, ".codex"));
  expect(present()).toEqual(["codex"]);
  writeFileSync(join(home, ".claude.json"), "{}");
  mkdirSync(join(home, ".cursor"));
  mkdirSync(join(home, "Library", "Application Support", "Claude"), { recursive: true });
  expect(present()).toEqual(["claude-desktop", "claude-code", "codex", "cursor"]);
  expect(present(none, "linux")).toEqual(["claude-code", "codex", "cursor"]); // no Claude Desktop there
  // Moved by the environment: that folder, not the usual one.
  expect(clientPresent("codex", "darwin", home, { CODEX_HOME: join(home, "nowhere"), PATH: "" })).toBe(false);
  expect(clientPresent("claude-code", "darwin", home, { CLAUDE_CONFIG_DIR: join(home, "nowhere"), PATH: "" })).toBe(false);
  // Installed, never run: its command on PATH.
  const bin = join(dir, "clients-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
  expect(clientPresent("codex", "darwin", join(dir, "empty-home"), { PATH: bin })).toBe(process.platform !== "win32");
});

test("host.mcp, in an app of its own: every client found, one at a time, and removed", async () => {
  const home = join(dir, "host-home");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".cursor"));
  writeFileSync(join(home, ".cursor", "mcp.json"), "{ broken");
  const script = `
    import { mcp } from ${JSON.stringify(here("./clients.ts"))};
    const out = {};
    out.all = await mcp.install();
    out.status = await mcp.status();
    out.absent = await mcp.install("claude-code").catch((e) => e.message);
    out.removing = await mcp.uninstall().catch((e) => e.message);
    out.after = await mcp.status();
    console.log(JSON.stringify(out));
  `;
  const proc = Bun.spawn([process.execPath, "--eval", script], {
    stdout: "pipe",
    stderr: "inherit",
    // No login shell here, nor the clients of this machine.
    env: { HOME: home, USERPROFILE: home, APPDATA: join(home, "roaming"), SHELL: "/nonexistent", PATH: "", KITOP_MCP: JSON.stringify(identity) },
  });
  const out = JSON.parse(await new Response(proc.stdout).text());
  expect(out.all.map((r: { client: string }) => r.client)).toEqual(["codex", "cursor"]);
  expect(out.all[0].error).toBeUndefined();
  expect(out.all[1].error).toMatch(/isn't valid JSON/); // one broken, the other still done
  expect(out.status.clients.codex).toMatchObject({ available: true, installed: true });
  expect(out.status.clients.cursor).toMatchObject({ available: true, installed: false });
  expect(out.status.clients["claude-code"]).toMatchObject({ available: false, installed: false });
  expect(out.absent).toMatch(/claude-code isn't on this machine/);
  expect(out.removing).toMatch(/isn't valid JSON/); // said, the others still done
  expect(out.after.clients.codex.installed).toBe(false);
  expect(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).toBe("{ broken");
}, 20_000);

test("names and places", () => {
  expect(serverName("Svelte Notes")).toBe("svelte-notes");
  expect(serverName("---")).toBe("app");
  expect(clientConfigPath("cursor", "linux", "/h")).toBe("/h/.cursor/mcp.json");
  expect(clientConfigPath("claude-desktop", "darwin", "/h")).toBe("/h/Library/Application Support/Claude/claude_desktop_config.json");
  expect(clientConfigPath("claude-desktop", "linux", "/h")).toBeNull();
  expect(clientConfigPath("claude-code", "linux", "/h", {})).toBe("/h/.claude.json");
  expect(clientConfigPath("claude-code", "linux", "/h", { CLAUDE_CONFIG_DIR: "/c" })).toBe("/c/.claude.json");
  expect(clientConfigPath("codex", "linux", "/h", {})).toBe("/h/.codex/config.toml");
  expect(clientConfigPath("codex", "linux", "/h", { CODEX_HOME: "/c" })).toBe("/c/config.toml");
  expect(serverCommand(identity, "/$bunfs/root/app", "/Apps/N.app/Contents/MacOS/N")).toEqual({ command: "/Apps/N.app/Contents/MacOS/N", args: ["--mcp"] });
  const dev = serverCommand(identity, "/x/vite.js", "/bin/bun");
  expect(dev.command).toBe("/bin/bun");
  expect(dev.args[0]).toEndWith("/mcp/bridge.ts");
  expect(JSON.parse(dev.args[1]!)).toEqual(identity);
});
