// svelai token → gpuix native-style resolver.
// The palette is svelai's OWN generateColorPalette output (dark theme), dumped
// once as hex — the oklch mixing math lives in ai2, we consume resolved values.
// Every token either lands on a native prop or is recorded in `dropped` — that
// list is the honest boundary of the vocabulary.

import { themeRev, bumpTheme } from './revision.svelte.js';

export const PALETTE = {
	primary: { base: '#5f62ef', dark: '#191ee8', light: '#a5a6f6', lighter: '#d3d4fb', muted: '#181b3b', contrast: '#ffffff', readable: '#98a5ff', 'muted-readable': '#98a5ff' },
	secondary: { base: '#27272a', dark: '#020202', light: '#4c4c52', lighter: '#64646c', muted: '#1f1f20', contrast: '#ffffff', readable: '#b7b7bb', 'muted-readable': '#b7b7bb' },
	danger: { base: '#dc2626', dark: '#9c1919', light: '#e76868', lighter: '#ee9494', muted: '#36110e', contrast: '#ffffff', readable: '#ff7466', 'muted-readable': '#ff7466' },
	success: { base: '#15803d', dark: '#0a3e1e', light: '#20c25c', lighter: '#36de75', muted: '#0f2414', contrast: '#ffffff', readable: '#71d088', 'muted-readable': '#71d088' },
	warning: { base: '#f59e0b', dark: '#ac6f07', light: '#f8bb55', lighter: '#facf85', muted: '#2e1a01', contrast: '#000000', readable: '#f9a217', 'muted-readable': '#f9a217' },
	info: { base: '#2563eb', dark: '#1043b3', light: '#6b95f1', lighter: '#9ab7f6', muted: '#0f1e3b', contrast: '#ffffff', readable: '#6ab0ff', 'muted-readable': '#6ab0ff' },
	neutral: { base: '#fafafa', dark: '#f5f5f5', light: '#ffffff', lighter: '#ffffff', muted: '#1f1f1f', contrast: '#000000', readable: '#b7b7b7', 'muted-readable': '#b7b7b7' },
	surface: { base: '#111113', recessed: '#09090b', canvas: '#0d0d0f', raised: '#161618', floating: '#27272a' },
};

// `--state-hover-opacity`/`--state-pressed-opacity` are per-scheme plugin
// options in svelai: dark defaults 0.16/0.32, light 0.05/0.10.
export const STATE_OPACITY = {
	dark: { hover: 0.16, pressed: 0.32 },
	light: { hover: 0.05, pressed: 0.10 },
};
let currentMode = 'dark';
let stateOpacity = { ...STATE_OPACITY.dark };
export const stateHoverOpacity = () => stateOpacity.hover;
export const statePressedOpacity = () => stateOpacity.pressed;

/** light-mode palette — svelai's generateColorPalette output for the light
 *  scheme (surface #fafafa), same shape as PALETTE; `mode` swaps it in place. */
export const PALETTE_LIGHT = {
	primary: { base: '#5f62ef', dark: '#191ee8', light: '#a5a6f6', lighter: '#d3d4fb', muted: '#e6eaff', contrast: '#ffffff', readable: '#595ae6', 'muted-readable': '#4f4dd9' },
	secondary: { base: '#e4e4e7', dark: '#bcbcc3', light: '#ffffff', lighter: '#ffffff', muted: '#ebebec', contrast: '#000000', readable: '#47474a', 'muted-readable': '#47474a' },
	danger: { base: '#dc2626', dark: '#9c1919', light: '#e76868', lighter: '#ee9494', muted: '#ffe4e0', contrast: '#ffffff', readable: '#d2161c', 'muted-readable': '#cb0314' },
	success: { base: '#15803d', dark: '#0a3e1e', light: '#20c25c', lighter: '#36de75', muted: '#d9f4dd', contrast: '#ffffff', readable: '#097b38', 'muted-readable': '#007532' },
	warning: { base: '#f59e0b', dark: '#ac6f07', light: '#f8bb55', lighter: '#facf85', muted: '#ffe7cc', contrast: '#000000', readable: '#ac5a00', 'muted-readable': '#9f4e00' },
	info: { base: '#2563eb', dark: '#1043b3', light: '#6b95f1', lighter: '#9ab7f6', muted: '#e1ecff', contrast: '#ffffff', readable: '#2664ec', 'muted-readable': '#1a57de' },
	neutral: { base: '#18181b', dark: '#131316', light: '#242428', lighter: '#3c3c43', muted: '#ebebec', contrast: '#ffffff', readable: '#47474b', 'muted-readable': '#47474b' },
	surface: { base: '#fafafa', recessed: '#f4f4f4', canvas: '#f7f7f7', raised: '#fdfdfd', floating: '#ffffff' },
};

// the Theme's defaultColor feeds `color` props that don't pin one
let defaultColor = 'neutral';
export const getDefaultColor = () => defaultColor;
export const setDefaultColor = (c) => { defaultColor = c ?? 'neutral'; clearTokenCaches(); };

