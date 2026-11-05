<!-- Every dialog side by side: the system's own (message box, open, save) and your route in each
     sheet style — try them and read what each one returns. -->
<script lang="ts">
	import { Button } from 'entasis/button';

	type Entry = { at: string; what: string; result: unknown };
	let log = $state<Entry[]>([]);
	const record = async (what: string, run: () => Promise<unknown>) => {
		try {
			log.unshift({ at: new Date().toLocaleTimeString(), what, result: await run() });
		} catch (e) {
			log.unshift({ at: new Date().toLocaleTimeString(), what, result: `error: ${(e as Error).message}` });
		}
	};
	// Where an attached sheet hangs: under the window's tab strip. In a pane there's none: where the system puts it.
	const top = () => document.querySelector('.titlebar')?.getBoundingClientRect().bottom;
	const route = '/sheets/new-board';
</script>

<svelte:head><title>Dialogs</title></svelte:head>

<div class="flex max-w-3xl flex-col gap-8">
	<section class="flex flex-col gap-3">
		<div>
			<h2 class="text-neutral text-base font-semibold">The system's dialogs</h2>
			<p class="text-neutral-readable text-sm">Native components (NSAlert, NSOpenPanel, NSSavePanel) as sheets on the window: their look, your texts.</p>
		</div>
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" onclick={() => record('message box · info', () => host.dialog.showMessageBox({ message: 'Board saved', detail: 'Your changes are in.', buttons: ['OK'] }))}>Message · info</Button>
			<Button variant="outline" onclick={() => record('message box · warning', () => host.dialog.showMessageBox({ type: 'warning', message: 'Close this board?', detail: 'Its cards stay in the archive.', buttons: ['Close', 'Cancel'], cancelId: 1 }))}>Message · warning</Button>
			<Button variant="outline" onclick={() => record('message box · critical', () => host.dialog.showMessageBox({ type: 'critical', message: 'Delete 12 cards?', detail: 'This can’t be undone.', buttons: ['Delete', 'Keep them'], cancelId: 1 }))}>Message · critical</Button>
			<Button variant="outline" onclick={() => record('open · files', () => host.dialog.showOpenDialog({ files: true, multiple: true, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'gif'] }] }))}>Open files…</Button>
			<Button variant="outline" onclick={() => record('open · folder', () => host.dialog.showOpenDialog({ directories: true, files: false, prompt: 'Choose' }))}>Choose a folder…</Button>
			<Button variant="outline" onclick={() => record('save', () => host.dialog.showSaveDialog({ suggestedName: 'board.json', filters: [{ name: 'JSON', extensions: ['json'] }] }))}>Save…</Button>
		</div>
	</section>

	<section class="flex flex-col gap-3">
		<div>
			<h2 class="text-neutral text-base font-semibold">Your route in a dialog</h2>
			<p class="text-neutral-readable text-sm">
				<code>host.dialog.sheet('{route}')</code>: the page alone, your components and styles; it returns what the page passes to
				<code>host.dialog.close()</code> — undefined on Escape, ⌘. or Cancel.
			</p>
		</div>
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" onclick={() => record("sheet · style 'sheet'", () => host.dialog.sheet(route, { width: 420, height: 230 }))}>System sheet</Button>
			<Button variant="outline" onclick={() => record("sheet · style 'attached'", () => host.dialog.sheet(route, { width: 420, height: 230, style: 'attached', top: top() }))}>Attached sheet</Button>
			<Button variant="outline" onclick={() => record("sheet · style 'window'", () => host.dialog.sheet(route, { width: 420, height: 230, style: 'window' }))}>Dialog window</Button>
		</div>
		<ul class="text-neutral-readable list-disc pl-5 text-sm">
			<li><b class="text-neutral font-medium">System sheet</b>: AppKit's own; on macOS 26 centered over a dimmed window.</li>
			<li><b class="text-neutral font-medium">Attached</b>: drawn by the shell, down from under the tab strip, the window left as it is.</li>
			<li><b class="text-neutral font-medium">Window</b>: a small titled window centered on this one; its close button cancels.</li>
		</ul>
	</section>

	<section class="flex flex-col gap-2">
		<h2 class="text-neutral text-base font-semibold">What they returned</h2>
		{#if log.length}
			<ol class="border-neutral-muted divide-neutral-muted divide-y rounded-lg border">
				{#each log as entry, i (log.length - i)}
					<li class="flex items-baseline gap-3 px-3 py-2 text-sm">
						<span class="text-neutral-readable tabular-nums">{entry.at}</span>
						<span class="text-neutral w-44 shrink-0">{entry.what}</span>
						<code class="text-neutral-readable min-w-0 truncate">{JSON.stringify(entry.result) ?? 'undefined'}</code>
					</li>
				{/each}
			</ol>
		{:else}
			<p class="text-neutral-readable text-sm">Nothing yet: open one above.</p>
		{/if}
	</section>
</div>
