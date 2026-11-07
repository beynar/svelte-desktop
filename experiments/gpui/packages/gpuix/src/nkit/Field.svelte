<script>
	import { style, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { componentTheme } from './theming.svelte.js';
	import { fieldTheme } from './recipes/form.js';

	let {
		label,
		hint,
		error,
		required = false,
		disabled = false,
		class: klass = '',
		style: instStyle = null,
		theme = null,
		children,
		...rest
	} = $props();
	const ct = componentTheme('field', () => theme, ['label', 'hint', 'error']);
	const vp = $derived(ct.props({ disabled }));
	const rootS = $derived(mergeStyleDesc(style(ct.root(fieldTheme.root, { ...vp, style: { ...(disabled ? { opacity: 0.6 } : {}) } }, instStyle)), resolveTokens(klass)));
	const labelS = $derived(style(ct.slot('label', fieldTheme.label, vp)));
	const reqS = $derived(style({ fg: 'danger-readable', fontW: 600 }));
	const hintS = $derived(style(ct.slot('hint', fieldTheme.hint, vp)));
	const errorS = $derived(style(ct.slot('error', fieldTheme.error, vp)));
</script>

<div use:applyStyle={rootS} aria-disabled={disabled || undefined} {...rest}>
	{#if label}
		<div use:applyStyle={labelS}>{label}{#if required}<span use:applyStyle={reqS}> *</span>{/if}</div>
	{/if}
	{@render children?.()}
	{#if error}<div use:applyStyle={errorS}>{error}</div>{:else if hint}<div use:applyStyle={hintS}>{hint}</div>{/if}
</div>