/** other resolve caches (style.js sCache) register here — palette/token
 *  mutations invalidate all of them together. `bumpTheme` re-runs every
 *  reactive style derivation so mounted elements restyle in place. */
const cacheClears = [];
export const registerTokenCacheClear = (fn) => cacheClears.push(fn);
export function clearTokenCaches() {
	resolveCache.clear();
	for (const fn of cacheClears) fn();
	bumpTheme();
}

const DARK_PALETTE = Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => [k, { ...v }]));

/** named palettes: built-in dark/light + whatever `registerPalette` adds.
 *  A Theme's `themes`/`colorScheme` map logical names onto these. */
const PALETTES = { dark: DARK_PALETTE, light: PALETTE_LIGHT };
export const paletteNames = () => Object.keys(PALETTES);
/** the effective role map for a scheme name — registered overrides included */
export const paletteByName = (name) => PALETTES[name];
export function registerPalette(name, palette) {
	PALETTES[name] = Object.fromEntries(Object.entries(palette).map(([k, v]) => [k, { ...v }]));
}

/** swap a palette in place (PALETTE identity is shared) and invalidate.
 *  A named scheme also swaps its state-layer opacities — they are per-scheme
 *  in svelai, so 'light' must not keep dark's 0.16/0.32. */
export function applyPalette(nameOrObj) {
	const src = typeof nameOrObj === 'string' ? PALETTES[nameOrObj] : nameOrObj;
	if (!src) return;
	if (typeof nameOrObj === 'string' && STATE_OPACITY[nameOrObj]) {
		currentMode = nameOrObj;
		stateOpacity = { ...STATE_OPACITY[nameOrObj] };
		buildElevation(); // dark doubles shadow strength and adds tints
	}
	for (const role in PALETTE) {
		if (!src[role]) continue;
		for (const k in PALETTE[role]) delete PALETTE[role][k];
		Object.assign(PALETTE[role], src[role]);
	}
	for (const role in src) if (!PALETTE[role]) PALETTE[role] = { ...src[role] };
	clearTokenCaches();
}
export const setPaletteMode = (mode = 'dark') => applyPalette(mode);

// --spacing = 4px; svelai scale: xs/sm/md/lg/xl = 1/1.5/2/3/4
export const SPACING = { 0: 0, micro: 2, xs: 4, sm: 6, md: 8, lg: 12, xl: 16, 'layout-sm': 20, 'layout-md': 24, 'layout-lg': 32, 'layout-xl': 48 };
// the live `--spacing` value — named scales are multiples of it and bare
// numerics resolve in spacing units (both rescale with the spacing factor)
let spacingUnit = 4;
export const getSpacingUnit = () => spacingUnit;
const spacingOf = (v) => SPACING[v] ?? (/^\d+(\.\d+)?$/.test(v) ? +v * spacingUnit : null); // named scale + tailwind numerics
// geometry: svelai derives every size from `calc(var(--spacing) * N)` — the
// numbers below are N×4px at the default spacing and rescale with the
// spacing factor like svelai's custom properties do.
export const CONTROL_H = { sm: 28, md: 32, lg: 36 };       // ×7/8/9
export const ROW_H = { sm: 32, md: 40, lg: 48 };           // ×8/10/12
export const ICON = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24 }; // ×3/3.5/4/5/6
export const HIT = { sm: 28, md: 32, lg: 36 };             // ×7/8/9
export const INDENT = { sm: 24, md: 32, lg: 40, xl: 48 };  // ×6/8/10/12
export const FONT_SIZE = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48, '6xl': 60, '7xl': 72, '8xl': 96, '9xl': 128 };
export const RADIUS = { none: 0, xs: 2, sm: 4, md: 8, lg: 12, xl: 16, '2xl': 20, '3xl': 24, '4xl': 32, full: 9999 };
export const FONT_W = { normal: 400, medium: 500, semibold: 600, bold: 700 };
export const MOTION = {
	duration: { instant: 0, fast: 100, normal: 200, slow: 300, slower: 500 },
	easing: { standard: 'cubicInOut', enter: 'cubicOut', exit: 'cubicIn', emphasized: 'backOut' },
};
export const ALIGN = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', baseline: 'baseline' };
export const JUSTIFY = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between', around: 'space-around', evenly: 'space-evenly' };
export const SHADOWS = {
	xs: { offsetX: 0, offsetY: 1, blurRadius: 2, spreadRadius: 0, color: 'rgba(0,0,0,0.35)' },
	sm: { offsetX: 0, offsetY: 1, blurRadius: 3, spreadRadius: 0, color: 'rgba(0,0,0,0.4)' },
	md: { offsetX: 0, offsetY: 4, blurRadius: 8, spreadRadius: -1, color: 'rgba(0,0,0,0.45)' },
	lg: { offsetX: 0, offsetY: 8, blurRadius: 16, spreadRadius: -2, color: 'rgba(0,0,0,0.5)' },
};

