<script>
	import SegmentedControl from '../SegmentedControl.svelte';
	import ToggleButton from '../ToggleButton.svelte';
	let v = $state('left');
	let p = $state(false);
</script>
<SegmentedControl bind:value={v} options={[{ value: 'left', label: 'seg-left' }, { value: 'right', label: 'seg-right' }]} />
<ToggleButton label="tg-bold" bind:pressed={p} />
<div>seg={v} tg={p}</div>
