<script lang="ts">
	import { fade } from 'svelte/transition';
	let open = $state(true);
	// outro starts at +400ms; reverse mid-flight at +620ms (~55% through)
	setTimeout(() => (open = false), 400);
	setTimeout(() => (open = true), 620);
</script>

<div>
	{#if open}
		<div
			style="width: 80px; height: 80px; background: #0a84ff; opacity: 1;"
			transition:fade={{ duration: 400 }}
		>fader</div>
	{/if}
</div>