// ── elevation engine — svelai scales.ts verbatim. `raised-*`/`lift-*` resolve
// through this table; `flat|normal|high` rescales alpha+blur, dark mode ×1.8
// strength plus a white tonal tint per level. ──
const ELEVATION_STACKS = [
	[],
	[[1, 2, 0.06]],
	[[1, 3, 0.08], [1, 2, 0.06]],
	[[4, 6, 0.08], [2, 4, 0.06]],
	[[10, 15, 0.1], [4, 6, 0.06]],
	[[20, 25, 0.12], [8, 10, 0.08]],
];
const ELEVATION_FACTORS = { flat: { alpha: 0, blur: 1 }, normal: { alpha: 1, blur: 1 }, high: { alpha: 1.5, blur: 1.3 } };
const ELEVATION_TINT = [0, 0.03, 0.05, 0.07, 0.09, 0.11];
let elevationFactor = 'normal';
/** resolved per level: dominant shadow of the stack (our one-shadow model)
 *  + the dark-mode tint alpha (0 = transparent). */
export const ELEVATION = [];

function buildElevation() {
	const f = ELEVATION_FACTORS[elevationFactor] ?? ELEVATION_FACTORS.normal;
	const dark = currentMode === 'dark';
	ELEVATION.length = 0;
	for (let level = 0; level < ELEVATION_STACKS.length; level++) {
		const stack = ELEVATION_STACKS[level];
		let shadow = null;
		if (stack.length && f.alpha > 0) {
			// strongest member = the deepest blur — the stack's far shadow
			let best = stack[0];
			for (const s of stack) if (s[1] > best[1]) best = s;
			const a = Math.min(1, best[2] * f.alpha * (dark ? 1.8 : 1));
			shadow = { offsetX: 0, offsetY: best[0], blurRadius: Math.round(best[1] * f.blur), spreadRadius: 0, color: `rgba(0,0,0,${Math.round(a * 1000) / 1000})` };
		}
		const tint = dark && f.alpha > 0 ? ELEVATION_TINT[level] : 0;
		ELEVATION.push({ shadow, tint });
	}
}
const ELEVATION_ALIAS = { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, xs: 1, sm: 2, md: 3, lg: 4, xl: 5, '2xl': 5 };
buildElevation();

const hexRgb = (h) => {
	const m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(h);
	return m ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)] : null;
};

// ── designTokens — svelai's runtime geometry scale, compiled onto the
// shared token tables. Factors match svelai's tailwind/scales exactly. ──

const SPACING_BASE = { ...SPACING };
const RADIUS_BASE = { ...RADIUS };
const FONT_BASE = { ...FONT_SIZE };
const GEOMETRY_BASE = {
	control: { ...CONTROL_H },
	row: { ...ROW_H },
	icon: { ...ICON },
	hit: { ...HIT },
	indent: { ...INDENT },
};
const GEOMETRY_MULTIPLIERS = {
	control: { sm: 7, md: 8, lg: 9 },
	row: { sm: 8, md: 10, lg: 12 },
	icon: { xs: 3, sm: 3.5, md: 4, lg: 5, xl: 6 },
	hit: { sm: 7, md: 8, lg: 9 },
	indent: { sm: 6, md: 8, lg: 10, xl: 12 },
};
const GEOMETRY_TABLES = { control: CONTROL_H, row: ROW_H, icon: ICON, hit: HIT, indent: INDENT };
const SPACING_SCALE_BASE = { xs: 1, sm: 1.5, md: 2, lg: 3, xl: 4 };

const SPACING_FACTORS = { small: 0.8, normal: 1, large: 1.2 };
const RADIUS_FACTORS = { none: 0, subtile: 0.5, small: 0.75, normal: 1, large: 1.5, round: 2.5 };
const TYPE_RATIOS = { minorSecond: 1.067, majorSecond: 1.125, minorThird: 1.2, majorThird: 1.25, perfectFourth: 1.32, augmentedFourth: 1.414, perfectFifth: 1.5, goldenRatio: 1.618 };
const TYPE_PRESETS = {
	compact: { baseMinPx: 14, baseMaxPx: 16, scale: 'minorThird' },
	default: { baseMinPx: 16, baseMaxPx: 18, scale: 'majorThird' },
	comfortable: { baseMinPx: 16, baseMaxPx: 20, scale: 'majorThird' },
	large: { baseMinPx: 18, baseMaxPx: 22, scale: 'perfectFourth' },
};
// type steps as exponents of the base px — svelai's typeScaleSteps (xs=−2 … 9xl=+10)
const TYPE_EXP = { xs: -2, sm: -1, base: 0, lg: 1, xl: 2, '2xl': 3, '3xl': 4, '4xl': 5, '5xl': 6, '6xl': 7, '7xl': 8, '8xl': 9, '9xl': 10 };
// svelai legibility floors: xs/sm can never render below their flat sizes
const TYPE_FLOORS = { xs: 12, sm: 14 };

let raisedWithBorder = true;
export const getRaisedWithBorder = () => raisedWithBorder;

