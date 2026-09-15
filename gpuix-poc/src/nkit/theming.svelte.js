// nkit theming — the svelai <Theme>/ThemeState model on the style-prop lane.
//
// ThemeState mirrors svelai's: theme selection (theme/resolvedTheme/system),
// runtime designTokens compiled onto the token tables, the resolved motion
// scale, the component-theme registry, responsive props, and a window-event
// registry. One module-level `current` is the fallback when no <Theme> wraps
// the tree — leaf utilities (transitions, useComponentTheme) read it.
//
// Registry entry shape (components={{ button: {…} }}):
//   { size:'large'…      → variant-prop defaults (top-level, non-slot keys)
//     root: {…}|{base,variant:{…}}  → slot StyleProps (also `slots.{name}`, `style`=root)
//     motion: {in,out,duration,easing}
//     override: true     → drop the recipe base for that component }

import { getContext, setContext } from 'svelte';
import {
	PALETTE, SPACING, RADIUS, FONT_SIZE, CONTROL_H, ICON,
	applyPalette, applyDesignTokens, setDefaultColor, clearTokenCaches,
} from './tokens.js';
import { mergeProps } from './style.js';
import { resolveSide, toMotionProps, toGpuixEase } from './motion.js';

export { toGpuixEase };

const KEY = 'nkit:theme';
const CTHEME = 'nkit:ctheme:';

// svelai defaultMotionTokens verbatim (tailwind/scales.js)
export const MOTION_DEFAULTS = {
	duration: { instant: 0, fast: 100, normal: 200, slow: 300, slower: 500 },
	easing: { standard: 'cubicInOut', enter: 'cubicOut', exit: 'cubicIn', emphasized: 'backOut' },
};

const BREAKPOINTS = [['xs', 0], ['sm', 640], ['md', 768], ['lg', 1024], ['xl', 1280]];
const breakpointOf = (w) => { let b = 'xs'; for (const [k, min] of BREAKPOINTS) if (w >= min) b = k; return b; };
const BP_ORD = { base: 0, xs: 0, sm: 1, md: 2, lg: 3, xl: 4 };

const deepAssign = (dst, src) => {
	for (const k in src ?? {}) {
		const v = src[k];
		if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) deepAssign(dst[k], v);
		else dst[k] = v;
	}
	return dst;
};

export class ThemeState {
	// ── options (Theme.svelte assigns from props) ──
	themes = $state(['light', 'dark']);
	forcedTheme = $state(undefined);
	enableSystem = $state(true);
	enableColorScheme = $state(true);
	attribute = $state('data-theme');
	value = $state(undefined);          // Record<theme, attrValue>
	colorScheme = $state(undefined);    // Record<theme,'light'|'dark'> for custom names
	storageKey = $state('theme');
	designTokens = $state({});          // Record<theme, tokens>
	motionTokens = $state(undefined);   // <Theme motion> partial
	components = $state({});            // <Theme components> registry
	spinnerVariant = $state('default');
	reduceMotion = $state(undefined);   // undefined → OS pref
	transitionOnChange = $state(true);
	themeTransition = $state(undefined);
	size = $state(undefined);           // global default component size
	density = $state(undefined);
	defaultColor = $state('neutral');   // reactive mirror of tokens.setDefaultColor
	defaultColorBase = $state(undefined); // <Theme defaultColor> — under designTokens[t].defaultColor
	onThemeChange = $state(undefined);  // persist hook: (theme) => void
	onSystemResolve = $state(undefined);// detect hook: () => 'light'|'dark'

	// ── live state ──
	#theme = $state('system');          // the selection ('system' or a name)
	system = $state('dark');            // detected OS scheme
	osReduced = $state(false);
	vw = $state(1024);                  // viewport — Theme.svelte keeps it synced
	vh = $state(768);

