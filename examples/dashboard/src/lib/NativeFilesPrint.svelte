<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from 'entasis/button';
	import type { DownloadRecord } from '@svelte-desktop/shell/platform';
	let items = $state<DownloadRecord[]>([]);
	let message = $state({ downloads: '', print: '', bookmarks: '' });
	let url = $state('');
	let destination = $state('');
	let removeHandler: (() => Promise<void>) | undefined;
	let deciding = $state(false);
	let changingDecision = $state(false);
	let destroyed = false;
	const run = async (kind: keyof typeof message, action: () => Promise<unknown>) => {
		try { const result = await action(); message[kind] = JSON.stringify(result, null, 2) ?? 'Done'; if (kind === 'downloads') items = await host.downloads.list(); }
		catch (error) { message[kind] = (error as Error).message; }
	};
	onMount(() => {
		void host.downloads.list().then((list) => items = list).catch((error) => message.downloads = (error as Error).message);
		const off = host.downloads.onChanged((item) => items = [item, ...items.filter((d) => d.id !== item.id)]);
		return () => { destroyed = true; off(); void removeHandler?.(); };
	});
	async function toggleDecision() {
		if (changingDecision) return;
		changingDecision = true;
		try {
			if (removeHandler) { await removeHandler(); removeHandler = undefined; deciding = false; return; }
			const off = await host.downloads.onRequested(() => destination.trim() ? { path: destination.trim() } : 'cancel');
			if (destroyed) await off();
			else { removeHandler = off; deciding = true; }
		} finally { changingDecision = false; }
	}
</script>

<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4" data-native-downloads>
	<h2 class="text-neutral text-base font-semibold">Downloads</h2>
	<p class="text-neutral-readable text-sm">Choose a path before WebKit saves data. Pause cancels the transfer and retains resume data when available. History survives relaunch.</p>
	<input aria-label="Download URL" class="rounded border p-2 text-sm" bind:value={url} placeholder="http://127.0.0.1:…/file" />
	<input aria-label="Download destination" class="rounded border p-2 text-sm" bind:value={destination} placeholder="/absolute/path/to/file" />
	<div class="flex flex-wrap gap-2">
		<Button variant="outline" disabled={changingDecision} onclick={() => run('downloads', toggleDecision)}>{deciding ? 'Stop choosing paths' : 'Choose this path (empty cancels)'}</Button>
		<Button variant="outline" disabled={!url} onclick={() => run('downloads', () => host.webview.download(url))}>Download</Button>
		<Button variant="outline" onclick={() => run('downloads', () => host.downloads.list().then((list) => list.map(({ resumeData, ...record }) => record)))}>History</Button>
	</div>
	{#each items.slice(0, 5) as item (item.id)}
		<div class="flex flex-wrap items-center gap-2 text-xs">
			<span>{item.suggestedFilename || item.url}: {item.state} · {item.receivedBytes} / {item.totalBytes}</span>
			{#if item.state === 'downloading'}
				<Button variant="outline" size="small" onclick={() => run('downloads', () => host.downloads.pause(item.id).then(({ resumeData, ...r }) => r))}>Pause</Button>
				<Button variant="outline" size="small" onclick={() => run('downloads', () => host.downloads.cancel(item.id).then(({ resumeData, ...r }) => r))}>Cancel</Button>
			{:else if item.canResume}
				<Button variant="outline" size="small" onclick={() => run('downloads', () => host.downloads.resume(item.id))}>Resume</Button>
			{/if}
		</div>
	{/each}
	{#if message.downloads}<pre class="text-neutral-readable max-h-40 overflow-auto text-xs">{message.downloads}</pre>{/if}
</section>
<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4" data-native-print>
	<h2 class="text-neutral text-base font-semibold">Print and PDF</h2>
	<p class="text-neutral-readable text-sm">List installed printers without a panel, or save page 1 on A4 paper.</p>
	<div class="flex flex-wrap gap-2">
		<Button variant="outline" onclick={() => run('print', () => host.webview.getPrinters())}>List printers</Button>
		<Button variant="outline" onclick={() => run('print', async () => { const temp = await host.app.getPath('temp'); return host.webview.printToPDF(`${temp}/dashboard-page-1.pdf`, { pageRanges: [{ from: 1, to: 1 }], paperSize: { width: 595, height: 842 }, margins: { top: 36, right: 36, bottom: 36, left: 36 } }); })}>Save first page to PDF</Button>
	</div>
	{#if message.print}<pre data-native-print-result class="text-neutral-readable max-h-40 overflow-auto text-xs">{message.print}</pre>{/if}
</section>
<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4" data-native-bookmarks>
	<h2 class="text-neutral text-base font-semibold">File bookmarks</h2>
	<p class="text-neutral-readable text-sm">Create and resolve a bookmark for the temporary folder, then release access. Security scopes matter in App Sandbox builds; ordinary bookmarks work outside the sandbox.</p>
	<div class="flex flex-wrap gap-2">
		<Button variant="outline" onclick={() => run('bookmarks', async () => { const temp = await host.app.getPath('temp'); const { bookmark } = await host.files.createBookmark(temp); const access = await host.files.openBookmark(bookmark); try { return { path: access.path, stale: access.stale }; } finally { await access.release(); } })}>Resolve temp bookmark</Button>
	</div>
	{#if message.bookmarks}<pre data-native-bookmark-result class="text-neutral-readable max-h-40 overflow-auto text-xs">{message.bookmarks}</pre>{/if}
</section>
