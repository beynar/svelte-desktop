<script>
	import { style, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { componentTheme } from './theming.svelte.js';
	import Spinner from './Spinner.svelte';

	// Spinner with an adjacent label — "Loading…" inline pattern.
	let {
		text = 'Loading…',
		size ,
		color,
		class: klass = '',
		style: instStyle = null,
		theme = null,
		children,
		...rest
	} = $props();

	const ct = componentTheme('spinnerText', () => theme, ['text']);
	const vp = $derived(ct.props({ color }));
	const ctx = $derived({ color: vp.color });
	const rootS = $derived(mergeStyleDesc(style(ct.root({ row: true, items: 'center', gap: 'sm' }, vp, instStyle)), resolveTokens(klass, ctx)));
	const textS = $derived(style(ct.slot('text', { text: 'sm', fg: 'neutral-readable' }, vp)));
</script>

<div use:applyStyle={rootS} role="status" {...rest}>
	<Spinner {size} {color} />
	<span use:applyStyle={textS}>{#if children}{@render children()}{:else}{text}{/if}</span>
</div>
