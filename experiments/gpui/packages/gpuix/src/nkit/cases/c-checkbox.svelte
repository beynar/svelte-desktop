<script>
	import Checkbox from '../Checkbox.svelte';
	let c = $state(false);
</script>
<Checkbox label="agree-cb" bind:checked={c} />
<div>cb={c}</div>
