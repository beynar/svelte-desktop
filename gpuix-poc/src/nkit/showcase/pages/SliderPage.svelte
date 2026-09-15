<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Slider from '../../Slider.svelte';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const controls = [
		{ key: 'color', type: 'select', options: ['primary', 'success', 'warning', 'danger'], value: 'primary' },
		{ key: 'disabled', type: 'toggle', value: false },
	];
	let v = $state(35);
	const col = $derived(s({ col: true, gap: 'md', w: 320 }));
	const echo = $derived(s({ text: 'xs', fg: 'neutral-readable' }));
</script>

<ComponentPage title="Slider" description="drag the thumb — window overlay captures the drag" {controls}>
	{#snippet demo(p)}
		<div use:applyStyle={col}>
			<Slider bind:value={v} color={p.color} disabled={p.disabled} />
			<div use:applyStyle={echo}>value: {v}</div>
			<Slider value={6} min={0} max={10} step={1} color="success" />
		</div>
	{/snippet}
</ComponentPage>
