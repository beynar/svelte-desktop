<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Button from '../../Button.svelte';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const controls = [
		{ key: 'variant', type: 'select', options: ['solid', 'outline', 'soft', 'ghost', 'link'], value: 'solid' },
		{ key: 'color', type: 'select', options: ['primary', 'secondary', 'neutral', 'danger', 'success', 'warning', 'info'], value: 'primary' },
		{ key: 'size', type: 'select', options: ['small', 'normal', 'large'], value: 'normal' },
		{ key: 'disabled', type: 'toggle', value: false },
		{ key: 'loading', type: 'toggle', value: false },
		{ key: 'fullWidth', type: 'toggle', value: false },
	];
	const row = $derived(s({ row: true, gap: 'sm', items: 'center' }));
	const cap = $derived(s({ text: 'xs', fg: 'neutral-readable', w: 56 }));
</script>

<ComponentPage title="Button" description="variant × color × size — state-layer hover/active are native StyleDesc channels" {controls}>
	{#snippet demo(p)}
		<Button {...p} label="Get started" onclick={() => {}} />
		<div use:applyStyle={row}><span use:applyStyle={cap}>squared</span><Button {...p} squared label="+" /><Button {...p} squared label="×" /></div>
	{/snippet}
</ComponentPage>
