<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Input from '../../Input.svelte';
	import Field from '../../Field.svelte';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const controls = [
		{ key: 'size', type: 'select', options: ['small', 'normal', 'large'], value: 'normal' },
		{ key: 'disabled', type: 'toggle', value: false },
		{ key: 'invalid', type: 'toggle', value: false },
		{ key: 'readOnly', type: 'toggle', value: false },
	];
	let val = $state('');
	const col = $derived(s({ col: true, gap: 'md', w: 320 }));
	const echo = $derived(s({ text: 'xs', fg: 'neutral-readable' }));
</script>

<ComponentPage title="Input" description="native gpui text input — real editing, placeholder, change events" {controls}>
	{#snippet demo(p)}
		<div use:applyStyle={col}>
			<Input {...p} placeholder="Type something…" bind:value={val} />
			<div use:applyStyle={echo}>value: {val || '∅'}</div>
			<Field label="Email" hint="We never share it" error={p.invalid ? 'Invalid address' : null}>
				<Input {...p} invalid={false} placeholder="you@example.com" />
			</Field>
			<Field label="With error" error={p.invalid ? 'Required' : null}>
				<Input {...p} invalid placeholder="focus ring + danger border" />
			</Field>
		</div>
	{/snippet}
</ComponentPage>
