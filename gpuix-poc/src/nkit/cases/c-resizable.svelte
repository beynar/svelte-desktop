<script>
	import Resizable from '../Resizable.svelte';
	let sz = $state(null);
</script>
<div style="width:400px;height:100px">
	<Resizable panes={2} bind:sizes={sz}>
		{#snippet pane(i)}<div>pane-{i}</div>{/snippet}
	</Resizable>
</div>
<div>rz={sz ? sz[0].toFixed(0) : '?'}</div>
