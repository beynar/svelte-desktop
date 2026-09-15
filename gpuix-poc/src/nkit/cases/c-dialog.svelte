<script>
	import Dialog from '../Dialog.svelte';
	let open = $state(false);
</script>
<button onclick={() => (open = true)}>dlg-open</button>
<Dialog bind:open title="dlg-t" description="dlg-d" />
<div>dlg={open}</div>
