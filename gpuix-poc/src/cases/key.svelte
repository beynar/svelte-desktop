<script>
	let k = $state(0);
</script>
<div>
	{#key k}<span>key-{k}</span>{/key}
	<button onclick={() => k++}>k++</button>
</div>
