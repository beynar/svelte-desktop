<script>
	function Boom() { throw new Error('kaboom'); }
</script>
<svelte:boundary>
	<Boom />
	{#snippet failed(e)}<span>caught</span>{/snippet}
</svelte:boundary>
