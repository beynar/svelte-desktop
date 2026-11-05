// host.mcp: connects the app's MCP server (src/mcp.ts) to agents' clients, from a button in the app:
// the entry in each client's own config file, found on this machine. Other clients take `command`
// and `args`.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shellEnv } from "../shell-env.ts";
import { isCompiledBinary } from "../updater/platform.ts";
import { IDENTITY_ENV, toolsFile, type McpIdentity } from "./files.ts";

export const MCP_CLIENTS = ["claude-desktop", "claude-code", "codex", "cursor"] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

export interface McpClientStatus {
  /** Its config file. Null where that client doesn't exist (Claude Desktop on Linux). */
  path: string | null;
  /** The client is on this machine: its files, or its command on the user's PATH. */
  available: boolean;
  /** Its config has this app, as it is now (moved, the app has to be installed again). */
  installed: boolean;
}

export interface McpStatus {
  /** The app has an MCP server (src/mcp.ts), and is running under the shell. */
  available: boolean;
  /** Its name in a client's config. */
  name: string | null;
  /** What a client starts, for any other client's config. */
  command: string | null;
  args: string[];
  /** The tools' names. */
  tools: string[];
  clients: Record<McpClient, McpClientStatus>;
}

/** What `install()` did for one client found on this machine. */
export interface McpInstallResult {
  client: McpClient;
  path: string;
  /** Why this one wasn't changed; the others still were. */
  error?: string;
}

type Server = { command: string; args: string[] };
type Env = Record<string, string | undefined>;

const identity = (): McpIdentity | null => {
  const raw = process.env[IDENTITY_ENV];
  return raw ? (JSON.parse(raw) as McpIdentity) : null;
};

/** A built app starts itself with --mcp; under `vite dev`, Bun runs the bridge from its source. */
export function serverCommand(id: McpIdentity, main = Bun.main, execPath = process.execPath): Server {
  if (isCompiledBinary(main)) return { command: process.env.APPIMAGE ?? execPath, args: ["--mcp"] };
  return { command: execPath, args: [fileURLToPath(new URL("./bridge.ts", import.meta.url)), JSON.stringify(id)] };
}

export const serverName = (appName: string) => appName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";

/** Where a client is: its config file, and what says it's on this machine (that file may not exist yet). */
function placeOf(client: McpClient, platform: string, home: string, env: Env): { path: string; marks: string[]; command?: string } | null {
  switch (client) {
    case "claude-desktop": {
      const folder = platform === "darwin" ? join(home, "Library", "Application Support", "Claude") : platform === "win32" ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude") : null;
      return folder ? { path: join(folder, "claude_desktop_config.json"), marks: [folder] } : null;
    }
    case "claude-code": {
      const folder = env.CLAUDE_CONFIG_DIR;
      return { path: join(folder ?? home, ".claude.json"), marks: folder ? [folder] : [join(home, ".claude"), join(home, ".claude.json")], command: "claude" };
    }
    case "codex": {
      const folder = env.CODEX_HOME ?? join(home, ".codex");
      return { path: join(folder, "config.toml"), marks: [folder], command: "codex" };
    }
    case "cursor": {
      const folder = join(home, ".cursor");
      return { path: join(folder, "mcp.json"), marks: [folder] };
    }
  }
}

/** A client's config file. */
export function clientConfigPath(client: McpClient, platform: string = process.platform, home: string = homedir(), env: Env = process.env): string | null {
  return placeOf(client, platform, home, env)?.path ?? null;
}

/** Whether a client is on this machine. */
export function clientPresent(client: McpClient, platform: string = process.platform, home: string = homedir(), env: Env = process.env): boolean {
  const place = placeOf(client, platform, home, env);
  if (!place) return false;
  return place.marks.some((mark) => existsSync(mark)) || (!!place.command && !!Bun.which(place.command, { PATH: env.PATH ?? "" }));
}

/** Replaces a file at once, as what it is: a link stays a link, a private file stays private. */
function writeFile(path: string, text: string) {
  const target = existsSync(path) ? realpathSync(path) : path;
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, text, { mode });
    chmodSync(temp, mode);
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

// A JSON config: `mcpServers` at its top. Not JSON: an error, rather than writing over what's there.
type JsonConfig = { mcpServers?: Record<string, Partial<Server>> } & Record<string, unknown>;

function readJson(path: string): JsonConfig {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`host.mcp: ${path} isn't valid JSON: fix it first, nothing was changed`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`host.mcp: ${path} isn't a JSON object: nothing was changed`);
  return parsed as JsonConfig;
}

const writeJson = (path: string, config: JsonConfig) => writeFile(path, `${JSON.stringify(config, null, 2)}\n`);

// A TOML config (Codex): `[mcp_servers.<name>]`. Bun reads TOML but doesn't write it, and rewriting
// would lose the user's comments: the text is edited, then read back, and must say exactly what's
// expected, or nothing is written.
type TomlConfig = { mcp_servers?: Record<string, Partial<Server>> } & Record<string, unknown>;

const tryToml = (text: string): TomlConfig | null => {
  try {
    return Bun.TOML.parse(text) as TomlConfig;
  } catch {
    return null;
  }
};

function parseToml(path: string, text: string): TomlConfig {
  const config = tryToml(text);
  if (!config) throw new Error(`host.mcp: ${path} isn't valid TOML: fix it first, nothing was changed`);
  return config;
}

