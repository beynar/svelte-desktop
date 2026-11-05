<script>
	import VirtualList from '../VirtualList.svelte';
	const items = Array.from({ length: 500 }, (_, i) => `vl-row-${i}`);
</script>
<div style="height:120px;display:flex;flex-direction:column">
	<VirtualList {items} estimatedItemHeight={24} style={{ h: 120, w: 200 }}>
		{#snippet row(item)}<div style="height:24px">{item}</div>{/snippet}
	</VirtualList>
</div>
