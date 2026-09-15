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
export const STATE_HOVER = 0.16;
export const STATE_PRESSED = 0.32;

/** light-mode palette — same shape as PALETTE; `mode` swaps it in place. */
export const PALETTE_LIGHT = {
	primary: { base: '#4f52e3', dark: '#2b2fd0', light: '#8b8df0', lighter: '#c6c7f8', muted: '#e3e4fd', contrast: '#ffffff', readable: '#4c51d9', 'muted-readable': '#4c51d9' },
	secondary: { base: '#e4e4e7', dark: '#d4d4d8', light: '#f4f4f5', lighter: '#fafafa', muted: '#f4f4f5', contrast: '#18181b', readable: '#52525b', 'muted-readable': '#52525b' },
	danger: { base: '#dc2626', dark: '#b91c1c', light: '#ef7b7b', lighter: '#f6b1b1', muted: '#fdeaea', contrast: '#ffffff', readable: '#c22020', 'muted-readable': '#c22020' },
	success: { base: '#16a34a', dark: '#15803d', light: '#4ade80', lighter: '#a7f0c4', muted: '#e8f8ee', contrast: '#ffffff', readable: '#15803d', 'muted-readable': '#15803d' },
	warning: { base: '#d97706', dark: '#b45309', light: '#f5b449', lighter: '#fbd38d', muted: '#fdf3e0', contrast: '#000000', readable: '#b45309', 'muted-readable': '#b45309' },
	info: { base: '#2563eb', dark: '#1d4ed8', light: '#6b95f1', lighter: '#b3c8f7', muted: '#e7effd', contrast: '#ffffff', readable: '#1d4ed8', 'muted-readable': '#1d4ed8' },
	neutral: { base: '#18181b', dark: '#27272a', light: '#3f3f46', lighter: '#52525b', muted: '#e4e4e7', contrast: '#fafafa', readable: '#52525b', 'muted-readable': '#71717a' },
	surface: { base: '#ffffff', recessed: '#f4f4f5', canvas: '#fafafa', raised: '#f4f4f5', floating: '#ffffff' },
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
export function registerPalette(name, palette) {
	PALETTES[name] = Object.fromEntries(Object.entries(palette).map(([k, v]) => [k, { ...v }]));
}

/** swap a palette in place (PALETTE identity is shared) and invalidate. */
export function applyPalette(nameOrObj) {
	const src = typeof nameOrObj === 'string' ? PALETTES[nameOrObj] : nameOrObj;
	if (!src) return;
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
const spacingOf = (v) => SPACING[v] ?? (/^\d+(\.\d+)?$/.test(v) ? +v * 4 : null); // named scale + tailwind numerics (×4)
export const CONTROL_H = { sm: 28, md: 32, lg: 36 };
export const ICON = { sm: 14, md: 16, lg: 20 };
export const FONT_SIZE = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, '2xl': 24, '3xl': 30 };
export const RADIUS = { none: 0, sm: 4, md: 8, lg: 12, xl: 16, '2xl': 20, full: 9999 };
export const FONT_W = { normal: 400, medium: 500, semibold: 600, bold: 700 };
export const ALIGN = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', baseline: 'baseline' };
export const JUSTIFY = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between', around: 'space-around', evenly: 'space-evenly' };
export const SHADOWS = {
	xs: { offsetX: 0, offsetY: 1, blurRadius: 2, spreadRadius: 0, color: 'rgba(0,0,0,0.35)' },
	sm: { offsetX: 0, offsetY: 1, blurRadius: 3, spreadRadius: 0, color: 'rgba(0,0,0,0.4)' },
	md: { offsetX: 0, offsetY: 4, blurRadius: 8, spreadRadius: -1, color: 'rgba(0,0,0,0.45)' },
	lg: { offsetX: 0, offsetY: 8, blurRadius: 16, spreadRadius: -2, color: 'rgba(0,0,0,0.5)' },
};

const hexRgb = (h) => {
	const m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(h);
	return m ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)] : null;
};

// ── designTokens — svelai's runtime geometry scale, compiled onto the
// shared token tables. Factors match svelai's tailwind/scales exactly. ──

