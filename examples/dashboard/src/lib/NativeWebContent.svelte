<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Button } from 'entasis/button';
	let rulesMessage = $state('');
	let streamMessage = $state('');
	let worldMessage = $state('');
	let streaming = $state(false);
	let stream = $state<HTMLIFrameElement>();
	async function rules() {
		try {
			await host.webview.setContentRules({ id: 'dashboard-content', rules: [{ trigger: { 'url-filter': 'asset://dashboard/image\\.svg' }, action: { type: 'block' } }] });
			const image = new Image();
			const result = new Promise<string>(resolve => { image.onload = () => resolve('Image loaded'); image.onerror = () => resolve('URL blocked by WebKit'); });
			image.src = `asset://dashboard/image.svg?blocked=${Date.now()}`;
			rulesMessage = await result;
		} catch (e) { rulesMessage = String(e); }
		finally { await host.webview.removeContentRules('dashboard-content').catch(() => {}); }
	}
	async function worlds() {
		try {
			await host.webview.scripts.register({ id: 'dashboard-isolated', source: 'globalThis.scriptInstalled = true', timing: 'start', world: 'dashboard-isolated' });
			await host.webview.executeJavaScript('globalThis.dashboardPageOnly = 42');
			const isolated = await host.webview.executeJavaScript('({ page: typeof dashboardPageOnly, bridge: typeof host, shell: typeof __shell })', { world: 'dashboard-isolated' });
			const page = await host.webview.executeJavaScript('dashboardPageOnly', { world: 'page' });
			worldMessage = `Isolated: ${JSON.stringify(isolated)}; page world: ${page}. Registered scripts run on the next document.`;
		} catch (e) { worldMessage = String(e); }
	}
	async function stop() {
		streaming = false;
		if (stream) stream.src = 'about:blank';
		await new Promise(resolve => setTimeout(resolve, 150));
		const stats = await fetch('/native/assets').then(r => r.json());
		streamMessage = `Worker streamed ${stats.bytes.toLocaleString()} bytes; ${stats.cancelled} cancelled, ${stats.completed} completed.`;
	}
	onDestroy(() => {
		if (typeof window === 'undefined' || !host.available) return;
		void host.webview.removeContentRules('dashboard-content').catch(() => {});
		void host.webview.scripts.unregister('dashboard-isolated').catch(() => {});
	});
</script>

<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4" data-web-content>
	<h2 class="text-neutral text-base font-semibold">WebKit content rules</h2>
	<p class="text-neutral-readable text-sm">Block a custom resource URL. The app origin and its bridge stay available.</p>
	<Button variant="outline" onclick={rules}>Block a URL</Button>
	<output class="text-neutral-readable text-xs">{rulesMessage}</output>
</section>
<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
	<h2 class="text-neutral text-base font-semibold">Custom resource protocols</h2>
	<p class="text-neutral-readable text-sm">This image comes from a Response in the Bun Worker. Start an 8 MB stream, then cancel it.</p>
	<img src="asset://dashboard/image.svg" alt="Resource served by the asset protocol" width="160" height="64" />
	<Button variant="outline" disabled={streaming} onclick={() => streaming = true}>Stream a large body</Button>
	<Button variant="outline" disabled={!streaming} onclick={stop}>Cancel stream</Button>
	<output class="text-neutral-readable text-xs">{streamMessage}</output>
	{#if streaming}<iframe bind:this={stream} src="asset://dashboard/stream" title="Worker resource stream" style="width:100%;height:100px;border:0"></iframe>{/if}
</section>
<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
	<h2 class="text-neutral text-base font-semibold">User scripts &amp; content worlds</h2>
	<p class="text-neutral-readable text-sm">Named worlds share the document, with separate JavaScript globals and no host bridge.</p>
	<Button variant="outline" onclick={worlds}>Compare worlds</Button>
	<output class="text-neutral-readable text-xs" style="overflow-wrap:anywhere">{worldMessage}</output>
</section>
