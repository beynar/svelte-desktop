<script>
	import RadioGroup from '../RadioGroup.svelte';
	let v = $state('a');
</script>
<RadioGroup bind:value={v} options={[{ value: 'a', label: 'opt-a' }, { value: 'b', label: 'opt-b' }]} />
<div>rg={v}</div>
