<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { chipTheme } from './recipes/chip.js';
	import { icons } from './icons.js';

	let {
		variant ,      // solid | soft | outline
		color,
		size ,
		label,                  // text shorthand
		position,               // 'top-left'|'top-right'|'bottom-left'|'bottom-right' — absolute corner badge
		removable = false,
		onRemove,
		onclick,
		children,
		class: klass = '',
		style = null,
		theme = null,
		...rest
	} = $props();

	const ct = useComponentTheme('chip', theme, ['close']);
	const vp = $derived(ct.props({ variant, color, size, isLink: !!onclick }));
	const ctx = $derived({ color: vp.color });
	const posStyle = $derived(
		position
			? {
					position: 'absolute',
					...(position.includes('top') ? { top: -4 } : { bottom: -4 }),
					...(position.includes('left') ? { left: -4 } : { right: -4 }),
				}
			: null,
	);
	const resolved = $derived(
		mergeStyleDesc(
			s(ct.root(chipTheme.root, vp, { ...(posStyle ?? {}), ...(style ?? {}) }), ctx),
			resolveTokens(klass, ctx),
		),
	);
	const closeS = $derived(s(ct.slot('close', { icon: 'sm', cursor: 'pointer', opacity: 0.7, hover: { opacity: 1 } }, vp), ctx));
</script>

<span use:applyStyle={resolved} {onclick} {...rest}>
	{#if children}{@render children()}{:else}{label}{/if}
	{#if removable}
		<svg use:nativeProps={{ source: icons.x, tabIndex: 0 }} use:applyStyle={closeS} onclick={(e) => { e.stopPropagation?.(); onRemove?.(); }} role="button" aria-label="Remove" />
	{/if}
</span>
