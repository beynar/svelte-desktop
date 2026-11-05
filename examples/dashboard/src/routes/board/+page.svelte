<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { boardFor } from '#lib/data.svelte';
	import BoardPanel from '#lib/BoardPanel.svelte';

	// Tabs in a page are plain Svelte: one board per tab, a board stays mounted once shown (scroll,
	// drag state), saved in host.store for the next launch, double-click a tab to rename it.
	type BoardTab = { value: string; label: string; board: string; pinned?: boolean };
	let boards = $state<BoardTab[]>([
		{ value: 'current', label: 'Current sprint', pinned: true, board: 'current' },
		{ value: 'backlog', label: 'Product backlog', board: 'backlog' }
	]);
	let active = $state('current');
	const seen = new SvelteSet(['current']);
	let renaming = $state<string | null>(null);

	function show(value: string) {
		active = value;
		seen.add(value);
	}

	function addBoard(label = `Board ${boards.length + 1}`) {
		const board = `board-${Date.now().toString(36)}`;
		boardFor(board);
		boards.push({ value: board, label, board });
		show(board);
	}

	function closeBoard(value: string) {
		const at = boards.findIndex((b) => b.value === value);
		boards.splice(at, 1);
		seen.delete(value);
		if (active === value) show(boards[Math.min(at, boards.length - 1)]!.value);
	}

	// New board…: a route of the app in a native sheet on the window (/sheets/new-board), sliding
	// down from under the tab strip; it resolves with what that page passes to host.dialog.close(),
	// undefined when canceled.
	async function newBoardInSheet() {
		const top = document.querySelector('.titlebar')?.getBoundingClientRect().bottom;
		const made = await host.dialog.sheet<{ name: string }>('/sheets/new-board', { width: 420, height: 230, style: 'attached', top });
		if (made) addBoard(made.name);
	}

	// Saved once what was saved before is back.
	const KEY = 'board-tabs';
	let restored = $state(false);
	onMount(async () => {
		const saved = (await host.store.load())[KEY] as { boards: BoardTab[]; active: string } | undefined;
		if (saved?.boards?.length) {
			boards = saved.boards;
			show(boards.some((b) => b.value === saved.active) ? saved.active : boards[0]!.value);
		}
		restored = true;
	});
	$effect(() => {
		if (restored) host.store.set(KEY, $state.snapshot({ boards, active }));
	});
</script>

<svelte:head><title>Board</title></svelte:head>

<div class="flex h-full flex-col">
	<div class="border-neutral-muted flex items-center border-b pr-4">
		<div role="tablist" aria-label="Boards" class="board-tabs flex min-w-0 flex-1 items-center gap-5 px-6">
			{#each boards as item (item.value)}
				<div
					role="tab"
					tabindex="0"
					aria-selected={item.value === active}
					data-active={item.value === active || undefined}
					onclick={() => show(item.value)}
					onkeydown={(e) => e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && show(item.value)}
				>
					{#if renaming === item.value}
						<!-- svelte-ignore a11y_autofocus -->
						<input
							class="text-neutral w-28 bg-transparent outline-none"
							value={item.label}
							autofocus
							onblur={(e) => ((item.label = e.currentTarget.value.trim() || item.label), (renaming = null))}
							onkeydown={(e) => {
								if (e.key === 'Enter') e.currentTarget.blur();
								if (e.key === 'Escape') renaming = null;
								e.stopPropagation();
							}}
						/>
					{:else}
						<span class="truncate" ondblclick={() => (renaming = item.value)} role="presentation">{item.label}</span>
					{/if}
					{#if !item.pinned}
						<button
							type="button"
							aria-label={`Close ${item.label}`}
							class="tab-close text-xs"
							onclick={(e) => (e.stopPropagation(), closeBoard(item.value))}>✕</button
						>
					{/if}
				</div>
			{/each}
			<button type="button" class="new-tab" aria-label="New board" onclick={() => addBoard()}>+</button>
		</div>
		<button type="button" class="state-layer text-neutral-readable h-7 shrink-0 rounded-md px-2 text-sm" onclick={newBoardInSheet}>New board…</button>
	</div>
	{#each boards as item (item.value)}
		{#if seen.has(item.value)}
			<div role="tabpanel" hidden={item.value !== active} class="board-panel min-h-0 flex-1 overflow-x-auto p-6">
				<BoardPanel id={item.board} />
			</div>
		{/if}
	{/each}
</div>

<style>
	/* An underline tab strip. */
	[role='tab'] {
		position: relative;
		display: flex;
		align-items: center;
		height: 2.5rem;
		padding: 0 0.25rem;
		gap: 0.5rem;
		min-width: 0;
		cursor: default;
		font-size: 0.875rem;
		color: var(--color-neutral-readable);
	}
	[role='tab'][data-active] {
		color: var(--color-neutral);
	}
	[role='tab'][data-active]::after {
		content: '';
		position: absolute;
		inset: auto 0 -1px;
		height: 2px;
		border-radius: 1px;
		background: var(--color-primary);
	}
	[role='tab']:not(:hover) .tab-close {
		visibility: hidden;
	}
	.new-tab {
		margin-left: 0.5rem;
		font-size: 1.125rem;
		color: var(--color-neutral-readable);
	}
</style>
