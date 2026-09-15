<script>
	import Tree from '../Tree.svelte';
	let sel = $state(null);
</script>
<Tree bind:selected={sel} nodes={[{ id: 'root', label: 'tr-root', children: [{ id: 'kid', label: 'tr-kid' }] }]} />
<div>ts={sel}</div>