/** fluid type base: svelai clamps between baseMinPx@minViewport and
 *  baseMaxPx@maxViewport — we resolve the clamp against the real window width */
function typeBasePx(ts) {
	const p = typeof ts === 'string' ? TYPE_PRESETS[ts] : ts;
	if (!p) return FONT_BASE.base;
	const minV = p.minViewport ?? 375, maxV = p.maxViewport ?? 1440;
	const w = globalThis.window?.innerWidth ?? 1024;
	const t = Math.max(0, Math.min(1, (w - minV) / (maxV - minV)));
	return p.baseMinPx + (p.baseMaxPx - p.baseMinPx) * t;
}

/** apply one theme's designTokens to the shared tables; `undefined` restores
 *  the factory scales. Reactive consumers re-resolve via clearTokenCaches. */
export function applyDesignTokens(tokens) {
	const t = tokens ?? {};
	// spacing: named scale ×factor, xs..xl rebuilt from spacingScale multipliers
	const sf = typeof t.spacing === 'number' ? t.spacing : SPACING_FACTORS[t.spacing ?? 'normal'] ?? 1;
	spacingUnit = 4 * sf;
	for (const k in SPACING) SPACING[k] = SPACING_BASE[k] * sf;
	const ss = { ...SPACING_SCALE_BASE, ...(t.spacingScale ?? {}) };
	for (const k of ['xs', 'sm', 'md', 'lg', 'xl']) if (ss[k] != null) SPACING[k] = spacingUnit * ss[k];
	// geometry is spacing × multipliers — it rescales with the same factor
	for (const kind in GEOMETRY_TABLES)
		for (const size in GEOMETRY_TABLES[kind])
			GEOMETRY_TABLES[kind][size] = GEOMETRY_BASE[kind][size] * sf;
	// radius: factor over the whole scale
	const rf = typeof t.radius === 'number' ? t.radius : RADIUS_FACTORS[t.radius ?? 'normal'] ?? 1;
	for (const k in RADIUS) RADIUS[k] = k === 'full' ? RADIUS_BASE[k] : RADIUS_BASE[k] * rf;
	// typeScale: fluid base through the preset's ratio ramp
	const tsp = typeof t.typeScale === 'string' ? TYPE_PRESETS[t.typeScale] : t.typeScale;
	if (tsp) {
		const ratio = TYPE_RATIOS[tsp.scale ?? 'majorThird'] ?? 1.25;
		const base = typeBasePx(t.typeScale);
		const sizes = {};
		for (const step in TYPE_EXP) sizes[step] = base * Math.pow(ratio, TYPE_EXP[step]);
		// floors applied smallest-up so a floor can't push past the next step
		for (const step of ['sm', 'xs']) sizes[step] = Math.min(Math.max(sizes[step], TYPE_FLOORS[step]), sizes[step === 'sm' ? 'base' : 'sm']);
		for (const step in TYPE_EXP) FONT_SIZE[step] = Math.round(sizes[step] * 10) / 10;
	} else Object.assign(FONT_SIZE, FONT_BASE);
	// state-layer opacities are per-scheme plugin options in svelai — each
	// apply rebases to the active scheme's defaults, then explicit overrides
	// apply (kebab or camel keys, same as the native theme prop).
	stateOpacity = { ...STATE_OPACITY[currentMode] };
	const hoverO = t['state-hover-opacity'] ?? t.stateHoverOpacity;
	const pressedO = t['state-pressed-opacity'] ?? t.statePressedOpacity;
	if (typeof hoverO === 'number') stateOpacity.hover = hoverO;
	if (typeof pressedO === 'number') stateOpacity.pressed = pressedO;
	// elevation preset — rebuild the resolved stacks (mode + factor aware)
	elevationFactor = typeof t.elevation === 'string' ? t.elevation : 'normal';
	buildElevation();
	raisedWithBorder = t.raisedWithBorder ?? true;
	if (t.defaultColor) setDefaultColor(t.defaultColor);
	else clearTokenCaches();
}
const toHex8 = (rgb, a) =>
	'#' + rgb.map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('') +
	Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');
/** fg composited over bg at `a` — transparent bg → alpha hex, solid bg → mixed rgb */
export const overlay = (bg, fg, a) => {
	const f = hexRgb(fg) ?? [250, 250, 250];
	const b = bg && bg !== 'transparent' ? hexRgb(bg) : null;
	return b ? toHex8(b.map((c, i) => c * (1 - a) + f[i] * a), 1) : toHex8(f, a);
};
export const withAlpha = (hex, a) => {
	const rgb = hexRgb(hex);
	return rgb ? toHex8(rgb, a) : hex;
};

