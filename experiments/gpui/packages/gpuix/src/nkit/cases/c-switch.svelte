<script>
	import Switch from '../Switch.svelte';
	let c = $state(false);
</script>
<Switch label="sw-lbl" bind:on={c} />
<div>sw={c}</div>
