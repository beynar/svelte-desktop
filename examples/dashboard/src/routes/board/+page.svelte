<script lang="ts">
	import { Kanban } from 'entasis/kanban';
	import { Tabs, TabBar, TabPanels } from '@svelte-desktop/shell/tabs';
	import { boardFor, boards } from '#lib/data.svelte';

	// Tabs inside a page: one board per tab, plain state (not routes). Kept alive, so each board
	// keeps its scroll and drag state; restored at the next launch; double-click a tab to rename it.
	let count = 2;
	const tabs = new Tabs<{ board: string }>({
		id: 'boards',
		restore: true,
		initial: [
			{ id: 'current', title: 'Current sprint', data: { board: 'current' }, pinned: true },
			{ id: 'backlog', title: 'Product backlog', data: { board: 'backlog' } }
		],
		create: () => {
			const board = `board-${Date.now().toString(36)}`;
			boardFor(board);
			return { title: `Board ${++count}`, data: { board } };
		}
	});
	// A restored tab's board (from a past session) exists before its panel renders.
	$effect.pre(() => {
		for (const t of tabs.items) if (t.data) boardFor(t.data.board);
	});

	let renaming = $state<string | null>(null);
	const rename = (id: string, title: string) => {
		if (title.trim()) tabs.update(id, { title: title.trim() });
		renaming = null;
	};
</script>

<div class="flex h-full flex-col">
	<TabBar {tabs} label="Boards" newTabLabel="New board" class="board-tabs border-neutral-muted gap-5 border-b px-6">
		{#snippet tab(t, { close })}
			{#if renaming === t.id}
				<!-- svelte-ignore a11y_autofocus -->
				<input
					class="text-neutral w-28 bg-transparent outline-none"
					value={t.title}
					autofocus
					onmousedown={(e) => e.stopPropagation()}
					onblur={(e) => rename(t.id, e.currentTarget.value)}
					onkeydown={(e) => {
						if (e.key === 'Enter') rename(t.id, e.currentTarget.value);
						if (e.key === 'Escape') renaming = null;
						e.stopPropagation();
					}}
				/>
			{:else}
				<span class="truncate" ondblclick={() => (renaming = t.id)} role="presentation">{t.title}</span>
			{/if}
			{#if !t.pinned}
				<button type="button" aria-label={`Close ${t.title}`} class="tab-close text-xs" onmousedown={(e) => e.stopPropagation()} onclick={close}>✕</button>
			{/if}
		{/snippet}
	</TabBar>

	<TabPanels {tabs} class="min-h-0 flex-1 overflow-x-auto p-6">
		{#snippet children(t)}
			{@const board = boards[t.data!.board]}
			{#if board}
				<Kanban bind:columns={() => board.columns, (columns) => (board.columns = columns)} columnHeight="calc(100vh - 15rem)" />
			{/if}
		{/snippet}
	</TabPanels>
</div>

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
