<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Alert from '../../Alert.svelte';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const controls = [
		{ key: 'color', type: 'select', options: ['primary', 'secondary', 'neutral', 'danger', 'success', 'warning', 'info'], value: 'info' },
		{ key: 'variant', type: 'select', options: ['soft', 'solid', 'outline'], value: 'soft' },
		{ key: 'size', type: 'select', options: ['small', 'normal', 'large'], value: 'normal' },
		{ key: 'dismissible', type: 'toggle', value: false },
	];
	const col = $derived(s({ col: true, gap: 'md' }));
</script>

<ComponentPage title="Alert" description="icon + title + body, auto icon per color" {controls}>
	{#snippet demo(p)}
		<div use:applyStyle={col}>
			<Alert {...p} title="Heads up" description="With a description prop." style={{ w: 420 }}>Something happened that you should know about.</Alert>
			<Alert color="success" variant={p.variant} title="Saved" style={{ w: 420 }}>Your changes were persisted.</Alert>
			<Alert color="danger" variant={p.variant} title="Failed" dismissible={p.dismissible} style={{ w: 420 }}>The operation could not complete.</Alert>
		</div>
	{/snippet}
</ComponentPage>
