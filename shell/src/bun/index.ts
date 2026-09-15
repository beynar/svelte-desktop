import { BrowserWindow, PATHS, Utils } from "electrobun/main";
import { existsSync } from "node:fs";
import { join } from "node:path";

// The adapter-bun SvelteKit server calls Bun.serve at import time. Wrap it to
// capture the bound URL (we request an ephemeral port below) and inject
// x-forwarded-proto so remote-function CSRF checks see the real http://
// origin — adapter-bun assumes TLS upstream like adapter-node.
process.env.HOST ??= "127.0.0.1";
process.env.PORT ??= "0";
process.env.PROTOCOL_HEADER ??= "x-forwarded-proto";

let kitUrl: string | null = null;
const realServe = Bun.serve;
Bun.serve = ((options: Bun.Serve.Options<unknown, string>) => {
	const innerFetch = options.fetch;
	options.fetch = (request: Request, server: Bun.Server) => {
		const headers = new Headers(request.headers);
		headers.set("x-forwarded-proto", "http");
		return innerFetch!(new Request(request, { headers }), server);
	};
	const server = realServe(options as never) as Bun.Server;
	kitUrl = server.url.toString();
	return server;
}) as typeof Bun.serve;

// Native capabilities injected into the kit server's global scope — remote
// functions reach them via globalThis.__nativeBridge (think window.__TAURI__,
// but server-side).
(globalThis as Record<string, unknown>).__nativeBridge = {
	showMessageBox: (opts: Parameters<typeof Utils.showMessageBox>[0]) =>
		Utils.showMessageBox(opts),
	quit: () => Utils.quit(),
};

const candidates = [
	process.env.KIT_ENTRY,
	join(PATHS.RESOURCES_FOLDER, "app/kit/index.js"),
	join(import.meta.dir, "kit/index.js"),
	join(import.meta.dir, "../kit/index.js"),
	join(import.meta.dir, "../../kit/index.js"),
].filter(Boolean) as string[];

const kitEntry = candidates.find((p) => existsSync(p));
if (!kitEntry) {
	throw new Error(`SvelteKit build not found; tried: ${candidates.join(", ")}`);
}

await import(kitEntry);
Bun.serve = realServe;

if (!kitUrl) {
	throw new Error("SvelteKit server did not call Bun.serve on import");
}
console.log(`[shell] SvelteKit server at ${kitUrl} (entry: ${kitEntry})`);

new BrowserWindow({
	title: "svelte-desktop",
	url: kitUrl,
	frame: {
		width: 1120,
		height: 760,
		x: 120,
		y: 80,
	},
});
