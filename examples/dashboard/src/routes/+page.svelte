<script lang="ts">
	import { Tabs, TabBar, TabPanels } from '@svelte-desktop/shell/tabs';
	import { board, upcoming } from '#lib/data.svelte';

	const lists = [
		{ id: 'next', title: 'Next up', closable: false },
		{ id: 'doing', title: 'In progress', closable: false },
		{ id: 'done', title: 'Done', closable: false }
	];

	const counts = $derived(Object.fromEntries(board.columns.map((c) => [c.id, c.cards.length])));
	const events = $derived(upcoming());
	const time = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
	const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

	const stats = $derived([
		{ label: 'In progress', value: counts.doing ?? 0, hint: 'tasks being worked on' },
		{ label: 'In review', value: counts.review ?? 0, hint: 'waiting for sign-off' },
		{ label: 'Done', value: counts.done ?? 0, hint: 'shipped this cycle' },
		{ label: 'Upcoming', value: events.length, hint: 'events from today' }
	]);
</script>

<div class="flex flex-col gap-6 p-6">
	<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
		{#each stats as s (s.label)}
			<section class="border-neutral-muted bg-surface-raised rounded-lg border p-4">
				<p class="text-neutral-readable text-sm">{s.label}</p>
				<p class="text-neutral mt-1 text-3xl font-semibold tabular-nums">{s.value}</p>
				<p class="text-neutral-readable mt-1 text-xs">{s.hint}</p>
			</section>
		{/each}
	</div>

	<!-- Tabs inside a card: fixed (no close, no +), a segmented look, only the active panel rendered. -->
	<section class="border-neutral-muted bg-surface-raised rounded-lg border">
		<Tabs id="overview-lists" initial={lists}>
			<header class="border-neutral-muted flex items-center justify-between gap-3 border-b px-4 py-3">
				<h2 class="text-neutral font-medium">This week</h2>
				<TabBar label="Lists" class="segmented bg-surface-recessed rounded-md p-0.5" />
			</header>
			<TabPanels keepAlive={false} class="p-4">
				{#snippet children(t)}
					{#if t.id === 'next'}
						<ul class="flex flex-col gap-2">
							{#each events.slice(0, 6) as e (e.id)}
								<li class="flex items-center justify-between gap-3 text-sm">
									<span class="text-neutral truncate">{e.title}</span>
									<span class="text-neutral-readable shrink-0 tabular-nums">{e.allDay ? day.format(e.startsAt) : time.format(e.startsAt)}</span>
								</li>
							{:else}
								<li class="text-neutral-readable text-sm">Nothing scheduled.</li>
							{/each}
						</ul>
					{:else}
						<ul class="flex flex-col gap-2">
							{#each board.columns.find((c) => c.id === t.id)?.cards ?? [] as task (task.id)}
								<li class="text-sm">
									<p class="text-neutral">{task.title}</p>
									{#if task.description}<p class="text-neutral-readable text-xs">{task.description}</p>{/if}
								</li>
							{:else}
								<li class="text-neutral-readable text-sm">Nothing here.</li>
							{/each}
						</ul>
					{/if}
				{/snippet}
			</TabPanels>
		</Tabs>
	</section>
</div>

<style>
	/* A segmented control: the same TabBar, a third look. */
	:global(.segmented [role='tab']) {
		flex: 0 0 auto;
		min-width: 0;
		padding: 0.25rem 0.75rem;
		border-radius: 0.375rem;
		font-size: 0.8125rem;
		color: var(--color-neutral-readable);
	}
	:global(.segmented [role='tab'][data-active]) {
		background: var(--color-surface-raised);
		color: var(--color-neutral);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
	}
</style>
