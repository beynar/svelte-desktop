<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { spinnerTheme } from './recipes/display.js';
	import { icons } from './icons.js';
	import { useComponentTheme } from './theming.svelte.js';

	let {
		size ,
		color,                     // omitted → theme defaultColor
		variant,                   // 'default'|'grid'|'pulse'|'puff'|'lines'|'circles' — omitted → Theme spinnerVariant
		label = 'Loading',
		decorative = false,
		class: klass = '',
		style = null,
		theme = null,
		...rest
	} = $props();

	const ct = useComponentTheme('spinner', theme, ['indicator', 'label']);
	const th = ct.state;
	const vp = $derived(ct.props({ size, color, variant }));
	const ctx = $derived({ color: vp.color });
	const effVariant = $derived(vp.variant ?? th.spinnerVariant ?? 'default');

	// staggered opacity loops — gpuix has no rotation transform; opacity is the
	// native-animatable channel (and honors reduceMotion by simply not running)
	const cells = $derived(
		effVariant === 'grid' ? Array.from({ length: 9 }, (_, i) => i)
		: effVariant === 'circles' || effVariant === 'lines' ? Array.from({ length: 3 }, (_, i) => i)
		: [],
	);
	// per-cell action: infinite alternate opacity pulse, staggered by index
	const spin = (el, i = 0) => {
		if (th.preferReducesMotion) return;
		const a = el.animate?.(
			[{ opacity: 0.25 }, { opacity: 1 }],
			{ duration: 700, iterations: Infinity, direction: 'alternate', delay: i * 120 },
		);
		return { destroy: () => a?.cancel?.() };
	};

	const px = $derived({ small: 16, normal: 20, large: 28 }[vp.size] ?? 20);
	const resolved = $derived(
		mergeStyleDesc(s(ct.root(spinnerTheme, vp, style), ctx), resolveTokens(klass, ctx)),
	);
	const cellS = $derived(s(ct.slot('indicator', { bg: 'color-readable', radius: 'full' }, vp), ctx));
	const wrapS = $derived(
		s(
			effVariant === 'grid'
				? { display: 'grid', gridCols: 3, gap: 1, w: px, h: px }
				: effVariant === 'lines'
					? { row: true, items: 'end', gap: 2, h: px }
					: effVariant === 'circles'
						? { row: true, items: 'center', gap: 3, h: px }
						: { row: true, items: 'center', justify: 'center', w: px, h: px },
		),
	);
</script>

{#if effVariant === 'default' || effVariant === 'pulse' || effVariant === 'puff'}
	<span use:applyStyle={wrapS} role={decorative ? undefined : 'status'} aria-label={decorative ? undefined : label} {...rest}>
		{#if effVariant === 'default'}
			<svg use:spin use:nativeProps={{ source: icons.spinner }} use:applyStyle={resolved}></svg>
		{:else}
			<div use:spin use:applyStyle={mergeStyleDesc(cellS, s({ w: px * 0.7, h: px * 0.7 }))}></div>
		{/if}
	</span>
{:else}
	<span use:applyStyle={wrapS} role={decorative ? undefined : 'status'} aria-label={decorative ? undefined : label} {...rest}>
		{#each cells as i (i)}
			<div
				use:spin={i}
				use:applyStyle={mergeStyleDesc(cellS, s(
					effVariant === 'lines'
						? { w: Math.max(2, px / 7), h: px * 0.85, radius: 'none' }
						: { w: effVariant === 'grid' ? px / 3 - 1 : px / 4, h: effVariant === 'grid' ? px / 3 - 1 : px / 4 },
				))}
			></div>
		{/each}
	</span>
{/if}
