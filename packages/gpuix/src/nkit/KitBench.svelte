<script>
	import Button from './Button.svelte';

	let { rows = 500 } = $props();
	let on = $state(false);
	let tick = $state(0);
</script>

<div>
	<button onclick={() => (on = !on)}>kitflip</button>
	<button onclick={() => tick++}>kittick</button>
	{#each Array(rows) as _, i}
		<Button label="row {i} {tick}" color="primary" variant={on ? 'outline' : 'soft'} />
	{/each}
</div>
