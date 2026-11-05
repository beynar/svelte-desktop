<script>
	import Theme from '../Theme.svelte';
	import Spinner from '../Spinner.svelte';
	import Progress from '../Progress.svelte';
	import Skeleton from '../Skeleton.svelte';
	import { fade } from '../transitions.js';

	let value = $state(30);
	let showBox = $state(true);
</script>

<Theme defaultTheme="dark">
	{#snippet children(th)}
		<div>mv-rm={th.preferReducesMotion}</div>
		<Spinner variant="grid" label="sp-grid" />
		<Skeleton h={12} w={200} />
		<div style="width:200px">
			<Progress {value} showLabel />
		</div>
		<div onclick={() => (value = 80)}>bump-val</div>
		<div onclick={() => (showBox = false)}>hide-box</div>
		{#if showBox}
			<div transition:fade>anim-box</div>
		{/if}
	{/snippet}
</Theme>
