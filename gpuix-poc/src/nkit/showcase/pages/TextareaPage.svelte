<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Textarea from '../../Textarea.svelte';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const controls = [
		{ key: 'disabled', type: 'toggle', value: false },
		{ key: 'invalid', type: 'toggle', value: false },
	];
	const col = $derived(s({ col: true, gap: 'md', w: 360 }));
</script>

<ComponentPage title="Textarea" description="native multiline editor — minRows/maxRows" {controls}>
	{#snippet demo(p)}
		<div use:applyStyle={col}>
			<Textarea {...p} placeholder="Write a paragraph…" minRows={3} maxRows={8} />
		</div>
	{/snippet}
</ComponentPage>
