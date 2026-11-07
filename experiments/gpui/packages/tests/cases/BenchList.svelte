<script lang="ts">
	let { rows = 500 }: { rows?: number } = $props();
	let on = $state(false);
	let tick = $state(0);
</script>

<div class="bench-root">
	<button class="bench-flip" onclick={() => (on = !on)}>flip</button>
	<button class="bench-tick" onclick={() => tick++}>tick {tick}</button>
	<div class="bench-list">
		{#each Array(rows) as _, i}
			<div class="bench-row" class:on>
				<span class="bench-cell">row {i}</span>
				<span class="bench-cell dim">item {i}</span>
				<span class="bench-cell">{tick}</span>
			</div>
		{/each}
	</div>
</div>

<style>
	.bench-root { display: flex; flex-direction: column; width: 400px; }
	.bench-flip, .bench-tick { padding: 6px 12px; }
	.bench-list { display: flex; flex-direction: column; }
	.bench-row { display: flex; flex-direction: row; gap: 8px; padding: 4px 8px; color: #fafafa; }
	.bench-row.on { background-color: #27272a; }
	.bench-cell { font-size: 13px; }
	.bench-cell.dim { color: #a1a1aa; }
</style>
