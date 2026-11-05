// Where an app's MCP server (src/mcp.ts) can be found, in its data directory:
//   mcp/tools.json     what the tools are, there when the app isn't running
//   mcp/endpoint.json  where this running app is and its token (the user's only), gone when it quits
// No SDK here: host.mcp reads these in every app, and only an app with src/mcp.ts carries the SDK.
import { join } from "node:path";
import { appDirs } from "../os.ts";

/** Which app, for host.mcp and for the bridge in dev. */
export const IDENTITY_ENV = "SVELTE_DESKTOP_MCP";
export interface McpIdentity {
  identifier: string;
  appName: string;
  version: string;
}

export interface McpAddress {
  url: string;
  token: string;
}

/** The app's side, once it's serving. */
export interface McpEndpoint {
  /** The tools as they are now, for clients to read (they changed, in dev). */
  publish(): Promise<void>;
  stop(): void;
}

export const toolsFile = (identifier: string) => join(appDirs(identifier).data, "mcp", "tools.json");
export const endpointFile = (identifier: string) => join(appDirs(identifier).data, "mcp", "endpoint.json");
