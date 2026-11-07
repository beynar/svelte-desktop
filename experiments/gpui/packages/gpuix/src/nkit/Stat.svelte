<script>
	import { style, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { componentTheme } from './theming.svelte.js';
	import { statTheme } from './recipes/display.js';
	import { icons } from './icons.js';

	let {
		label,
		value,
		unit,
		delta,
		trend = 'flat',          // up | down | flat
		trendDirection,           // alias: 'up'|'down' overrides trend
		indicator,                // small leading marker (icon name)
		description,
		size ,
		color,
		class: klass = '',
		style: instStyle = null,
		theme = null,
		...rest
	} = $props();

	const ct = componentTheme('stat', () => theme, ['label', 'value', 'unit', 'delta']);
	const vp = $derived(ct.props({ size, color }));
	const ctx = $derived({ color: vp.color });
	const effTrend = $derived(trendDirection ?? trend);
	const rootS = $derived(mergeStyleDesc(style(ct.root(statTheme.root, vp, instStyle)), resolveTokens(klass, ctx)));
	const labelS = $derived(style(ct.slot('label', statTheme.label, vp)));
	const valueS = $derived(style(ct.slot('value', statTheme.value, vp), ctx));
	const unitS = $derived(style(ct.slot('unit', statTheme.unit, vp)));
	const deltaS = $derived(style(ct.slot('delta', statTheme.delta, { ...vp, trend: effTrend })));
	const indS = $derived(style({ icon: 'sm', fg: 'color-readable' }, ctx));
	const rowS = $derived(style({ row: true, items: 'end', gap: 'micro' }));
</script>

<div use:applyStyle={rootS} {...rest}>
	{#if label}<div use:applyStyle={labelS}>{label}</div>{/if}
	<div use:applyStyle={rowS}>
		{#if indicator}<svg use:nativeProps={{ source: icons[indicator] ?? indicator }} use:applyStyle={indS}></svg>{/if}
		<div use:applyStyle={valueS}>{value}</div>
		{#if unit}<div use:applyStyle={unitS}>{unit}</div>{/if}
	</div>
	{#if delta != null && delta !== ''}<div use:applyStyle={deltaS}>{delta}</div>{/if}
	{#if description}<div use:applyStyle={labelS}>{description}</div>{/if}
</div>
