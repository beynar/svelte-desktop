<script>
	import ScrollArea from '../ScrollArea.svelte';
	let sc = $state(0);
</script>
<ScrollArea maxH={80} style={{ w: 200 }} onscroll={(e) => (sc = Math.round(e.target.scrollTop))}>
	<div>
		{#each Array(30) as _, i}<div>sc-row-{i}</div>{/each}
	</div>
</ScrollArea>
<div>sc={sc}</div>
