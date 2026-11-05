<script lang="ts">
	import { fade, fly, slide, scale } from 'svelte/transition';
	let open = $state(true);
	let open2 = $state(true);
	let open3 = $state(true);
	let open4 = $state(true);
</script>

<div>
	{#if open}
		<div
			style="width: 80px; height: 80px; background: #0a84ff; opacity: 1;"
			transition:fade={{ duration: 400 }}
		>fader</div>
	{/if}
	<button onclick={() => (open = !open)}>toggle</button>
	{#if open2}
		<div
			style="width: 80px; height: 80px; background: #30d158;"
			transition:fly={{ y: -60, duration: 400 }}
		>flyer</div>
	{/if}
	<button onclick={() => (open2 = !open2)}>flytoggle</button>
	{#if open3}
		<div
			style="width: 80px; background: #bf5af2; padding: 12px;"
			transition:slide={{ duration: 400 }}
		>slider</div>
	{/if}
	<button onclick={() => (open3 = !open3)}>slidetoggle</button>
	{#if open4}
		<div
			style="width: 80px; height: 40px; background: #ff9f0a;"
			transition:scale={{ start: 0, duration: 400 }}
		>scaler</div>
	{/if}
	<button onclick={() => (open4 = !open4)}>scaletoggle</button>
</div>
