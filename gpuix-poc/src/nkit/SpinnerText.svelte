<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import Spinner from './Spinner.svelte';

	// Spinner with an adjacent label — "Loading…" inline pattern.
	let {
		text = 'Loading…',
		size ,
		color,
		class: klass = '',
		style = null,
		theme = null,
		children,
		...rest
	} = $props();

	const ct = useComponentTheme('spinnerText', theme, ['text']);
	const vp = $derived(ct.props({ color }));
	const ctx = $derived({ color: vp.color });
	const rootS = $derived(mergeStyleDesc(s(ct.root({ row: true, items: 'center', gap: 'sm' }, vp, style)), resolveTokens(klass, ctx)));
	const textS = $derived(s(ct.slot('text', { text: 'sm', fg: 'neutral-readable' }, vp)));
</script>

<div use:applyStyle={rootS} role="status" {...rest}>
	<Spinner {size} {color} />
	<span use:applyStyle={textS}>{#if children}{@render children()}{:else}{text}{/if}</span>
</div>
