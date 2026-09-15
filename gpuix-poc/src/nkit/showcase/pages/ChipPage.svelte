<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Chip from '../../Chip.svelte';
	import Badge from '../../Badge.svelte';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const controls = [
		{ key: 'variant', type: 'select', options: ['solid', 'outline', 'soft'], value: 'soft' },
		{ key: 'color', type: 'select', options: ['primary', 'secondary', 'neutral', 'danger', 'success', 'warning', 'info'], value: 'primary' },
		{ key: 'size', type: 'select', options: ['small', 'normal', 'large'], value: 'normal' },
	];
	const row = $derived(s({ row: true, gap: 'sm', items: 'center' }));
</script>

<ComponentPage title="Chip / Badge" description="Badge is the small+soft preset" {controls}>
	{#snippet demo(p)}
		<div use:applyStyle={row}>
			<Chip {...p}>chip</Chip>
			<Badge color={p.color} variant={p.variant}>badge</Badge>
		</div>
	{/snippet}
</ComponentPage>
