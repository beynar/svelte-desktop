<script lang="ts">
	// Counts while the page runs: a tab moved to another pane goes on counting, it isn't reloaded.
	let seconds = $state(0);
	$effect(() => {
		const timer = setInterval(() => seconds++, 1000);
		return () => clearInterval(timer);
	});
</script>

<p>Running for <strong data-alive>{seconds}</strong> s in process <code>{(globalThis as { __desktopView?: string }).__desktopView ?? 'window'}</code>.</p>
<input placeholder="Type here, then drag the tab" aria-label="Draft" style="width: 100%; max-width: 320px" />
