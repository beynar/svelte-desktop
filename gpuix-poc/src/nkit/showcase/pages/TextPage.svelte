<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Text from '../../Text.svelte';
	import Heading from '../../Heading.svelte';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const controls = [
		{ key: 'size', type: 'select', options: ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl'], value: 'base' },
		{ key: 'weight', type: 'select', options: ['normal', 'medium', 'semibold', 'bold'], value: 'normal' },
		{ key: 'color', type: 'select', options: ['neutral', 'neutral-readable', 'primary-readable', 'danger-readable', 'success-readable'], value: 'neutral' },
	];
	const col = $derived(s({ col: true, gap: 'sm' }));
</script>

<ComponentPage title="Text / Heading" description="size scale + weight + palette refs" {controls}>
	{#snippet demo(p)}
		<Text size={p.size} weight={p.weight} color={p.color}>The quick brown fox jumps over the lazy dog</Text>
		<div use:applyStyle={col}>
			<Heading level={1}>Heading 1</Heading>
			<Heading level={3}>Heading 3</Heading>
			<Heading level={5}>Heading 5</Heading>
		</div>
	{/snippet}
</ComponentPage>
