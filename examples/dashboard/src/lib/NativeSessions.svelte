<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Button } from 'entasis/button';
	let lines = $state<string[]>([]);
	let ready = $state(false);
	let proxyType = $state<'http' | 'socks'>('http');
	let proxyHost = $state('127.0.0.1');
	let proxyPort = $state(8080);
	const session = 'dashboard-private', id = 'dashboard-session-preview';
	const note = (s: string) => lines = [s, ...lines].slice(0, 8);
	async function run(action: () => Promise<unknown>) {
		try { await action(); } catch (e) { note((e as Error).message); }
	}
	async function create() {
		await host.sessions.create({ id: session, persistent: false });
		ready = true;
		note('Private profile ready; app authentication provisioned');
	}
	async function load(target: { route?: string; url?: string }) {
		if ((await host.view.list()).some((view) => view.id === id)) await host.view.navigate(id, target);
		else await host.view.create({ id, session, recovery: 'manual', ...target, hidden: true, bounds: { x: 0, y: 0, width: 320, height: 200 } });
	}
	async function preview() {
		await load({ route: '/' });
		note('App route loading in a private view (manual recovery)');
	}
	async function cookies() {
		const options = { session, url: location.origin, name: 'dashboard-profile-demo' };
		await host.sessions.cookies.set({ ...options, value: 'private', httpOnly: true });
		note(`Cookie read: ${(await host.sessions.cookies.get(options))[0]?.value}`);
		await host.sessions.cookies.remove(options);
	}
	async function remove() {
		await host.view.destroy(id).catch(() => {});
		await host.sessions.remove(session);
		ready = false;
		note('Private view and profile removed');
	}
	onMount(() => {
		const off = host.webview.onLifecycle((e) => {
			if (e.viewId === id) note(`${e.type}: ${e.url}${e.type === 'failed' ? ` (${e.domain} ${e.code})` : ''}`);
		});
		const changed = host.sessions.cookies.onChanged((e) => {
			if (e.session === session) note(`Cookie ${e.removed ? 'removed' : 'changed'}: ${e.cookie.name}`);
		});
		return () => { off(); changed(); };
	});
	onDestroy(() => { if (ready) void remove().catch(() => {}); });
</script>

<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
	<h2 class="text-neutral text-base font-semibold">Web view lifecycle</h2>
	<p class="text-neutral-readable text-sm">A private app preview with manual crash recovery. Observe load failures, then explicitly reload the view.</p>
	<div class="flex flex-wrap gap-2">
		<Button variant="outline" disabled={!ready} onclick={() => run(preview)}>Load app preview</Button>
		<Button variant="outline" disabled={!ready} onclick={() => run(() => load({ url: 'http://127.0.0.1:59999/' }))}>Fail a load</Button>
		<Button variant="outline" disabled={!ready} onclick={() => run(() => host.webview.reload({ viewId: id }))}>Reload preview</Button>
	</div>
</section>
<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
	<h2 class="text-neutral text-base font-semibold">Sessions, cookies and proxy</h2>
	<p class="text-neutral-readable text-sm">Separate cookies and storage; the shell's authentication cookie stays protected. Proxy configuration applies to WebKit on macOS 14+.</p>
	<div class="text-neutral-readable flex flex-wrap items-center gap-2 text-sm">
		<label>Proxy <select bind:value={proxyType} class="border-neutral-muted rounded border p-1"><option value="http">HTTP CONNECT</option><option value="socks">SOCKSv5</option></select></label>
		<label>Host <input bind:value={proxyHost} class="border-neutral-muted w-32 rounded border p-1" /></label>
		<label>Port <input type="number" min="1" max="65535" bind:value={proxyPort} class="border-neutral-muted w-20 rounded border p-1" /></label>
		<Button variant="outline" disabled={!ready} onclick={() => run(async () => { await host.sessions.setProxy(session, { type: proxyType, host: proxyHost, port: proxyPort }); note('Private profile proxy configured'); })}>Apply proxy</Button>
	</div>
	<div class="flex flex-wrap gap-2">
		<Button variant="outline" disabled={ready} onclick={() => run(create)}>Create private profile</Button>
		<Button variant="outline" disabled={!ready} onclick={() => run(cookies)}>Set / read / remove cookie</Button>
		<Button variant="outline" onclick={() => run(async () => note(JSON.stringify(await host.sessions.capabilities())))}>Proxy capabilities</Button>
		<Button variant="outline" disabled={!ready} onclick={() => run(async () => { await host.sessions.setProxy(session, null); note('System proxy defaults restored'); })}>Reset proxy</Button>
		<Button variant="outline" disabled={!ready} onclick={() => run(remove)}>Remove profile</Button>
	</div>
	{#if lines.length}<pre class="text-neutral-readable overflow-auto text-xs">{lines.join('\n')}</pre>{/if}
</section>
