<script>
	import Select from '../Select.svelte';
	let v = $state(null);
</script>
<Select bind:value={v} placeholder="pick-one" options={[{ value: 'one', label: 'sel-one' }, { value: 'two', label: 'sel-two' }]} />
<div>sel={v}</div>
