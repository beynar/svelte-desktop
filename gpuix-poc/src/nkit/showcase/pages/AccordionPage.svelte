<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Accordion from '../../Accordion.svelte';
	import Collapsible from '../../Collapsible.svelte';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const controls = [
		{ key: 'single', type: 'toggle', value: false },
		{ key: 'variant', type: 'select', options: ['classic', 'card', 'outline'], value: 'classic' },
		{ key: 'splitted', type: 'toggle', value: false },
		{ key: 'size', type: 'select', options: ['small', 'normal', 'large'], value: 'normal' },
		{ key: 'icon', type: 'select', options: ['chevron', 'plus'], value: 'chevron' },
	];
	const w = $derived(s({ w: 420 }));
</script>

<ComponentPage title="Accordion / Collapsible" description="multi or single-open disclosure" {controls}>
	{#snippet demo(p)}
		<Accordion
			single={p.single}
			variant={p.variant}
			splitted={p.splitted}
			size={p.size}
			icon={p.icon}
			style={{ w: 420 }}
			items={[
				{ value: 'a', title: 'What is this?', content: 'A native-rendered accordion — no DOM, no CSS engine.' },
				{ value: 'b', title: 'Multiple open?', content: 'Toggle the control to switch between multi and single mode.' },
				{ value: 'c', title: 'Disabled item', disabled: true, content: '…' },
			]}
		/>
		<Collapsible title="Collapsible (single disclosure)" style={{ w: 420 }}>
			<div use:applyStyle={s({ p: 'md', text: 'sm', fg: 'neutral-readable' })}>Any content goes here — collapses on header click or Enter/Space.</div>
		</Collapsible>
	{/snippet}
</ComponentPage>
