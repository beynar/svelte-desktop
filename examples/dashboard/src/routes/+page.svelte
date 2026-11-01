<script lang="ts">
	import { board, upcoming } from '#lib/data.svelte';

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

	<div class="grid gap-4 lg:grid-cols-2">
		<section class="border-neutral-muted bg-surface-raised rounded-lg border p-4">
			<header class="mb-3 flex items-center justify-between">
				<h2 class="text-neutral font-medium">Next up</h2>
				<a href="/calendar" class="text-primary-readable text-sm">Open calendar</a>
			</header>
			<ul class="flex flex-col gap-2">
				{#each events.slice(0, 5) as e (e.id)}
					<li class="flex items-center justify-between gap-3 text-sm">
						<span class="text-neutral truncate">{e.title}</span>
						<span class="text-neutral-readable shrink-0 tabular-nums">{e.allDay ? day.format(e.startsAt) : time.format(e.startsAt)}</span>
					</li>
				{:else}
					<li class="text-neutral-readable text-sm">Nothing scheduled.</li>
				{/each}
			</ul>
		</section>

		<section class="border-neutral-muted bg-surface-raised rounded-lg border p-4">
			<header class="mb-3 flex items-center justify-between">
				<h2 class="text-neutral font-medium">In progress</h2>
				<a href="/board" class="text-primary-readable text-sm">Open board</a>
			</header>
			<ul class="flex flex-col gap-2">
				{#each board.columns.find((c) => c.id === 'doing')?.cards ?? [] as t (t.id)}
					<li class="text-sm">
						<p class="text-neutral">{t.title}</p>
						{#if t.description}<p class="text-neutral-readable text-xs">{t.description}</p>{/if}
					</li>
				{:else}
					<li class="text-neutral-readable text-sm">Nothing in progress.</li>
				{/each}
			</ul>
		</section>
	</div>
</div>
