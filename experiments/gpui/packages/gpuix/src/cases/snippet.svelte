<script>
	let x = $state(1);
</script>
{#snippet row(v)}<span>row:{v}</span>{/snippet}
<div>{@render row(x)}</div>