/** bg-primary / text-color-readable / border-neutral-muted / bg-color/0 → hex|null */
export function resolveColorRef(ref, ctx) {
	if (typeof ref !== 'string') return null;
	let alpha = null;
	const ai = ref.indexOf('/');
	if (ai !== -1) {
		alpha = parseFloat(ref.slice(ai + 1));
		if (alpha > 1) alpha /= 100;
		ref = ref.slice(0, ai);
	}
	let hex = null;
	if (ref === 'transparent') hex = 'transparent';
	else if (ref === 'current') hex = 'currentColor';
	else if (ref === 'color' || ref.startsWith('color-')) {
		// the `color` placeholder: 'color-muted-readable' → variant 'muted-readable'
		const p = PALETTE[ctx.color ?? defaultColor];
		hex = p?.[ref === 'color' ? 'base' : ref.slice(6)] ?? p?.base;
	} else if (ref === 'surface' || ref.startsWith('surface-')) {
		hex = PALETTE.surface[ref === 'surface' ? 'base' : ref.slice(8)] ?? PALETTE.surface.base;
	} else {
		// variant is everything after the first dash: 'primary-muted-readable'
		const i = ref.indexOf('-');
		const role = i === -1 ? ref : ref.slice(0, i);
		const variant = i === -1 ? undefined : ref.slice(i + 1);
		const p = PALETTE[role];
		if (p) hex = p[variant ?? 'base'] ?? p.base;
	}
	if (hex == null) return null;
	if (alpha !== null) {
		if (!Number.isFinite(alpha)) return null;
		if (alpha === 0) return 'transparent';
		hex = withAlpha(hex, alpha);
	}
	return hex;
}

