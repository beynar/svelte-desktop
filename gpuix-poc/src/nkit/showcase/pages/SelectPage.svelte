<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Select from '../../Select.svelte';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const controls = [{ key: 'disabled', type: 'toggle', value: false }];
	let v = $state(null);
	const col = $derived(s({ col: true, gap: 'md', w: 280 }));
	const echo = $derived(s({ text: 'xs', fg: 'neutral-readable' }));
	const opts = [
		{ value: 'svelte', label: 'Svelte' },
		{ value: 'react', label: 'React' },
		{ value: 'vue', label: 'Vue' },
		{ value: 'solid', label: 'Solid (disabled)', disabled: true },
	];
</script>

<ComponentPage title="Select" description="anchored floating content — outside-click dismisses" {controls}>
	{#snippet demo(p)}
		<div use:applyStyle={col}>
			<Select bind:value={v} options={opts} disabled={p.disabled} placeholder="Pick a framework" />
			<div use:applyStyle={echo}>selected: {v ?? '∅'}</div>
		</div>
	{/snippet}
</ComponentPage>
