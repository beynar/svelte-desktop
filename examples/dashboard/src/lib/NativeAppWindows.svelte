<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from 'entasis/button';
	let guarded = $state(false);
	let message = $state('Arm the guard, then request a quit. The first request is cancelled.');
	let events = $state<string[]>([]);
	let childId = $state<number | null>(null);
	let modalId = $state<number | null>(null);
	const log = (event: string) => { events = [event, ...events].slice(0, 8); };
	async function run(action: () => Promise<unknown>) {
		try { await action(); } catch (error) { log(String(error)); }
	}
	onMount(() => {
		const off = host.app.onQuitRequested(async ({ reason }) => {
			if (!guarded) return 'quit';
			guarded = false;
			message = `Cancelled (${reason}). The windows are intact. A second request will quit.`;
			return 'cancel';
		});
		const subscriptions = (['minimized', 'restored', 'fullscreenChanged', 'moved', 'resized'] as const).map((name) =>
			host.windows.on(name, (event) => log(`${name} · window ${event.windowId}`)));
		return () => { off(); subscriptions.forEach((stop) => stop()); };
	});
	async function child() {
		if (childId !== null) await host.windows.close(childId).catch(() => {});
		const parent = await host.windows.getInfo();
		const win = await host.windows.create({ parentId: parent.windowId, type: 'panel', focusable: false, title: 'Child panel', width: 300, height: 180,
			html: '<body style="font:16px system-ui;padding:24px;background:#f3f4f6">Move the parent window.<br>This nonfocusable panel follows it.</body>' });
		childId = win.windowId;
		log(`child ${win.windowId} attached to ${parent.windowId}`);
	}
	async function modal() {
		if (modalId !== null) await host.windows.close(modalId).catch(() => {});
		const parent = await host.windows.getInfo();
		const win = await host.windows.create({ parentId: parent.windowId, modal: true, title: 'Modal child', width: 380, height: 200,
			html: '<body style="font:16px system-ui;padding:24px;background:#f3f4f6">A native sheet: its parent cannot be edited.<br><button onclick="window.close()">Close sheet</button></body>' });
		modalId = win.windowId;
		log(`modal ${win.windowId} attached to ${parent.windowId}`);
	}
</script>

<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
	<h2 class="text-neutral text-base font-semibold">Quit guard</h2>
	<p class="text-neutral-readable text-sm">{message}</p>
	<div class="flex flex-wrap gap-2">
		<Button variant="outline" onclick={() => { guarded = true; message = 'Armed: the next quit request will be cancelled.'; }}>Arm guard</Button>
		<Button variant="outline" onclick={() => host.app.quit().catch((error) => { message = String(error); })}>Request quit</Button>
	</div>
</section>
<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
	<h2 class="text-neutral text-base font-semibold">Child windows</h2>
	<p class="text-neutral-readable text-sm">A panel follows its parent. A modal child is a native sheet. Transition events arrive after macOS completes them.</p>
	<div class="flex flex-wrap gap-2">
		<Button variant="outline" onclick={() => run(child)}>Open child panel</Button>
		<Button variant="outline" onclick={() => run(modal)}>Open modal</Button>
		<Button variant="outline" onclick={async () => {
			if (modalId !== null) await host.windows.close(modalId).catch(() => {});
			if (childId !== null) await host.windows.close(childId).catch(() => {});
			modalId = childId = null;
		}}>Close children</Button>
		<Button variant="outline" onclick={() => run(async () => { await host.window.minimize(); setTimeout(() => void run(() => host.window.unminimize()), 1500); })}>Minimize / restore</Button>
		<Button variant="outline" onclick={() => run(() => host.window.toggleFullscreen())}>Full screen</Button>
	</div>
	<pre class="text-neutral-readable overflow-auto text-xs">{events.join('\n') || 'No transitions yet.'}</pre>
</section>
