<script lang="ts">
	import { Tabs } from '@svelte-desktop/shell/tabs';
	import { boardFor } from '#lib/data.svelte';
	import BoardPanel from '#lib/BoardPanel.svelte';

	// Tabs in a page, on your own list: one board per tab. Adding, closing and dragging write back to
	// `boards`; a board stays mounted once shown (scroll, drag state); restored at the next launch;
	// double-click a tab to rename it.
	type BoardTab = { value: string; label: string; board: string; pinned?: boolean };
	let boards = $state<BoardTab[]>([
		{ value: 'current', label: 'Current sprint', pinned: true, board: 'current' },
		{ value: 'backlog', label: 'Product backlog', board: 'backlog' }
	]);
	let active = $state('current');
	let count = 2;
	function newBoard(): BoardTab {
		const board = `board-${Date.now().toString(36)}`;
		boardFor(board);
		return { value: board, label: `Board ${++count}`, board };
	}

	let renaming = $state<string | null>(null);
</script>

<svelte:head><title>Board</title></svelte:head>

<Tabs
	bind:items={boards}
	bind:value={active}
	mount="once"
	persist="board-tabs"
	closable={(b) => !b.pinned}
	reorderable
	onAdd={newBoard}
	label="Boards"
	class="board-tabs border-neutral-muted gap-5 border-b px-6"
>
	{#snippet tab({ item, closable, close })}
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
		{#if closable}
			<button type="button" aria-label={`Close ${item.label}`} class="tab-close text-xs" onclick={close}>✕</button>
		{/if}
	{/snippet}

	{#snippet layout({ bar, content })}
		<div class="flex h-full flex-col">
			{@render bar()}
			{@render content({ class: 'min-h-0 flex-1 overflow-x-auto p-6' })}
		</div>
	{/snippet}

	{#snippet children({ item })}<BoardPanel id={item.board} />{/snippet}
</Tabs>

<style>
	/* An underline tab strip: another look for the same component. */
	:global(.board-tabs [role='tab']) {
		position: relative;
		height: 2.5rem;
		padding: 0 0.25rem;
		gap: 0.5rem;
		flex-basis: auto;
		font-size: 0.875rem;
		color: var(--color-neutral-readable);
	}
	:global(.board-tabs [role='tab'][data-active]) {
		color: var(--color-neutral);
	}
	:global(.board-tabs [role='tab'][data-active])::after {
		content: '';
		position: absolute;
		inset: auto 0 -1px;
		height: 2px;
		border-radius: 1px;
		background: var(--color-primary);
	}
	:global(.board-tabs [role='tab']:not(:hover) .tab-close) {
		visibility: hidden;
	}
	:global(.board-tabs [data-sd-tab-new]) {
		margin-left: 0.5rem;
		font-size: 1.125rem;
		color: var(--color-neutral-readable);
	}
</style>
