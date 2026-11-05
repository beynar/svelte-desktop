import { json } from '@sveltejs/kit';

// Where the app's MCP server stands (src/mcp.ts): what a settings page would show beside "Connect to Claude".
export const GET = async () => json(await host.mcp.status());
