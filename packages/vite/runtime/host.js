/**
 * Native dev host — runs inside Bun, spawned by configureServer.
 *
 * Connects to the vite dev server over a websocket carrying the HotChannel
 * protocol, then evaluates modules through vite's ModuleRunner instead of a
 * prebuilt bundle. Consequences:
 *
 *   .svelte edit    → self-accepting hmr swap (svelte's $.hmr wrapper — the
 *                     component re-runs, the rest of the tree keeps state)
 *   dead-end update → 'full-reload' → runner clears evaluated modules and
 *                     re-imports the entry → the entry remounts on the
 *                     persistent renderer (emit.js's __svelteNativeHost)
 *   vite restart    → ws closes → re-read dev.json (the port may have moved)
 *                     and re-import — the host stash still holds the window
 *
 * Env: SVELTE_NATIVE_ROOT (app root), SVELTE_NATIVE_DEVJSON (dev.json path
 * written by the plugin — {wsUrl, entry}).
 */
import { ModuleRunner, createWebSocketModuleRunnerTransport } from 'vite/module-runner';
import { readFileSync } from 'node:fs';

const devJsonPath = process.env.SVELTE_NATIVE_DEVJSON;
const readDev = () => JSON.parse(readFileSync(devJsonPath, 'utf8'));

let entryFailed = false;
let runner = null;
let transport = null;

async function importEntry() {
	const { entry } = readDev();
	try {
		await runner.import(entry);
		entryFailed = false;
	} catch (e) {
		entryFailed = true;
		console.error('[svelte-native]', e?.message ?? e);
	}
}

async function boot() {
	const { wsUrl } = readDev(); // re-read every connect — the port can move
	let socket;
	try {
		transport = createWebSocketModuleRunnerTransport({
			createConnection: () => (socket = new WebSocket(wsUrl)),
		});
	} catch {
		setTimeout(boot, 600);
		return;
	}
	// catch the transport's internal connect() rejection — ModuleRunner
	// discards it, so an early close surfaces as an unhandled rejection
	const origConnect = transport.connect?.bind(transport);
	if (origConnect) transport.connect = (h) => Promise.resolve(origConnect(h)).catch(() => {});
	// transport.send uses a `ws` closure only assigned after connect()
	// resolves — ModuleRunner calls send() before then and crashes.
	// Route through our `socket` reference directly instead.
	const origSend = transport.send.bind(transport);
	transport.send = (data) => {
		if (socket && socket.readyState === 1) {
			try { socket.send(JSON.stringify(data)); } catch {}
		}
	};
	const prev = runner;
	const myRunner = (runner = new ModuleRunner({
		root: process.env.SVELTE_NATIVE_ROOT ?? process.cwd(),
		transport,
		hmr: true,
	}));
	prev?.close?.().catch?.(() => {});

	// the runner owns the socket once connected; our listeners only observe
	// — the close listener is generation-tagged so a stale socket can't
	// reboot a healthy session
	socket?.addEventListener('close', () => {
		if (runner === myRunner) setTimeout(boot, 600);
	});
	socket?.addEventListener('message', ({ data }) => {
		// entry eval failed earlier → any incoming update is a reason to retry
		if (!entryFailed) return;
		try {
			const t = JSON.parse(data)?.type;
			if (t === 'update' || t === 'full-reload') setTimeout(importEntry, 60);
		} catch {}
	});

	// gate the first import on the socket being open — the transport's
	// connect() is unawaited internally, so fetchModule would race the
	// handshake and every fresh boot would stay a blank window
	if (socket && socket.readyState !== 1) {
		await new Promise((res, rej) => {
			socket.addEventListener('open', res, { once: true });
			socket.addEventListener('close', () => rej(new Error('ws closed before open')), { once: true });
		}).catch(() => {});
	}
	await importEntry();
}

await boot();
