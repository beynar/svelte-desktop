<script>
	import { fade } from 'svelte/transition';
	let on = $state(true);
</script>
<div>
	{#if on}<span transition:fade={{ duration: 60 }}>fading</span>{/if}
	<button onclick={() => (on = !on)}>toggle</button>
</div>
