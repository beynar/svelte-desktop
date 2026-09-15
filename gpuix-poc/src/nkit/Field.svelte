<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { fieldTheme } from './recipes/form.js';

	let {
		label,
		hint,
		error,
		required = false,
		disabled = false,
		class: klass = '',
		style = null,
		theme = null,
		children,
		...rest
	} = $props();
	const ct = useComponentTheme('field', theme, ['label', 'hint', 'error']);
	const vp = $derived(ct.props({ disabled }));
	const rootS = $derived(mergeStyleDesc(s(ct.root(fieldTheme.root, { ...vp, style: { ...(disabled ? { opacity: 0.6 } : {}) } }, style)), resolveTokens(klass)));
	const labelS = $derived(s(ct.slot('label', fieldTheme.label, vp)));
	const reqS = $derived(s({ fg: 'danger-readable', fontW: 600 }));
	const hintS = $derived(s(ct.slot('hint', fieldTheme.hint, vp)));
	const errorS = $derived(s(ct.slot('error', fieldTheme.error, vp)));
</script>

<div use:applyStyle={rootS} aria-disabled={disabled || undefined} {...rest}>
	{#if label}
		<div use:applyStyle={labelS}>{label}{#if required}<span use:applyStyle={reqS}> *</span>{/if}</div>
	{/if}
	{@render children?.()}
	{#if error}<div use:applyStyle={errorS}>{error}</div>{:else if hint}<div use:applyStyle={hintS}>{hint}</div>{/if}
</div>
