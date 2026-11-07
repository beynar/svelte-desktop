<script>
	import { style, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { componentTheme } from './theming.svelte.js';
	import { buttonTheme } from './recipes/button.js';
	import Spinner from './Spinner.svelte';

	let {
		variant ,
		color,                 // omitted → theme defaultColor
		size ,
		disabled = false,
		loading = false,
		squared,               // omitted → auto: icon-only buttons square
		fullWidth = false,
		href,
		as,
		rel,
		target,
		download,
		role,
		type,
		tabindex,
		label,
		haspopup,
		expanded,
		controls,
		selected,
		pressed,
		onclick,
		onfocus,
		onblur,
		onpointerenter,
		onpointerleave,
		children,
		prefix,
		suffix,
		class: klass = '',
		style: instStyle = null,
		theme = null,          // instance theme: {root/prefix/suffix: StyleProps, motion, override}
		...rest
	} = $props();

	const ct = componentTheme('button', () => theme, ['prefix', 'suffix']);
	// svelai: an `as`/`href` button is an anchor — role link, aria-disabled
	// instead of the disabled attr, href removed + tabindex=-1 while disabled.
	const isAnchor = $derived(!!(as || href));
	const isSquared = $derived(
		squared ?? !!((!children && prefix && !suffix) || (!children && !prefix && suffix)),
	);
	const vp = $derived(ct.props({ variant, color, size, disabled, loading, squared: isSquared, fullWidth }));
	const ctx = $derived({ color: vp.color });
	const resolved = $derived(
		mergeStyleDesc(style(ct.root(buttonTheme, vp, instStyle), ctx), resolveTokens(klass, ctx)),
	);
	const affixStyle = $derived(style(ct.slot('prefix', buttonTheme, vp), ctx));
	// svelai's spinnerOverlay: children stay mounted under a surface/85 wash.
	const overlayS = $derived(
		style(
			{
				position: 'absolute', inset: 0, flex: true,
				items: 'center', justify: 'center', bg: 'surface/85',
			},
			ctx,
		),
	);

	const handleClick = (e) => {
		if (disabled) {
			e.preventDefault?.();
			e.stopPropagation?.();
			return;
		}
		onclick?.(e);
	};
</script>

<svelte:element
	this={isAnchor ? 'a' : 'button'}
	use:applyStyle={resolved}
	use:nativeProps={{ tabIndex: tabindex ?? (isAnchor && disabled ? -1 : disabled ? undefined : 0) }}
	role={role ?? (isAnchor ? 'link' : 'button')}
	aria-label={label}
	aria-haspopup={haspopup}
	aria-expanded={expanded}
	aria-controls={controls}
	aria-selected={selected}
	aria-pressed={pressed}
	aria-disabled={(isAnchor && disabled) || undefined}
	href={isAnchor && !disabled ? href : undefined}
	{rel}
	{target}
	{download}
	{type}
	disabled={!isAnchor && disabled ? true : undefined}
	onclick={handleClick}
	onfocus={(e) => onfocus?.(e)}
	onblur={(e) => onblur?.(e)}
	onpointerenter={(e) => { if (!disabled) onpointerenter?.(e); }}
	onpointerleave={(e) => { if (!disabled) onpointerleave?.(e); }}
	{...rest}
>
	{#if prefix}<span use:applyStyle={affixStyle}>{@render prefix()}</span>{/if}
	{#if children}{@render children()}{:else}{label}{/if}
	{#if suffix}<span use:applyStyle={affixStyle}>{@render suffix()}</span>{/if}
	{#if loading}
		<span use:applyStyle={overlayS}><Spinner size={vp.size} color={vp.color} decorative /></span>
	{/if}
</svelte:element>
