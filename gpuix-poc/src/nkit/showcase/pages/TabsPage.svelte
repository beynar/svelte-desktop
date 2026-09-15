<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Tabs from '../../Tabs.svelte';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const controls = [
		{ key: 'variant', type: 'select', options: ['line', 'pills'], value: 'line' },
		{ key: 'color', type: 'select', options: ['primary', 'success', 'danger'], value: 'primary' },
	];
	let tab = $state('a');
	const panel = $derived(s({ text: 'sm', fg: 'neutral-readable' }));
</script>

<ComponentPage title="Tabs" description="line + pills variants" {controls}>
	{#snippet demo(p)}
		<Tabs
			bind:value={tab}
			variant={p.variant}
			color={p.color}
			tabs={[{ value: 'a', label: 'Account' }, { value: 'b', label: 'Security' }, { value: 'c', label: 'Disabled', disabled: true }]}
			style={{ w: 420 }}
		>
			{#snippet children(v)}
				<div use:applyStyle={panel}>Panel for <b>{v}</b> — content swaps with the active tab.</div>
			{/snippet}
		</Tabs>
	{/snippet}
</ComponentPage>
