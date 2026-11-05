<script>
	import Tabs from '../Tabs.svelte';
	let v = $state('a');
</script>
<Tabs bind:value={v} tabs={[{ value: 'a', label: 'tab-a' }, { value: 'b', label: 'tab-b' }]}>
	{#snippet children(value)}{value === 'a' ? 'panel-a' : 'panel-b'}{/snippet}
</Tabs>
<div>tv={v}</div>
