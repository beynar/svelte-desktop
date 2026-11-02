<!-- A page that keeps running in its own tab (keepAlive in the layout): leave it, come back, the
     counter went on. -->
<script lang="ts">
	const started = Date.now();
	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});
	const seconds = $derived(Math.floor((now - started) / 1000));
</script>

<svelte:head><title>Activity</title></svelte:head>

<div class="flex h-full flex-col items-center justify-center gap-2 p-6">
	<p class="text-neutral-readable text-sm">Running for</p>
	<p class="text-neutral text-5xl font-semibold tabular-nums" data-activity-seconds>{seconds}s</p>
	<p class="text-neutral-readable text-sm">This tab keeps running in its own web view while you're elsewhere.</p>
</div>
