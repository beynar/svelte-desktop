<script>
	import { style, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { componentTheme } from './theming.svelte.js';
	import { recipe } from './recipe.js';

	const scrollAreaTheme = recipe({
		base: { overflowY: 'scroll', overflowX: 'hidden' },
		variants: {
			axis: { vertical: { overflowY: 'scroll', overflowX: 'hidden' }, horizontal: { overflowX: 'scroll', overflowY: 'hidden' }, both: { overflow: 'scroll' } },
		},
		defaultVariants: { axis: 'vertical' },
	});

	let { axis = 'vertical', maxH, maxW, class: klass = '', style: instStyle = null, theme = null, children, ...rest } = $props();
	const ct = componentTheme('scrollArea', () => theme);
	const vp = $derived(ct.props({ axis }));
	const resolved = $derived(
		mergeStyleDesc(
			style(ct.root(scrollAreaTheme, vp, { ...(maxH != null ? { maxH } : {}), ...(maxW != null ? { maxW } : {}), ...(instStyle ?? {}) })),
			resolveTokens(klass),
		),
	);
</script>

<div use:applyStyle={resolved} {...rest}>{@render children?.()}</div>
