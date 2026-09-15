<script lang="ts">
	import { query, command } from './remote.svelte.js';
	import { getNotes, addNote, runtimeInfo } from './server.ts';

	let count = $state(0);
	let showNotes = $state(true);

	const notes = query(() => getNotes())();
	const runtime = query(() => runtimeInfo())();
	const add = command(async (text: string) => addNote(text));
	let next = $state(1);
</script>

<div style="display: flex; flexDirection: column; padding: 24px; gap: 12px; backgroundColor: #0f1115; height: 600px">
	<div style="fontSize: 20px; color: #e5e7eb">svelte → gpuix (native GPUI)</div>
	<div style="color: #9ca3af; fontSize: 12px">{runtime.current ?? '…'}</div>

	<div
		style="backgroundColor: #3b82f6; borderRadius: 8px; padding: 12px; color: #ffffff"
		onclick={() => count++}
	>
		click me — count: {count}
	</div>

	<div
		style="backgroundColor: #374151; borderRadius: 8px; padding: 10px; color: #d1d5db"
		onclick={() => (showNotes = !showNotes)}
	>
		{showNotes ? 'hide' : 'show'} notes ({notes.current?.length ?? 0})
	</div>

	{#if showNotes}
		<div style="display: flex; flexDirection: column; gap: 6px">
			{#each notes.current ?? [] as note (note.id)}
				<div style="backgroundColor: #1f2937; borderRadius: 6px; padding: 8px; color: #e5e7eb; fontSize: 12px">
					#{note.id} — {note.text}
				</div>
			{/each}
		</div>
	{/if}

	<div
		style="backgroundColor: #059669; borderRadius: 8px; padding: 10px; color: #ffffff"
		onclick={() => { void add(`note ${next++} @ ${Date.now() % 1000}`); }}
	>
		{add.pending ? 'saving…' : 'add note via remote command → bun:sqlite'}
	</div>
</div>
