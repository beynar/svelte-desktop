<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { buttonTheme, buttonFocusRing } from './recipes/button.js';
	import Spinner from './Spinner.svelte';

	let {
		variant ,
		color,                 // omitted → theme defaultColor
		size ,
		disabled = false,
		loading = false,
		squared = false,
		fullWidth = false,
		label,
		onclick,
		onfocus,
		onblur,
		children,
		prefix,
		suffix,
		class: klass = '',
		style = null,
		theme = null,          // instance theme: {root/prefix/suffix: StyleProps, motion, override}
		...rest
	} = $props();

	const ct = useComponentTheme('button', theme, ['prefix', 'suffix']);
	const vp = $derived(ct.props({ variant, color, size, disabled, loading, squared, fullWidth }));
	let focused = $state(false);
	const ctx = $derived({ color: vp.color });
	const resolved = $derived(
		mergeStyleDesc(
			mergeStyleDesc(
				s(ct.root(buttonTheme.root, vp, style), ctx),
				resolveTokens(klass, ctx),
			),
			focused ? s(buttonFocusRing, ctx) : null,
		),
	);
	const affixStyle = $derived(s(ct.slot('prefix', buttonTheme.prefix, vp), ctx));
</script>

<button
	use:applyStyle={resolved}
	use:nativeProps={{ tabIndex: disabled ? undefined : 0 }}
	onclick={(e) => { if (!disabled && !loading) onclick?.(e); }}
	onfocus={(e) => { focused = true; onfocus?.(e); }}
	onblur={(e) => { focused = false; onblur?.(e); }}
	aria-disabled={disabled || loading || undefined}
	{...rest}
>
	{#if loading}<Spinner size="small" {color} />{:else if prefix}<span use:applyStyle={affixStyle}>{@render prefix()}</span>{/if}
	{#if children}{@render children()}{:else}{label}{/if}
	{#if suffix}<span use:applyStyle={affixStyle}>{@render suffix()}</span>{/if}
</button>
