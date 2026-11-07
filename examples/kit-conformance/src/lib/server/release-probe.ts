// tests/release.test.ts: a build without a test channel can't be asked from outside, so its server
// code says what it finds, into the file KIT_PROBE names.
import { onDesktopReady } from '@kitop/shell/server';

const file = Bun.env.KIT_PROBE;
if (file) onDesktopReady(() => void probe(file));

const inPage = <T>(code: string) => host.webview.executeJavaScript<T>(code, { windowId: 0 });
const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));

async function probe(out: string) {
	for (let i = 0; i < 400 && !(await inPage<boolean>(`document.documentElement.hasAttribute('data-desktop-hydrated')`).catch(() => false)); i++) await Bun.sleep(50);
	const page = await inPage(`(async () => {
		const clipboard = await host.clipboard.readText().then(() => 'ok', (e) => e.code);
		const window = await host.windows.getBounds().then(() => 'ok', (e) => e.code);
		const started = performance.now();
		const store = await host.store.load().then(() => ({ code: 'ok' }), (e) => ({ code: e.code, message: e.message }));
		return { clipboard, window, store: { ...store, ms: performance.now() - started }, devices: (await navigator.mediaDevices?.enumerateDevices())?.map((d) => d.kind) ?? [] };
	})()`);
	const native = {
		terminate: await outcome(callOp('webview', '_terminateForTesting', { windowId: 0 })),
		policy: await outcome(callOp('webview', '_permissionPolicyForTesting', { windowId: 0, permission: 'camera' })),
		testScroll: await outcome(callOp('window', 'testScroll', {})),
		simulateResponse: await outcome(callOp('notifications', 'simulateResponse', { id: 'x' }))
	};
	await Bun.write(out, JSON.stringify({ page, native, alive: await inPage('1 + 1') }));
}

const callOp = (service: string, op: string, args: Record<string, unknown>) => (host.native as any)[service][op](args) as Promise<unknown>;
