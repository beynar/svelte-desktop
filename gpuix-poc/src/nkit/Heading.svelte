<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { recipe } from './recipe.js';

	const headingTheme = recipe({
		base: { fg: 'neutral' },
		variants: {
			level: {
				1: { text: '3xl', fontW: 700 },
				2: { text: '2xl', fontW: 600 },
				3: { text: 'xl', fontW: 600 },
				4: { text: 'lg', fontW: 600 },
				5: { text: 'base', fontW: 600 },
				6: { text: 'sm', fontW: 600 },
			},
			muted: { true: { fg: 'neutral-readable' }, false: null },
		},
		defaultVariants: { level: 2, muted: false },
	});

	let {
		level,                 // 1..6 — `size`/'as' accept 'h1'..'h6' too
		size,                  // 'h1'..'h6' (svelai name)
		as,                    // 'h1'..'h6' (svelai name)
		weight,                // 'light' | 'normal' | 'bold' | number
		align,                 // 'left' | 'center' | 'right'
		muted = false,
		color ,
		class: klass = '',
		style = null,
		theme = null,
		children,
		...rest
	} = $props();

	const ct = useComponentTheme('heading', theme);
	const vp = $derived(ct.props({}));
	const lvl = $derived(level ?? (parseInt(String(size ?? as ?? 'h2').replace(/^h/, ''), 10) || 2));
	const weightMap = { light: 300, normal: 400, bold: 700 };
	const wExtra = $derived(weight != null ? { fontW: weightMap[weight] ?? weight } : null);
	const alignExtra = $derived(align ? { align } : null);
	const resolved = $derived(
		mergeStyleDesc(
			s(ct.root(headingTheme, { level: lvl, muted }, { ...(wExtra ?? {}), ...(alignExtra ?? {}), ...(style ?? {}) }), { color }),
			resolveTokens(klass, { color }),
		),
	);
</script>

<div use:applyStyle={resolved} role="heading" aria-level={lvl} {...rest}>{@render children?.()}</div>
