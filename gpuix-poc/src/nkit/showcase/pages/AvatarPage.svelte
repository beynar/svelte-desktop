<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Avatar from '../../Avatar.svelte';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const controls = [
		{ key: 'size', type: 'select', options: ['small', 'normal', 'large'], value: 'normal' },
		{ key: 'color', type: 'select', options: ['primary', 'secondary', 'neutral', 'danger', 'success', 'warning', 'info'], value: 'primary' },
	];
	const row = $derived(s({ row: true, gap: 'md', items: 'center' }));
</script>

<ComponentPage title="Avatar" description="img with initials fallback" {controls}>
	{#snippet demo(p)}
		<div use:applyStyle={row}>
			<Avatar {...p} fallback="Ada Lovelace" />
			<Avatar {...p} fallback="Grace Hopper" />
			<Avatar {...p} fallback="Linus Torvalds" />
		</div>
	{/snippet}
</ComponentPage>