	get theme() { return this.#theme; }
	set theme(v) {
		if (!v || v === this.#theme) return;
		this.#theme = v;
		this.onThemeChange?.(v);
	}
	/** set the selection without firing the persist hook (init/restore) */
	initTheme(v) { if (v) this.#theme = v; }
	/** resolved name: forcedTheme > system-resolution > selection */
	get resolvedTheme() {
		if (this.forcedTheme) return this.forcedTheme;
		return this.#theme === 'system' && this.enableSystem ? this.system : this.#theme;
	}
	get systemTheme() { return this.system; }
	/** the attribute value for the resolved theme (value map or the name) */
	get themeValue() { return this.value?.[this.resolvedTheme] ?? this.resolvedTheme; }
	/** which palette the resolved theme drives */
	get palette() {
		const r = this.resolvedTheme;
		return this.colorScheme?.[r] ?? (r === 'light' ? 'light' : 'dark');
	}
	get preferReducesMotion() { return this.reduceMotion ?? this.osReduced; }
	/** resolved motion scale: defaults ← <Theme motion> ← designTokens[t].motion */
	get motion() {
		const out = { duration: { ...MOTION_DEFAULTS.duration }, easing: { ...MOTION_DEFAULTS.easing } };
		deepAssign(out, this.motionTokens);
		deepAssign(out, this.designTokens?.[this.resolvedTheme]?.motion);
		return out;
	}
	/** deprecated svelai alias: normal duration + standard easing */
	get transition() {
		return { duration: this.motion.duration.normal, easing: this.motion.easing.standard };
	}
	get currentBreakpoint() { return breakpointOf(this.vw); }
	get isMobile() { return BP_ORD[this.currentBreakpoint] < BP_ORD.md; }

	/** {base?,sm?,md?,lg?,xl?} → the value at the largest breakpoint ≤ current */
	resolveResponsiveProps = (props, def) => {
		if (props == null || typeof props !== 'object' || Array.isArray(props)) return props ?? def;
		const cur = BP_ORD[this.currentBreakpoint];
		let best = def, bo = -1;
		for (const k in props) {
			const o = BP_ORD[k];
			if (o !== undefined && o <= cur && o >= bo) { best = props[k]; bo = o; }
		}
		return best;
	};

	/** svelai splitTransition: flat spec → both sides; {in,out} → named sides */
	splitTransition = (props) => {
		if (props == null) return { in: undefined, out: undefined };
		if ('in' in props || 'out' in props) return { in: props.in, out: props.out };
		return { in: props, out: props };
	};

	/** window-event registry (Theme.svelte wires <svelte:window> → emit) */
	#listeners = new Map();
	addEventListener = (type, cb) => {
		let set = this.#listeners.get(type);
		if (!set) this.#listeners.set(type, (set = new Set()));
		set.add(cb);
		return () => set.delete(cb);
	};
	emit = (type, e) => {
		const set = this.#listeners.get(type);
		if (set) for (const cb of [...set]) cb(e);
	};
	get hasListeners() { return this.#listeners.size > 0; }
}

// ── active state (module fallback when no <Theme> is mounted) ──

let current = new ThemeState();
export const themeState = () => current;
export const motionReduced = () => current.preferReducesMotion;

/** svelai useTheme — nearest Theme's state, else the module fallback */
export function useTheme() {
	return getContext(KEY) ?? current;
}

/** svelai useDefaultColor — call inside $derived */
export function useDefaultColor(color) {
	return color ?? useTheme().defaultColor ?? 'neutral';
}

/** apply the resolved theme's palette + designTokens + caches — Theme.svelte
 *  calls this inside an $effect; safe to call after mutating options too. */
export function applyResolvedTheme(state = current) {
	applyPalette(state.palette);
	const dt = state.designTokens?.[state.resolvedTheme];
	applyDesignTokens(dt);
	const dc = dt?.defaultColor ?? state.defaultColorBase ?? 'neutral';
	setDefaultColor(dc);
	state.defaultColor = dc;
}

/** install a state as the module-level current (Theme.svelte calls this) */
export function installTheme(state) {
	current = state;
	applyResolvedTheme(state);
}

export function provideTheme(state) {
	setContext(KEY, state);
	installTheme(state);
}

// ── component theme ladder ────────────────────────────────────────────
// slot entry resolution: `e` may be StyleProps, or {base, <axis>:{<val>:props}}

const RESERVED = new Set(['slots', 'style', 'motion', 'override', 'props']);

function slotEntry(entry, name) {
	if (!entry) return undefined;
	return entry.slots?.[name] ?? entry[name] ?? (name === 'root' ? entry.style : undefined);
}

/** prop defaults: entry's top-level keys that aren't slots/reserved */
function propDefaults(entry, slotNames) {
	const out = {};
	for (const k in entry ?? {}) {
		if (RESERVED.has(k) || k === 'root' || slotNames.has(k)) continue;
		out[k] = entry[k];
	}
	return out;
}

/** merge one slot entry into `out`: base + variant maps selected by vp */
function mergeSlotEntry(out, e, vp) {
	if (!e) return;
	if (e.base) {
		mergeProps(out, e.base);
		for (const axis in e) {
			if (axis === 'base' || axis === 'override') continue;
			const sel = e[axis]?.[vp[axis]] ?? e[axis]?.[String(vp[axis])];
			if (sel) mergeProps(out, sel);
		}
	} else mergeProps(out, e); // bare StyleProps = base
}

/**
 * useComponentTheme(name, instTheme, slots) — the svelai ladder:
 *   recipe defaults → <Theme components> → setComponentTheme subtree →
 *   instance `theme` prop → (root) instance `style` prop.
 * Call at component init; the returned fns are reactive-safe ($derived).
 */
export function useComponentTheme(name, instTheme, slots = []) {
	const th = getContext(KEY) ?? current;
	const sub = getContext(CTHEME + name);
	const slotNames = new Set(['root', ...slots]);
	const levels = () => [th.components?.[name], sub, instTheme];
	return {
		state: th,
		/** resolved variant-prop values: global defaults < registry < subtree
		 *  < instance-theme prop defaults < defined instance props */
		props(vprops = {}) {
			const out = {};
			if (vprops.color === undefined) out.color = th.defaultColor ?? 'neutral';
			if (vprops.size === undefined && th.size !== undefined) out.size = th.size;
			if (vprops.density === undefined && th.density !== undefined) out.density = th.density;
			for (const L of levels()) deepAssign(out, propDefaults(L, slotNames));
			for (const k in vprops) if (vprops[k] !== undefined) out[k] = vprops[k];
			return out;
		},
		/** resolved slot StyleProps (hand to `s()`): recipe(vp) → per-level base+variants → inst */
		slot(name, recipeOrProps, vp, instStyle) {
			const out = {};
			const lv = levels();
			if (!lv.some((l) => l?.override))
				mergeProps(out, typeof recipeOrProps === 'function' ? recipeOrProps(vp) : recipeOrProps);
			for (const L of lv) mergeSlotEntry(out, slotEntry(L, name), vp ?? {});
			if (name === 'root') mergeProps(out, instStyle);
			return out;
		},
		/** root slot + the instance `style` escape hatch landing last */
		root(recipeOrProps, vp, instStyle) {
			return this.slot('root', recipeOrProps, vp, instStyle);
		},
		/** resolved motion spec — see motion.js componentMotion for `transition` prop handling */
		motion: (presetResolver, vprops, instTransition) =>
			resolveComponentMotion(name, presetResolver, vprops, instTransition, levels(), th),
	};
}

/** svelai set{Component}Theme — call in a wrapper/layout; affects the subtree */
export function setComponentTheme(name, entry) {
	setContext(CTHEME + name, entry);
}

const SIDES = new Set(['in', 'out']);
const stripSides = (m = {}) => {
	const out = {};
	for (const k in m) if (!SIDES.has(k)) out[k] = m[k];
	return out;
};

/** motion ladder: preset → registry → subtree → instance theme.motion →
 *  instance `transition` prop (named side replaces; flat replaces both).
 *  Token names still resolve through the live scale; reduceMotion → 0 last. */
export function resolveComponentMotion(name, presetResolver, vprops, instTransition, lv = [current.components?.[name]], th = current) {
	const base = typeof presetResolver === 'function' ? presetResolver(vprops ?? {}) : (presetResolver ?? {});
	let inS = { ...stripSides(base), ...(base.in ?? {}) };
	let outS = { ...stripSides(base), ...(base.out ?? {}) };
	for (const L of lv) {
		const m = L?.motion;
		if (!m) continue;
		const flat = stripSides(m);
		inS = { ...inS, ...flat, ...(m.in ?? {}) };
		outS = { ...outS, ...flat, ...(m.out ?? {}) };
	}
	const t = th.splitTransition(instTransition);
	if (t.in) inS = { ...inS, ...t.in };
	if (t.out) outS = { ...outS, ...t.out };
	const scale = th.motion, reduced = th.preferReducesMotion;
	return {
		in: toMotionProps(inS, scale, reduced),
		out: resolveSide(outS, outS, scale, reduced),
		spec: { in: inS, out: outS },
	};
}

// ── token overrides (low-level escape hatch, also used by Theme) ──────

/** merge token-table overrides — colors into PALETTE, plus spacing/radius/
 *  fontSize/control/icon scales — then invalidate every resolve cache. */
export function applyTokenOverrides(tokens = {}) {
	const { colors, spacing, radius, fontSize, control, icon } = tokens;
	if (colors) deepAssign(PALETTE, colors);
	if (spacing) deepAssign(SPACING, spacing);
	if (radius) deepAssign(RADIUS, radius);
	if (fontSize) deepAssign(FONT_SIZE, fontSize);
	if (control) deepAssign(CONTROL_H, control);
	if (icon) deepAssign(ICON, icon);
	clearTokenCaches();
}
