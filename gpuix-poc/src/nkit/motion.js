// motion() — svelai's "cva of transitions" on the gpuix motion prop.
//
// A preset describes `{ in, out, duration, easing, delay }` where each side
// is a FrameSpec:
//   { opacity, x, y, w, h, radius, top,left,right,bottom, width,height,
//     duration, easing, delay, animate }
// `x`/`y` map to left/top offsets (gpuix animates insets, not transforms).
// `in` resolves to a native MotionProps — {initial, animate, transition} —
// applied via use:nativeProps={{ motion }}: the GPU animates mount and any
// later `animate` change with zero JS per frame. `out` resolves to a spec
// consumed by the transition fns in transitions.js (tick-driven — unmount
// has no native channel).

import { themeState } from './theming.svelte.js';

/** svelai easing names → gpuix MotionEase (named keyword or cubic-bezier tuple) */
export const EASE_MAP = {
	linear: 'linear', ease: 'ease', easeIn: 'easeIn', easeOut: 'easeOut', easeInOut: 'easeInOut',
	quadIn: [0.55, 0.085, 0.68, 0.53], quadOut: [0.25, 0.46, 0.45, 0.94], quadInOut: [0.455, 0.03, 0.515, 0.955],
	cubicIn: [0.55, 0.055, 0.675, 0.19], cubicOut: [0.215, 0.61, 0.355, 1], cubicInOut: [0.645, 0.045, 0.355, 1],
	quartIn: [0.895, 0.03, 0.685, 0.22], quartOut: [0.165, 0.84, 0.44, 1], quartInOut: [0.77, 0, 0.175, 1],
	quintIn: [0.755, 0.05, 0.855, 0.06], quintOut: [0.23, 1, 0.32, 1], quintInOut: [0.86, 0, 0.07, 1],
	sineIn: [0.47, 0, 0.745, 0.715], sineOut: [0.39, 0.575, 0.565, 1], sineInOut: [0.445, 0.05, 0.55, 0.95],
	expoIn: [0.95, 0.05, 0.795, 0.035], expoOut: [0.19, 1, 0.22, 1], expoInOut: [1, 0, 0, 1],
	circIn: [0.6, 0.04, 0.98, 0.335], circOut: [0.075, 0.82, 0.165, 1], circInOut: [0.785, 0.135, 0.15, 0.86],
	backIn: [0.6, -0.28, 0.735, 0.045], backOut: [0.175, 0.885, 0.32, 1.275], backInOut: [0.68, -0.55, 0.265, 1.55],
};
export const toGpuixEase = (v) => (Array.isArray(v) ? v : (EASE_MAP[v] ?? v ?? 'easeInOut'));

/** FrameSpec → gpuix MotionStyle (the animatable subset) */
export function frame(f = {}) {
	const out = {};
	if (f.opacity !== undefined) out.opacity = f.opacity;
	if (f.x !== undefined) out.left = f.x;
	if (f.y !== undefined) out.top = f.y;
	if (f.w !== undefined) out.width = f.w;
	if (f.h !== undefined) out.height = f.h;
	if (f.radius !== undefined) out.borderRadius = f.radius;
	for (const k of ['top', 'left', 'right', 'bottom', 'width', 'height', 'borderRadius'])
		if (f[k] !== undefined) out[k] = f[k];
	return out;
}

const deepMerge = (a, b) => ({ ...(a ?? {}), ...(b ?? {}) });

/** resolve duration/easing tokens against a scale — reduced flattens to 0ms.
 *  Output `transition` is native MotionTransition (seconds + gpuix ease). */
export function resolveSide(f, base, scale, reduced) {
	const m = { ...(base ?? {}), ...(f ?? {}) };
	const durTok = m.duration ?? 'normal';
	const easeTok = m.easing ?? 'standard';
	const duration = reduced ? 0 : typeof durTok === 'number' ? durTok : (scale.duration[durTok] ?? scale.duration.normal);
	const easeName = scale.easing[easeTok] ?? easeTok;
	return {
		style: frame(m),
		transition: { duration: duration / 1000, delay: (m.delay ?? 0) / 1000, ease: toGpuixEase(easeName) },
		ms: duration,
	};
}

/**
 * Build a motion preset resolver — cva-shaped:
 *   motion({ base: { in:{opacity:0}, out:{opacity:0}, duration:'fast' },
 *            variants: { side: { top: {in:{y:-8}}, … } } })
 * resolver(variantProps, {overrides, theme}) → { inSpec, outSpec }
 * (raw merged FrameSpecs — resolveComponentMotion runs them through the
 * override ladder + token resolution.)
 */
export function motion(config) {
	const { base = {}, variants = {}, defaultVariants = {} } = config;
	return (props = {}, options = {}) => {
		const vprops = { ...defaultVariants, ...props };
		let inSpec = deepMerge(base, base.in);
		let outSpec = deepMerge(base, base.out);
		for (const vk in variants) {
			const sel = variants[vk]?.[vprops[vk]];
			if (sel) { inSpec = deepMerge(inSpec, sel.in); outSpec = deepMerge(outSpec, sel.out); }
		}
		for (const ov of options.overrides ?? []) {
			if (!ov) continue;
			inSpec = deepMerge(inSpec, ov.in);
			outSpec = deepMerge(outSpec, ov.out);
		}
		return { inSpec, outSpec };
	};
}

/** FrameSpec → native MotionProps. animate target: explicit spec.animate,
 *  else natural values for the initial keys (opacity→1, insets→0);
 *  width/height/borderRadius need explicit targets (their natural values
 *  live in the element's style). */
export function toMotionProps(spec, scale, reduced) {
	const r = resolveSide(spec, spec, scale, reduced);
	const animate = spec.animate ? frame(spec.animate) : {};
	if (r.style) {
		for (const k in r.style) {
			if (animate[k] !== undefined) continue;
			if (k === 'opacity') animate.opacity = 1;
			else if (k === 'top' || k === 'right' || k === 'bottom' || k === 'left') animate[k] = 0;
		}
	}
	return { initial: spec.initial === false ? false : r.style, animate, transition: r.transition };
}

/** convenience: MotionProps straight from a FrameSpec (mount animation) */
export function motionProps(spec = {}, th = themeState()) {
	return toMotionProps(spec, th.motion, th.preferReducesMotion);
}

// ── common presets (svelai vocabulary: fade / fly / zoom / slide) ────

export const presets = {
	fade: { in: { opacity: 0 }, out: { opacity: 0 } },
	fly: (y = 8, x = 0) => ({ in: { opacity: 0, y, x }, out: { opacity: 0, y, x } }),
	zoom: { in: { opacity: 0 }, out: { opacity: 0 } },
};
