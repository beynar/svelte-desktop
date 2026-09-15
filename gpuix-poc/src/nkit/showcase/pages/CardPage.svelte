<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Card from '../../Card.svelte';
	import Button from '../../Button.svelte';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const controls = [
		{ key: 'variant', type: 'select', options: ['solid', 'outline', 'soft', 'ghost'], value: 'solid' },
		{ key: 'color', type: 'select', options: ['primary', 'secondary', 'neutral', 'danger', 'success', 'warning', 'info'], value: 'neutral' },
		{ key: 'density', type: 'select', options: ['compact', 'normal', 'comfortable'], value: 'normal' },
		{ key: 'size', type: 'select', options: ['small', 'normal', 'large'], value: 'normal' },
		{ key: 'clickable', type: 'toggle', value: false },
	];
</script>

<ComponentPage title="Card" description="slots: header/title/description/content/footer — clickable adds state-layer" {controls}>
	{#snippet demo(p)}
		<Card
			{...p}
			onclick={p.clickable ? () => {} : undefined}
			title="Card title"
			description="A short description of what this card contains"
			style={{ w: 320 }}
		>
			<div use:applyStyle={s({ text: 'sm' })}>Card body content goes here.</div>
			{#snippet footer()}<Button variant="soft" size="small" label="Action" />{/snippet}
		</Card>
	{/snippet}
</ComponentPage>
