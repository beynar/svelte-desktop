<script>
	import Textarea from '../Textarea.svelte';
	let v = $state('');
</script>
<Textarea placeholder="ph-ta" bind:value={v} />
<div>tv={v}</div>
