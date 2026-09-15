<script>
	let el = $state();
	let c = $state(false);
	const act = (node) => node.click();
</script>
<input type="checkbox" bind:this={el} bind:checked={c} use:act />
<div>c={c}</div>