const SPACING_BASE = { ...SPACING };
const RADIUS_BASE = { ...RADIUS };
const FONT_BASE = { ...FONT_SIZE };
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
// type steps as exponents of the base px (xs=−2 … 4xl=+6)
const TYPE_EXP = { xs: -2, sm: -1, base: 0, lg: 1, xl: 2, '2xl': 3, '3xl': 4 };

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
	for (const k in SPACING) SPACING[k] = SPACING_BASE[k] * sf;
	const ss = { ...SPACING_SCALE_BASE, ...(t.spacingScale ?? {}) };
	for (const k of ['xs', 'sm', 'md', 'lg', 'xl']) if (ss[k] != null) SPACING[k] = 4 * ss[k] * sf;
	// radius: factor over the whole scale
	const rf = typeof t.radius === 'number' ? t.radius : RADIUS_FACTORS[t.radius ?? 'normal'] ?? 1;
	for (const k in RADIUS) RADIUS[k] = k === 'full' ? RADIUS_BASE[k] : RADIUS_BASE[k] * rf;
	// typeScale: fluid base through the preset's ratio ramp
	const tsp = typeof t.typeScale === 'string' ? TYPE_PRESETS[t.typeScale] : t.typeScale;
	if (tsp) {
		const ratio = TYPE_RATIOS[tsp.scale ?? 'majorThird'] ?? 1.25;
		const base = typeBasePx(t.typeScale);
		for (const step in TYPE_EXP) FONT_SIZE[step] = Math.round(base * Math.pow(ratio, TYPE_EXP[step]) * 10) / 10;
	} else Object.assign(FONT_SIZE, FONT_BASE);
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
const MAR_DIR = { m: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'], mx: ['marginLeft', 'marginRight'], my: ['marginTop', 'marginBottom'], mt: ['marginTop'], mr: ['marginRight'], mb: ['marginBottom'], ml: ['marginLeft'] };
const BORD_DIR = { 'border-t': 'borderTopWidth', 'border-r': 'borderRightWidth', 'border-b': 'borderBottomWidth', 'border-l': 'borderLeftWidth' };
export const CURSOR = { pointer: 'pointer', default: 'default', 'not-allowed': 'not-allowed', text: 'text', grab: 'grab', grabbing: 'grabbing', move: 'move', 'col-resize': 'col-resize', 'row-resize': 'row-resize', 'ew-resize': 'ew-resize', 'ns-resize': 'ns-resize' };
export const TRACK = { tighter: -0.8, tight: -0.4, normal: 0, wide: 0.4, wider: 0.8, widest: 1.6 };

/** one token → native props into `out`. state = {ring, dropped} */
function applyToken(tok, ctx, out, state) {
	const t = tok.startsWith('!') ? tok.slice(1) : tok;
	if (!t) return;
	// spacing-driven padding/margin/gap
	let m = /^(p|px|py|pt|pr|pb|pl|ps|pe)-([\w-]+)$/.exec(t);
	if (m && spacingOf(m[2]) != null) return void PAD_DIR[m[1]].forEach((k) => (out[k] = spacingOf(m[2])));
	m = /^(m|mx|my|mt|mr|mb|ml)-([\w-]+)$/.exec(t);
	if (m && spacingOf(m[2]) != null) return void MAR_DIR[m[1]].forEach((k) => (out[k] = spacingOf(m[2])));
	m = /^(gap|gap-x|gap-y)-([\w-]+)$/.exec(t);
	if (m && spacingOf(m[2]) != null) {
		if (m[1] !== 'gap-x') out.rowGap = spacingOf(m[2]);
		if (m[1] !== 'gap-y') out.columnGap = spacingOf(m[2]);
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
	// sizing
	if ((m = /^h-control-(sm|md|lg)$/.exec(t))) { out.height = CONTROL_H[m[1]]; return; }
	if ((m = /^size-icon-(sm|md|lg)$/.exec(t))) { out.width = out.height = ICON[m[1]]; return; }
	if ((m = /^min-size-hit-(sm|md|lg)$/.exec(t))) { out.minWidth = out.minHeight = CONTROL_H[m[1]]; return; }
	if ((m = /^([hw]|min-w|min-h|max-w|max-h)-(\d+(?:\.\d+)?)$/.exec(t))) {
		const px = +m[2] * 4;
		out[{ h: 'height', w: 'width', 'min-w': 'minWidth', 'min-h': 'minHeight', 'max-w': 'maxWidth', 'max-h': 'maxHeight' }[m[1]]] = px;
		return;
	}
	if (t === 'w-full' || t === 'h-full' || t === 'max-w-full' || t === 'max-h-full') {
		out[{ 'w-full': 'width', 'h-full': 'height', 'max-w-full': 'maxWidth', 'max-h-full': 'maxHeight' }[t]] = '100%';
		return;
	}
	if (t === 'w-fit' || t === 'max-w-fit' || t === 'min-w-min') { if (t !== 'min-w-min') out.alignSelf ??= 'flex-start'; return; } // hug: flex-start ≈ shrink-to-fit in a column parent
	if (t === 'aspect-square') return void state.dropped.push(t); // no aspectRatio in StyleDesc
	// typography
	if ((m = /^text-(xs|sm|base|lg|xl|2xl|3xl)$/.exec(t))) { out.fontSize = FONT_SIZE[m[1]]; return; }
	if ((m = /^font-(normal|medium|semibold|bold)$/.exec(t))) { out.fontWeight = FONT_W[m[1]]; return; }
	if ((m = /^text-(left|center|right)$/.exec(t))) { out.textAlign = m[1]; return; }
	if ((m = /^tracking-(\w+)$/.exec(t)) && TRACK[m[1]] != null) { out.letterSpacing = TRACK[m[1]]; return; }
	if (t === 'whitespace-nowrap') { out.whiteSpace = 'nowrap'; return; }
	if (t === 'truncate') { out.whiteSpace = 'nowrap'; out.textOverflow = 'ellipsis'; out.overflowX = 'hidden'; return; }
	// box
	if (t === 'border') { out.borderWidth = 1; return; }
	if (BORD_DIR[t]) { out[BORD_DIR[t]] = 1; return; }
	if ((m = /^border-(\d+)$/.exec(t))) { out.borderWidth = +m[1]; return; }
	if ((m = /^rounded(?:-(none|sm|md|lg|xl|2xl|full))?$/.exec(t))) { out.borderRadius = RADIUS[m[1] ?? 'sm'] ?? 0; return; }
	if ((m = /^ring-(\d+)$/.exec(t))) { state.ring.w = +m[1]; return; }
	if (t === 'ring') { state.ring.w = 1; return; }
	if ((m = /^shadow-(xs|sm|md|lg)$/.exec(t)) || t === 'shadow') { out.boxShadow = SHADOWS[m?.[1] ?? 'sm']; return; }
	if ((m = /^opacity-(\d+)$/.exec(t))) { out.opacity = +m[1] / 100; return; }
	if ((m = /^overflow-(hidden|auto|scroll|visible)$/.exec(t))) { const v = m[1] === 'auto' ? 'scroll' : m[1]; out.overflowX = v; out.overflowY = v; return; }
	// color shorthands
	if ((m = /^(bg|text|border|ring)-(.+)$/.exec(t))) {
		const [, kind, ref] = m;
		if (kind === 'ring') { const c = resolveColorRef(ref, ctx); if (c != null) state.ring.c = c; else state.dropped.push(t); return; }
		const c = resolveColorRef(ref, ctx);
		if (c == null) return void state.dropped.push(t);
		out[kind === 'bg' ? 'backgroundColor' : kind === 'text' ? 'color' : 'borderColor'] = c;
		return;
	}
	// interaction / behavior
	if (t === 'state-layer') { state.stateLayer = true; return; }
	if ((m = /^cursor-(\w[\w-]*)$/.exec(t)) && CURSOR[m[1]]) { out.cursor = CURSOR[m[1]]; return; }
	if (t === 'select-none') { out.userSelect = 'none'; return; }
	if (t === 'pointer-events-none') { out.pointerEvents = 'none'; return; }
	if (t === 'absolute' || t === 'fixed' || t === 'sticky') { out.position = t === 'sticky' ? 'absolute' : t; return; }
	// explicit no-ops: cascade/compositor-only concepts with no native meaning
	if (/^(relative$|group\/|box-border|bg-clip-padding|outline-none|leading-|tabular-nums|auto-rows-|row-|col-|transition|duration-|ease-|animate-)/.test(t)) return;
	state.dropped.push(t);
}

const PSEUDO = /^((?:hover|active|focus-visible|focus|\*|\[[^\]]*\]|group-[\w-]+(?:\/\w+)?|group-data-\[[^\]]*\](?:\/\w+)?|data-\[[^\]]*\]|aria-\[[^\]]*\]|has-\[[^\]]*\]|not-\([^)]*\)|peer-[\w-]+(?:\/\w+)?):)+/;
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

function resolveTokensInner(str, ctx = {}) {
	const out = {};
	const state = { ring: {}, dropped: [], stateLayer: false };
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
			else { state.dropped.push(raw); continue; } // focus-visible/[&_svg]… no native channel
		}
		// ring is per-bucket: hover:ring-* must land on out.hover, not base
		const sub = { ring: {}, dropped: state.dropped, stateLayer: false };
		applyToken(tok, ctx, bucket, sub);
		if (sub.ring.c != null)
			bucket.boxShadow = { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: sub.ring.w ?? 1, color: sub.ring.c };
		if (sub.stateLayer) state.stateLayer = true;
	}
	if (state.stateLayer) {
		const fg = typeof out.color === 'string' ? out.color : PALETTE.neutral.readable;
		(out.hover ??= {}).backgroundColor ??= overlay(out.backgroundColor, fg, STATE_HOVER);
		(out.active ??= {}).backgroundColor ??= overlay(out.backgroundColor, fg, STATE_PRESSED);
	}
	for (const d of state.dropped) droppedTokens.add(d);
	return out;
}

/** every token the resolver couldn't map — the audit trail for coverage */
export const droppedTokens = new Set();
