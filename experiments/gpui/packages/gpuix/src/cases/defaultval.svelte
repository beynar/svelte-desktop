<script>
	let el = $state();
	let d = $state('');
	const read = () => {
		d = el.defaultValue;
	};
</script>
<input bind:this={el} defaultValue="preset" />
<div use:read>d={d}</div>