const PAD_DIR = { p: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'], px: ['paddingLeft', 'paddingRight'], py: ['paddingTop', 'paddingBottom'], pt: ['paddingTop'], pr: ['paddingRight'], pb: ['paddingBottom'], pl: ['paddingLeft'], ps: ['paddingLeft'], pe: ['paddingRight'] };
// ms/me are logical props — gpuix renders LTR only, so they map to l/r
const MAR_DIR = { m: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'], mx: ['marginLeft', 'marginRight'], my: ['marginTop', 'marginBottom'], mt: ['marginTop'], mr: ['marginRight'], mb: ['marginBottom'], ml: ['marginLeft'], ms: ['marginLeft'], me: ['marginRight'] };

/** well-formed color reference: a name or name-variant chain, `/alpha`, or a
 *  literal the native parser owns (`#hex`, `rgb()`, `hsl()`, `oklch()`).
 *  Exported for style.js's definition-time validation — grammar acceptance
 *  when the palette can't answer yet (scoped/theme-registered names). */
export const COLOR_NAME_REF = /^([a-zA-Z][\w-]*|#.+|.+\(.*\))(?:\/.*)?$/;
const BORD_DIR = { 'border-t': 'borderTopWidth', 'border-r': 'borderRightWidth', 'border-b': 'borderBottomWidth', 'border-l': 'borderLeftWidth' };
export const CURSOR = { pointer: 'pointer', default: 'default', 'not-allowed': 'not-allowed', text: 'text', grab: 'grab', grabbing: 'grabbing', move: 'move', 'col-resize': 'col-resize', 'row-resize': 'row-resize', 'ew-resize': 'ew-resize', 'ns-resize': 'ns-resize' };
export const TRACK = { tighter: -0.8, tight: -0.4, normal: 0, wide: 0.4, wider: 0.8, widest: 1.6 };
/** Tailwind leading scale — the unitless multiplier, resolved × font size. */
export const LEADING = { none: 1, tight: 1.25, snug: 1.375, normal: 1.5, relaxed: 1.625, loose: 2 };
const RADIUS_CORNER = {
	tl: ['borderTopLeftRadius'], tr: ['borderTopRightRadius'],
	bl: ['borderBottomLeftRadius'], br: ['borderBottomRightRadius'],
	t: ['borderTopLeftRadius', 'borderTopRightRadius'],
	b: ['borderBottomLeftRadius', 'borderBottomRightRadius'],
	l: ['borderTopLeftRadius', 'borderBottomLeftRadius'],
	r: ['borderTopRightRadius', 'borderBottomRightRadius'],
};

/** one token → native props into `out`. state = {ring, dropped} */
function applyToken(tok, ctx, out, state) {
	const t = tok.startsWith('!') ? tok.slice(1) : tok;
	if (!t) return;
	// spacing-driven padding/margin/gap — the token NAME crosses the wire;
	// the native resolver owns ×--spacing, named scales, and geometry
	// prefixes, so a theme swap restyles without JS re-emitting values.
	const sp = (v) => (v === 'px' ? 1 : String(v));
	let m = /^(p|px|py|pt|pr|pb|pl|ps|pe)-([\w-]+)$/.exec(t);
	if (m && spacingOf(m[2]) != null) return void PAD_DIR[m[1]].forEach((k) => (out[k] = sp(m[2])));
	m = /^(m|mx|my|mt|mr|mb|ml|ms|me)-([\w-]+)$/.exec(t);
	if (m && spacingOf(m[2]) != null) return void MAR_DIR[m[1]].forEach((k) => (out[k] = sp(m[2])));
	m = /^(gap|gap-x|gap-y)-([\w-]+)$/.exec(t);
	if (m && spacingOf(m[2]) != null) {
		if (m[1] !== 'gap-x') out.rowGap = sp(m[2]);
		if (m[1] !== 'gap-y') out.columnGap = sp(m[2]);
		return;
	}
	// display / flex
	if (t === 'flex' || t === 'inline-flex') { out.display = 'flex'; if (t === 'inline-flex' && !out.flexDirection) out.flexDirection = 'row'; return; }
	if (t === 'grid') { out.display = 'grid'; return; }
	if ((m = /^flex-(row|col|row-reverse|col-reverse|wrap|nowrap)$/.exec(t))) {
		if (m[1] === 'wrap' || m[1] === 'nowrap') out.flexWrap = m[1];
		else out.flexDirection = { row: 'row', col: 'column', 'row-reverse': 'row-reverse', 'col-reverse': 'column-reverse' }[m[1]];
		return;
	}
	if ((m = /^grid-cols-(\d+)$/.exec(t))) { out.gridTemplateColumns = +m[1]; return; }
	if ((m = /^grid-cols-\[(.+)\]$/.exec(t))) { out.gridTemplateColumns = Math.max(1, m[1].split('_').length); return; }
	if (t === 'flex-1' || t === 'grow') { out.flexGrow = 1; if (t === 'flex-1') out.flexShrink = 1; return; }
	if (t === 'shrink-0') { out.flexShrink = 0; return; }
	if (t === 'shrink') { out.flexShrink = 1; return; }
	if ((m = /^(items|justify|content|self)-(\w+)$/.exec(t))) {
		const table = m[1] === 'items' || m[1] === 'self' ? ALIGN : JUSTIFY;
		const v = table[m[2]] ?? (m[1] === 'items' ? ALIGN[m[2]] : JUSTIFY[m[2]]);
		if (v) { out[{ items: 'alignItems', justify: 'justifyContent', content: 'alignContent', self: 'alignSelf' }[m[1]]] = v; return; }
	}
	// sizing — geometry tokens pass through as names
	if ((m = /^h-control-(sm|md|lg)$/.exec(t))) { out.height = 'control-' + m[1]; return; }
	if ((m = /^(min-h|h)-row-(sm|md|lg)$/.exec(t))) { out[m[1] === 'h' ? 'height' : 'minHeight'] = 'row-' + m[2]; return; }
	if ((m = /^size-icon-(xs|sm|md|lg|xl)$/.exec(t))) { out.width = out.height = 'icon-' + m[1]; return; }
	if ((m = /^min-size-hit-(sm|md|lg)$/.exec(t))) { out.minWidth = out.minHeight = 'hit-' + m[1]; return; }
	if ((m = /^ps-indent-(sm|md|lg|xl)$/.exec(t))) { out.paddingLeft = 'indent-' + m[1]; return; }
	if ((m = /^([hw]|min-w|min-h|max-w|max-h)-(\d+(?:\.\d+)?)$/.exec(t))) {
		out[{ h: 'height', w: 'width', 'min-w': 'minWidth', 'min-h': 'minHeight', 'max-w': 'maxWidth', 'max-h': 'maxHeight' }[m[1]]] = m[2];
		return;
	}
	if (t === 'w-full' || t === 'h-full' || t === 'max-w-full' || t === 'max-h-full') {
		out[{ 'w-full': 'width', 'h-full': 'height', 'max-w-full': 'maxWidth', 'max-h-full': 'maxHeight' }[t]] = '100%';
		return;
	}
	if ((m = /^(w|h|min-w|min-h|max-w|max-h)-(fit|auto|min|max)$/.exec(t))) {
		const key = { w: 'width', h: 'height', 'min-w': 'minWidth', 'min-h': 'minHeight', 'max-w': 'maxWidth', 'max-h': 'maxHeight' }[m[1]];
		// fit/auto normalize to 'auto' natively; min/max have no StyleDesc shape
		if (m[2] === 'min' || m[2] === 'max') { if (m[1] === 'w' || m[1] === 'min-w') out.alignSelf ??= 'flex-start'; return void state.dropped.push(t); }
		out[key] = m[2];
		if (m[1] === 'w' || m[1] === 'min-w' || m[1] === 'max-w') out.alignSelf ??= 'flex-start'; // hug: flex-start ≈ shrink-to-fit in a column parent
		return;
	}
	if (t === 'aspect-square') { out.aspectRatio = 1; return; }
	if (t === 'aspect-video') { out.aspectRatio = 16 / 9; return; }
	if ((m = /^aspect-\[(\d+(?:\.\d+)?)[/_](\d+(?:\.\d+)?)\]$/.exec(t))) { out.aspectRatio = +m[1] / +m[2]; return; }
	// typography
	if ((m = /^text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)$/.exec(t))) { out.fontSize = m[1]; return; }
	if ((m = /^font-(normal|medium|semibold|bold)$/.exec(t))) { out.fontWeight = m[1]; return; }
	if ((m = /^text-(left|center|right)$/.exec(t))) { out.textAlign = m[1]; return; }
	if ((m = /^tracking-(\w+)$/.exec(t)) && TRACK[m[1]] != null) { out.letterSpacing = TRACK[m[1]]; return; }
	// leading-* — named scale is the CSS unitless multiplier (lineHeightScale
	// resolves × font size natively); numeric suffixes are px.
	if ((m = /^leading-(none|tight|snug|normal|relaxed|loose)$/.exec(t))) { out.lineHeightScale = LEADING[m[1]]; return; }
	if ((m = /^leading-(\d+(?:\.\d+)?)$/.exec(t))) { out.lineHeight = +m[1]; return; }
	// text-transform + font features — applied to the string / at shape time.
	if (t === 'uppercase') { out.textTransform = 'uppercase'; return; }
	if (t === 'lowercase') { out.textTransform = 'lowercase'; return; }
	if (t === 'capitalize') { out.textTransform = 'capitalize'; return; }
	if (t === 'normal-case') { out.textTransform = 'none'; return; }
	if (t === 'tabular-nums') { out.fontFeatures = { tnum: 1 }; return; }
	// corner radii — `rounded-tl-*` etc. write the longhand fields.
	if ((m = /^rounded-(tl|tr|bl|br|t|b|l|r)(?:-(none|xs|sm|md|lg|xl|2xl|3xl|4xl|full))?$/.exec(t))) {
		for (const f of RADIUS_CORNER[m[1]]) out[f] = m[2] ?? 'sm';
		return;
	}
	if (t === 'italic') { out.fontStyle = 'italic'; return; }
	if (t === 'not-italic') { out.fontStyle = 'normal'; return; }
	if (t === 'underline') { out.textDecoration = 'underline'; return; }
	if (t === 'line-through') { out.textDecoration = 'line-through'; return; }
	if (t === 'no-underline') { out.textDecoration = 'none'; return; }
	if ((m = /^decoration-(.+)$/.exec(t))) {
		const c = resolveColorRef(m[1], ctx);
		if (c == null) return void state.dropped.push(t);
		out.textDecorationColor = m[1];
		return;
	}
	if (t === 'whitespace-nowrap') { out.whiteSpace = 'nowrap'; return; }
	if (t === 'truncate') { out.whiteSpace = 'nowrap'; out.textOverflow = 'ellipsis'; out.overflowX = 'hidden'; return; }
	// box
	if (t === 'border') { out.borderWidth = 1; return; }
	if (BORD_DIR[t]) { out[BORD_DIR[t]] = 1; return; }
	if ((m = /^border-(\d+)$/.exec(t))) { out.borderWidth = +m[1]; return; }
	if ((m = /^rounded(?:-(none|xs|sm|md|lg|xl|2xl|3xl|4xl|full))?$/.exec(t))) { out.borderRadius = m[1] ?? 'sm'; return; }
	if ((m = /^ring-(\d+)$/.exec(t))) { state.ring.w = +m[1]; return; }
	if (t === 'ring') { state.ring.w = 1; return; }
	if (t === 'ring-inset') { state.ring.inset = true; return; }
	if ((m = /^shadow-(xs|sm|md|lg)$/.exec(t)) || t === 'shadow') { out.boxShadow = SHADOWS[m?.[1] ?? 'sm']; return; }
	// svelai `raised-*`/`lift-*` — the pseudo-field crosses the wire; the
	// native resolver expands shadow + hairline + dark tint wash.
	if ((m = /^(raised|lift)(?:-(none|0|1|2|3|4|5|xs|sm|md|lg|xl|2xl))?$/.exec(t))) {
		out[m[1]] = m[2] ?? '';
		return;
	}
	if ((m = /^opacity-(\d+)$/.exec(t))) { out.opacity = +m[1] / 100; return; }
	if ((m = /^overflow-(hidden|auto|scroll|visible)$/.exec(t))) { const v = m[1] === 'auto' ? 'scroll' : m[1]; out.overflowX = v; out.overflowY = v; return; }
	// color shorthands — refs cross the wire verbatim (`primary`, `color-muted`,
	// `surface-raised`, `primary/20`, literals); the NATIVE resolver resolves
	// them against the live theme, scoped `theme` overrides included — so a
	// name that exists only in a scoped palette must still cross. JS-side
	// resolution is only a sanity gate: well-formed color names and literals
	// pass through, malformed refs hit the dropped audit here.
	if ((m = /^(bg|text|border|ring)-(.+)$/.exec(t))) {
		const [, kind, ref] = m;
		const c = resolveColorRef(ref, ctx);
		if (c == null && !COLOR_NAME_REF.test(ref)) return void state.dropped.push(t);
		if (kind === 'ring') { state.ring.c = ref; return; }
		out[kind === 'bg' ? 'backgroundColor' : kind === 'text' ? 'color' : 'borderColor'] = ref;
		return;
	}
	// interaction / behavior
	if (t === 'state-layer') { out.stateLayer = true; return; }
	if ((m = /^cursor-(\w[\w-]*)$/.exec(t)) && CURSOR[m[1]]) { out.cursor = CURSOR[m[1]]; return; }
	if (t === 'select-none') { out.userSelect = 'none'; return; }
	if (t === 'pointer-events-none') { out.pointerEvents = 'none'; return; }
	if (t === 'absolute' || t === 'fixed' || t === 'sticky') { out.position = t === 'sticky' ? 'absolute' : t; return; }
	// explicit no-ops: cascade/compositor-only concepts with no native meaning
	if (/^(relative$|group\/|box-border|bg-clip-padding|outline-none|auto-rows-|row-|col-|transition|duration-|ease-|animate-)/.test(t)) return;
	state.dropped.push(t);
}

const PSEUDO = /^((?:hover|active|focus-visible|focus-within|focus|\*|\[[^\]]*\]|group-[\w-]+(?:\/\w+)?|group-data-\[[^\]]*\](?:\/\w+)?|data-\[[^\]]*\]|aria-\[[^\]]*\]|has-\[[^\]]*\]|not-\([^)]*\)|peer-[\w-]+(?:\/\w+)?):)+/;
const GROUP_DATA_COLOR = /^group-data-\[color=(\w+)\](?:\/\w+)?$/;

