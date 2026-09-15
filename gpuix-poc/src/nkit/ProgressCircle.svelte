<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens, resolveColorRef } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';

	let {
		value = 0,             // 0..100
		size ,       // small 24 | normal 32 | large 48 — or px number
		diameter,              // explicit px — overrides size
		color,
		label,                 // centered text; true shows the percentage
		track = true,          // paint the track ring
		class: klass = '',
		style = null,
		theme = null,
		...rest
	} = $props();

	const ct = useComponentTheme('progressCircle', theme, ['label']);
	const vp = $derived(ct.props({ color, size }));
	const th = ct.state;

	const SIZES = { small: 24, normal: 32, large: 48 };
	const d = $derived(diameter ?? (typeof vp.size === 'number' ? vp.size : SIZES[vp.size] ?? 32));
	const stroke = $derived(Math.max(2, Math.round(d / 12)));
	const pct = $derived(Math.max(0, Math.min(100, value)));

	// the arc's drawn value tweens toward `value` — native motion can't express
	// stroke-dash geometry, so the JS lane interpolates the pct itself
	let shown = $state(Math.max(0, Math.min(100, value)));
	$effect(() => {
		const target = pct;
		const ms = th.preferReducesMotion ? 0 : th.motion.duration.normal;
		if (shown === target || !ms) { shown = target; return; }
		const from = shown, t0 = performance.now();
		let raf;
		const step = () => {
			const t = Math.min(1, (performance.now() - t0) / ms);
			shown = from + (target - from) * t;
			if (t < 1) raf = requestAnimationFrame(step);
		};
		raf = requestAnimationFrame(step);
		return () => cancelAnimationFrame?.(raf);
	});

	// arc path for a ring segment — gpuix renders any svg `source`
	const arc = $derived.by(() => {
		const r = (d - stroke) / 2;
		const c = d / 2;
		const end = (shown / 100) * 360 - 90;
		const rad = (end * Math.PI) / 180;
		const x = c + r * Math.cos(rad);
		const y = c + r * Math.sin(rad);
		const large = shown > 50 ? 1 : 0;
		return `M ${c} ${c - r} A ${r} ${r} 0 ${large} 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
	});
	const trackPath = $derived.by(() => {
		const r = (d - stroke) / 2;
		const c = d / 2;
		return `M ${c} ${c - r} A ${r} ${r} 1 1 1 ${c - 0.01} ${c - r}`;
	});
	const fg = $derived(resolveColorRef(`${vp.color}-readable`) ?? resolveColorRef(vp.color) ?? '#7c9aff');
	const bg = $derived(resolveColorRef('neutral-muted') ?? '#333');
	const src = $derived(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${d} ${d}" fill="none">` +
			(track ? `<path d="${trackPath}" stroke="${bg}" stroke-width="${stroke}" stroke-linecap="round"/>` : '') +
			(shown > 0 ? `<path d="${arc}" stroke="${fg}" stroke-width="${stroke}" stroke-linecap="round"/>` : '') +
			`</svg>`,
	);
	const wrapS = $derived(
		mergeStyleDesc(s({ w: d, h: d, position: 'relative', items: 'center', justify: 'center', ...(style ?? {}) }), resolveTokens(klass)),
	);
	const labelS = $derived(s({ position: 'absolute', inset: 0, items: 'center', justify: 'center', text: 'xs', fg: 'neutral' }));
</script>

<div use:applyStyle={wrapS} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} {...rest}>

	<svg use:nativeProps={{ source: src }} style="width:{d}px;height:{d}px"></svg>
	{#if label}
		<div use:applyStyle={labelS}>{label === true ? `${Math.round(pct)}%` : label}</div>
	{/if}
</div>
