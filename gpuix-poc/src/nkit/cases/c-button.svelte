<script>
	import Button from '../Button.svelte';
	let n = $state(0);
</script>
<Button label="save-btn" onclick={() => n++} />
<Button label="ghost-btn" variant="ghost" />
<Button label="load-btn" loading />
<div>btn-n={n}</div>
