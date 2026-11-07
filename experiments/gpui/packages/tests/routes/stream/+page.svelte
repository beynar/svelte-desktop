<script>
	let { data } = $props();
</script>

<div style="color: #e5e7eb">
	stream — price:{data.price?.cents} ·
	{#await data.slow}
		pending
	{:then v}
		{v}
	{/await}
</div>
