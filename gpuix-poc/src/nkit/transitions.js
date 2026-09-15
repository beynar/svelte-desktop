// Svelte transition functions (`in:`/`out:`/`transition:`) for gdom nodes.
// Contract: fn(node, params) → {delay, duration, easing, tick(t,u)}.
// tick writes native style props per frame (opacity / insets / size / radius —
// the MotionStyle set). `out:` gets keep-alive for free: Svelte delays unmount
// until the outro's duration elapses.
//
// Durations accept ms or theme tokens ('instant'|'fast'|'normal'|'slow'|'slower');
// easings accept gpuix names, svelai names (cubicOut, backOut…), or a
// cubic-bezier tuple; reduceMotion collapses every duration to 0.

import { themeState } from './theming.svelte.js';

// Penner set under the svelai easing names (transitions/easingFunctions)
const pow = Math.pow;
export const EASE_FNS = {
	linear: (t) => t,
	ease: (t) => t * t * (3 - 2 * t),
	easeIn: (t) => t * t,
	easeOut: (t) => 1 - (1 - t) * (1 - t),
	easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
	quadIn: (t) => t * t,
	quadOut: (t) => 1 - (1 - t) * (1 - t),
	quadInOut: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
	cubicIn: (t) => t * t * t,
	cubicOut: (t) => --t * t * t + 1,
	cubicInOut: (t) => (t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1),
	quartIn: (t) => t * t * t * t,
	quartOut: (t) => 1 - --t * t * t * t,
	quartInOut: (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - 8 * --t * t * t * t),
	quintIn: (t) => t * t * t * t * t,
	quintOut: (t) => 1 + --t * t * t * t * t,
	quintInOut: (t) => (t < 0.5 ? 16 * t * t * t * t * t : 1 + 16 * --t * t * t * t * t),
	sineIn: (t) => 1 - Math.cos((t * Math.PI) / 2),
	sineOut: (t) => Math.sin((t * Math.PI) / 2),
	sineInOut: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
	expoIn: (t) => (t === 0 ? 0 : pow(2, 10 * t - 10)),
	expoOut: (t) => (t === 1 ? 1 : 1 - pow(2, -10 * t)),
	expoInOut: (t) => (t === 0 || t === 1 ? t : t < 0.5 ? pow(2, 20 * t - 10) / 2 : (2 - pow(2, -20 * t + 10)) / 2),
	circIn: (t) => 1 - Math.sqrt(1 - t * t),
	circOut: (t) => Math.sqrt(1 - --t * t),
	circInOut: (t) => (t < 0.5 ? (1 - Math.sqrt(1 - 4 * t * t)) / 2 : (Math.sqrt(1 - (-2 * t + 2) * (t * -2 + 2)) + 1) / 2),
	backIn: (t) => 2.70158 * t * t * t - 1.70158 * t * t,
	backOut: (t) => 1 + 2.70158 * --t * t * t + 1.70158 * t * t,
	backInOut: (t) => {
		const c = 1.70158 * 1.525;
		return t < 0.5 ? (pow(2 * t, 2) * ((c + 1) * 2 * t - c)) / 2 : (pow(2 * t - 2, 2) * ((c + 1) * (2 * t - 2) + c) + 2) / 2;
	},
};
const cubic = (a, b, c, d) => (t) => { const u = 1 - t; return 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; }; // y-only approx (a,c=x ignored)

function scale() { return themeState().motion; }
function dur(v, def = 'normal') {
	const th = themeState();
	if (th.preferReducesMotion) return 0;
	if (typeof v === 'number') return v;
	return scale().duration[v ?? def] ?? scale().duration.normal;
}
function ease(v) {
	if (Array.isArray(v)) return cubic(v[0], v[1], v[2], v[3]);
	const named = scale().easing[v] ?? v;
	return EASE_FNS[named] ?? EASE_FNS.easeInOut;
}

const set = (node, k, v) => { node.style.props.set(k, v); };
const push = (node) => node.style.push?.();

/**
 * Generic frame transition: interpolate FrameSpec values from → current.
 *   { opacity, x, y, top,left,right,bottom, w,h, width,height, radius,
 *     mx, my, duration, delay, easing }
 * x/y = insets (positioned elements); mx/my = margin offsets (flow elements —
 * insets do nothing in normal flow, margins do). Numbers interpolate.
 */
export function fso(node, params = {}) {
	const { duration, delay = 0, easing } = params;
	const ms = dur(duration);
	const ez = ease(easing);
	const from = {
		opacity: params.opacity,
		top: params.top ?? params.y,
		left: params.left ?? params.x,
		right: params.right,
		bottom: params.bottom,
		width: params.width ?? params.w,
		height: params.height ?? params.h,
		borderRadius: params.radius,
		marginLeft: params.mx,
		marginTop: params.my,
	};
	const active = Object.entries(from).filter(([, v]) => v !== undefined);
	return {
		delay,
		duration: ms,
		tick(t, u) {
			const e = ez(t);
			for (const [k, v] of active) {
				if (typeof v === 'number') {
					// t: 0→1 on intro (from→natural), 1→0 on outro (natural→from)
					const base = k === 'opacity' ? 1 : 0;
					set(node, k, v + (base - v) * e);
				}
			}
			push(node);
		},
	};
}

export const fade = (node, params = {}) => fso(node, { ...params, opacity: params.opacity ?? 0 });
export const fly = (node, params = {}) => fso(node, { ...params, opacity: params.opacity ?? 0, y: params.y ?? 8, x: params.x ?? 0 });
export const zoom = (node, params = {}) => fso(node, { ...params, opacity: params.opacity ?? 0, radius: params.radius });
/** slide = height clip — measures the laid-out height, animates height+opacity */
export function slide(node, params = {}) {
	const h = node.getBoundingClientRect?.().height ?? 0;
	const ms = dur(params.duration);
	const ez = ease(params.easing);
	return {
		delay: params.delay ?? 0,
		duration: ms,
		tick(t) {
			const e = ez(t);
			set(node, 'height', h * e);
			set(node, 'opacity', e);
			set(node, 'overflow', 'hidden');
			push(node);
		},
	};
}