/** deterministic on (tokens, color) — recipe outputs are static, so cache */
const resolveCache = new Map();

/** svelai class string → gpuix StyleDesc ({…base, hover?, active?}) + dropped list */
export function resolveTokens(str, ctx = {}) {
	void themeRev.v; // subscribe: theme swaps re-resolve every mounted style
	const key = (ctx.color ?? '') + '|' + str;
	const hit = resolveCache.get(key);
	if (hit) return hit;
	const out = resolveTokensInner(str, ctx);
	if (resolveCache.size > 4000) resolveCache.clear(); // bounded — no unbounded growth
	resolveCache.set(key, out);
	return out;
}

function resolveTokensInner(str, ctx = {}, collect) {
	const out = {};
	const state = { ring: {}, dropped: collect ?? [] };
	// ring state accumulates PER BUCKET across tokens — `ring-2` and
	// `ring-color/50` are separate tokens that must merge into one member.
	const rings = new Map(); // bucket object → { w?, c?, inset? }
	const emitRing = (bucket) => {
		const r = rings.get(bucket);
		if (r?.w != null)
			bucket.boxShadow = {
				offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: r.w,
				// Tailwind v4 --tw-ring-color default is currentColor; the
				// native resolver maps it onto the element's resolved `color`.
				color: r.c ?? 'currentColor', ring: true,
				...(r.inset ? { inset: true } : {}),
			};
	};
	for (const raw of String(str).split(/\s+/)) {
		if (!raw) continue;
		let tok = raw, bucket = out;
		const pm = PSEUDO.exec(tok);
		if (pm) {
			const pseudos = pm[1].slice(0, -1).split(':');
			tok = tok.slice(pm[1].length);
			// group-data-[color=X]/parent: a compile-time condition — resolve
			// against ctx.color; no match means the rule simply doesn't apply
			const gc = pseudos.map((p) => GROUP_DATA_COLOR.exec(p)).find(Boolean);
			if (gc) {
				pseudos.splice(pseudos.indexOf(gc[0]), 1);
				if ((ctx.color ?? 'neutral') !== gc[1]) continue;
			}
			if (!pseudos.length) bucket = out;
			else if (pseudos.includes('hover')) bucket = (out.hover ??= {});
			else if (pseudos.includes('active')) bucket = (out.active ??= {});
			// focus channels exist natively — focus-visible → focus_visible
			// refinement, focus-within → in_focus, focus → .focus()
			else if (pseudos.includes('focus-visible')) bucket = (out.focusVisible ??= {});
			else if (pseudos.includes('focus-within')) bucket = (out.focusWithin ??= {});
			else if (pseudos.includes('focus')) bucket = (out.focus ??= {});
			else { state.dropped.push(raw); continue; } // [&_svg]/data-*/peer-*/… no native channel
		}
		// ring is per-bucket: hover:ring-* must land on out.hover, not base.
		// The member is flagged `ring` so the native raised-merge keeps it.
		const sub = { ring: rings.get(bucket) ?? {}, dropped: state.dropped };
		applyToken(tok, ctx, bucket, sub);
		rings.set(bucket, sub.ring);
		emitRing(bucket);
	}
	if (!collect) for (const d of state.dropped) droppedTokens.add(d);
	// svelai's `data-color` bridge — the resolved color ctx crosses as the
	// `color` custom prop so the subtree's `color-*` refs see it natively.
	if (ctx.color) out.ctxColor = ctx.color;
	return out;
}

/** every token the resolver couldn't map — the audit trail for coverage */
export const droppedTokens = new Set();

/** definition-time check: the tokens a class string would drop, without
 *  touching caches or the audit — cva()/theme definitions call this at
 *  module load. */
export const checkTokens = (str, ctx = {}) => {
	const dropped = [];
	resolveTokensInner(str, ctx, dropped);
	return dropped;
};
