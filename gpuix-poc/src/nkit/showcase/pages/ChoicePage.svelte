<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Checkbox from '../../Checkbox.svelte';
	import Switch from '../../Switch.svelte';
	import RadioGroup from '../../RadioGroup.svelte';
	import SegmentedControl from '../../SegmentedControl.svelte';
	import ToggleButton from '../../ToggleButton.svelte';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const controls = [
		{ key: 'color', type: 'select', options: ['primary', 'secondary', 'neutral', 'danger', 'success'], value: 'primary' },
		{ key: 'disabled', type: 'toggle', value: false },
	];
	let radio = $state('b');
	let seg = $state('list');
	const col = $derived(s({ col: true, gap: 'md' }));
	const cap = $derived(s({ text: 'xs', fg: 'neutral-readable', w: 96 }));
	const row = $derived(s({ row: true, gap: 'md', items: 'center' }));
</script>

<ComponentPage title="Checkbox / Switch / Radio / Segmented" description="binary + single-choice controls" {controls}>
	{#snippet demo(p)}
		<div use:applyStyle={row}><span use:applyStyle={cap}>checkbox</span><Checkbox color={p.color} disabled={p.disabled} label="Accept terms" checked /></div>
		<div use:applyStyle={row}><span use:applyStyle={cap}>switch</span><Switch color={p.color} disabled={p.disabled} label="Notifications" on /></div>
		<div use:applyStyle={row}><span use:applyStyle={cap}>toggle</span><ToggleButton color={p.color} size="small" disabled={p.disabled} label="Bold" pressed /></div>
		<div use:applyStyle={row}><span use:applyStyle={cap}>segmented</span>
			<SegmentedControl bind:value={seg} options={[{ value: 'list', label: 'List' }, { value: 'grid', label: 'Grid' }, { value: 'board', label: 'Board', disabled: p.disabled }]} />
		</div>
		<div use:applyStyle={row}><span use:applyStyle={cap}>radio</span>
			<RadioGroup bind:value={radio} color={p.color} disabled={p.disabled} options={[{ value: 'a', label: 'Option A' }, { value: 'b', label: 'Option B' }, { value: 'c', label: 'Disabled', disabled: true }]} />
		</div>
	{/snippet}
</ComponentPage>
