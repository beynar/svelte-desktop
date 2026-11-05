// A pane's page is in its own web view: what's the window's (its material, its router) it asks of the
// window's page, the one of its own window.
let mine: Promise<number> | undefined;
const windowId = () => (mine ??= host.window.getInfo().then((info) => info.windowId));

export const inPane = () => '__desktopView' in globalThis;

export async function askWindow(channel: string, data: unknown): Promise<void> {
	const from = (globalThis as { __desktopView?: string }).__desktopView;
	await host.broadcast(channel, { windowId: await windowId(), from, data }).catch(() => {});
}

/** In the window's page. */
export function fromPanes<T>(channel: string, fn: (data: T, from: string) => void): () => void {
	return host.onBroadcast<{ windowId: number; from: string; data: T }>(channel, async (m) => {
		if (m.windowId === (await windowId())) fn(m.data, m.from);
	});
}
