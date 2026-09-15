<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { avatarTheme } from './recipes/display.js';

	let {
		src,
		alt = '',
		name,                  // svelai: initials source — same role as `fallback`
		fallback,
		size ,
		color,
		class: klass = '',
		style = null,
		theme = null,
		...rest
	} = $props();

	const ct = useComponentTheme('avatar', theme);
	const vp = $derived(ct.props({ size, color }));
	const ctx = $derived({ color: vp.color });
	const resolved = $derived(
		mergeStyleDesc(s(ct.root(avatarTheme.root, vp, style), ctx), resolveTokens(klass, ctx)),
	);
	// "AB" from alt/fallback
	const initials = $derived(
		(fallback ?? name ?? alt ?? '')
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((w) => w[0].toUpperCase())
			.join(''),
	);
</script>

<div use:applyStyle={resolved} {...rest}>
	{#if src}<img {src} {alt} style="width:100%;height:100%" />{:else}{initials || '?'}{/if}
</div>
