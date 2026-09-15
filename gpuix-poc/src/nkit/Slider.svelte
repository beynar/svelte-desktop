<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { sliderTheme } from './recipes/form.js';

	let {
		value = $bindable(null),
		defaultValue,
		min = 0,
		max = 100,
		step = 1,
		disabled = false,
		color,
		onchange,
		onValueChange,
		onmousedown,
		onmousemove,
		onmouseup,
		onkeydown,
		class: klass = '',
		style = null,
		theme = null,
		...rest
	} = $props();

	const ct = useComponentTheme('slider', theme, ['track', 'fill', 'thumb']);
	const vp = $derived(ct.props({ color, disabled }));
	const ctx = $derived({ color: vp.color });
	value ??= defaultValue ?? min;
	let el = $state(null);
	let dragging = $state(false);
	const pct = $derived(Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)));

	const rootS = $derived(mergeStyleDesc(s(ct.root(sliderTheme.root, vp, style)), resolveTokens(klass)));
	const trackS = $derived(s(ct.slot('track', sliderTheme.track, vp)));
	const fillS = $derived(s(ct.slot('fill', sliderTheme.fill, { ...vp, style: { w: pct + '%' } }), ctx));
	// thumb rides inside the fill: right:-8 centers a 16px thumb on the fill's
	// right edge (gpuix insets are f64 px — no calc/percent left).
	const thumbS = $derived(
		s(ct.slot('thumb', sliderTheme.thumb, { ...vp, dragging, style: { position: 'absolute', right: -8, top: -6 } }), ctx),
	);
	const fillTrackS = $derived(s({ position: 'relative', h: 'full', w: 'full' }));


	function setFromX(x) {
		const r = el?.getBoundingClientRect();
		if (!r) return;
		const [bx, , bw] = Array.isArray(r) ? r : [r.x, r.y, r.width];
		const p = Math.max(0, Math.min(1, (x - bx) / bw));
		const raw = min + p * (max - min);
		const stepped = Math.round(raw / step) * step;
		if (stepped !== value) { value = stepped; onchange?.(value); onValueChange?.(value); }
	}
	const keyStep = (e) => {
		const k = e.key ?? e.detail?.key;
		if (k === 'right' || k === 'arrowright' || k === 'up' || k === 'arrowup') {
			value = Math.min(max, value + step); onchange?.(value); onValueChange?.(value); e.preventDefault?.();
		} else if (k === 'left' || k === 'arrowleft' || k === 'down' || k === 'arrowdown') {
			value = Math.max(min, value - step); onchange?.(value); onValueChange?.(value); e.preventDefault?.();
		}
		onkeydown?.(e);
	};
</script>

<div
	bind:this={el}
	use:applyStyle={rootS}
	use:nativeProps={{ tabIndex: disabled ? undefined : 0 }}
	onmousedown={(e) => { if (!disabled) { dragging = true; setFromX(e.x); } onmousedown?.(e); }}
	onmousemove={(e) => { if (dragging && e.pressedButton === 0) setFromX(e.x); onmousemove?.(e); }}
	onmouseup={(e) => { dragging = false; onmouseup?.(e); }}
	onkeydown={keyStep}
	role="slider" aria-valuenow={value} aria-valuemin={min} aria-valuemax={max}
	{...rest}
>
	<div use:applyStyle={trackS}>
		<div use:applyStyle={mergeStyleDesc(fillS, fillTrackS)}>
			<div use:applyStyle={thumbS}></div>
		</div>
	</div>
</div>