/** The text without this server's tables. Comments and blank lines stay: they may be the next table's. */
function withoutTomlServer(text: string, name: string): string {
  const own = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*"?${name}"?\\s*(\\.[^\\]]*)?\\]\\s*(#.*)?$`);
  const table = /^\s*\[\[?[^[\]]+\]\]?\s*(#.*)?$/;
  let skipping = false;
  return text
    .split(/(?<=\n)/)
    .filter((line) => {
      const isTable = table.test(line.trimEnd());
      if (isTable) skipping = own.test(line.trimEnd());
      return !skipping || (!isTable && /^\s*(#|$)/.test(line));
    })
    .join("");
}

function writeToml(path: string, text: string, expected: TomlConfig) {
  if (!Bun.deepEquals(tryToml(text), expected)) throw new Error(`host.mcp: ${path} is written in a way this can't edit safely: nothing was changed`);
  writeFile(path, text);
}

function addToml(path: string, name: string, server: Server) {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const config = parseToml(path, text);
  const rest = withoutTomlServer(text, name).trimEnd();
  const entry = `[mcp_servers.${name}]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n`;
  writeToml(path, rest ? `${rest}\n\n${entry}` : entry, { ...config, mcp_servers: { ...config.mcp_servers, [name]: server } });
}

function removeToml(path: string, name: string) {
  const text = readFileSync(path, "utf8");
  const config = parseToml(path, text);
  if (!config.mcp_servers || !Object.hasOwn(config.mcp_servers, name)) return;
  const { [name]: _, ...others } = config.mcp_servers;
  const edited = withoutTomlServer(text, name);
  const next = edited.trim() ? `${edited.trimEnd()}\n` : "";
  const expected: TomlConfig = { ...config, mcp_servers: others };
  // Its table was the only thing that made `mcp_servers`: gone with it.
  if (!Object.keys(others).length && !tryToml(next)?.mcp_servers) delete expected.mcp_servers;
  writeToml(path, next, expected);
}

const isToml = (path: string) => path.endsWith(".toml");
const serversIn = (path: string) => (isToml(path) ? (existsSync(path) ? parseToml(path, readFileSync(path, "utf8")).mcp_servers : undefined) : readJson(path).mcpServers);

/** Adds this server to a config, what's there staying. */
export function addServer(path: string, name: string, server: Server) {
  if (isToml(path)) return addToml(path, name, server);
  const config = readJson(path);
  writeJson(path, { ...config, mcpServers: { ...config.mcpServers, [name]: server } });
}

/** Removes this server from a config. */
export function removeServer(path: string, name: string) {
  if (!existsSync(path)) return;
  if (isToml(path)) return removeToml(path, name);
  const config = readJson(path);
  if (!config.mcpServers || !Object.hasOwn(config.mcpServers, name)) return;
  const { [name]: _, ...rest } = config.mcpServers;
  writeJson(path, { ...config, mcpServers: rest });
}

function clientStatus(client: McpClient, env: Env, name: string | null, server: Server | null): McpClientStatus {
  const path = clientConfigPath(client, process.platform, homedir(), env);
  if (!path) return { path: null, available: false, installed: false };
  let installed = false;
  try {
    const entry = name && server ? serversIn(path)?.[name] : undefined;
    installed = !!entry && entry.command === server!.command && Bun.deepEquals(entry.args ?? [], server!.args);
  } catch {}
  return { path, available: clientPresent(client, process.platform, homedir(), env), installed };
}

/** As the user's terminal sees it (CODEX_HOME, PATH…): an app opened from the Finder doesn't. */
const userEnv = (): Promise<Env> => shellEnv();

async function install(): Promise<McpInstallResult[]>;
async function install(client: McpClient): Promise<{ path: string }>;
async function install(client?: McpClient): Promise<McpInstallResult[] | { path: string }> {
  const id = identity();
  if (!id) throw new Error("host.mcp: nothing to connect: the app has no src/mcp.ts");
  const env = await userEnv();
  const home = homedir();
  const add = (path: string) => addServer(path, serverName(id.appName), serverCommand(id));
  if (client) {
    const path = clientConfigPath(client, process.platform, home, env);
    if (!path || !clientPresent(client, process.platform, home, env)) throw new Error(`host.mcp: ${client} isn't on this machine`);
    add(path);
    return { path };
  }
  return MCP_CLIENTS.filter((one) => clientPresent(one, process.platform, home, env)).map((one) => {
    const path = clientConfigPath(one, process.platform, home, env)!;
    try {
      add(path);
      return { client: one, path };
    } catch (err) {
      return { client: one, path, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

export const mcp = {
  /** Whether the app has an MCP server, what a client starts, and where each client stands. */
  async status(): Promise<McpStatus> {
    const env = await userEnv();
    const id = identity();
    const server = id && serverCommand(id);
    const name = id && serverName(id.appName);
    let tools: string[] = [];
    if (id) {
      try {
        tools = (JSON.parse(readFileSync(toolsFile(id.identifier), "utf8")) as { tools: { name: string }[] }).tools.map((t) => t.name);
      } catch {}
    }
    return {
      available: !!id,
      name,
      command: server?.command ?? null,
      args: server?.args ?? [],
      tools,
      clients: Object.fromEntries(MCP_CLIENTS.map((client) => [client, clientStatus(client, env, name, server)])) as Record<McpClient, McpClientStatus>,
    };
  },

  /** Adds the app to every client on this machine, or to this one (which throws what goes wrong).
   *  A client reads its config when it starts: restart it. */
  install,

  /** Removes the app from every client's config, or from this one. */
  async uninstall(client?: McpClient): Promise<void> {
    const id = identity();
    if (!id) return;
    const env = await userEnv();
    const errors: unknown[] = [];
    for (const one of client ? [client] : MCP_CLIENTS) {
      const path = clientConfigPath(one, process.platform, homedir(), env);
      try {
        if (path) removeServer(path, serverName(id.appName));
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length) throw errors[0];
  },
};
