// StyleProps → StyleDesc — the native-first styling vocabulary.
// Same palette/spacing tables as tokens.js, but authored as typed props
// instead of classname strings: no parsing, no pseudo-pseudo handling.
//
//   s({ display:'flex', px:'lg', bg:'color-muted', hover:{ bg:'color-light' } },
//     { color:'primary' })
//
// `ctx.color` resolves the `color-*` placeholder refs (same as the token lane).

import {
	PALETTE, SPACING, CONTROL_H, ICON, FONT_SIZE, RADIUS, FONT_W, ALIGN, JUSTIFY,
	SHADOWS, TRACK, CURSOR, STATE_HOVER, STATE_PRESSED,
	resolveColorRef, overlay, registerTokenCacheClear, getRaisedWithBorder,
} from './tokens.js';
import { themeRev } from './revision.svelte.js';

const DIRECTION = { row: 'row', col: 'column', column: 'column', 'row-reverse': 'row-reverse', 'col-reverse': 'column-reverse', 'column-reverse': 'column-reverse' };
const WRAP = { wrap: 'wrap', nowrap: 'nowrap' };
const OVERFLOW = { auto: 'scroll' }; // gpuix has no 'auto' — scroll is the semantic
const PAD_DIR = { px: ['paddingLeft', 'paddingRight'], py: ['paddingTop', 'paddingBottom'], pt: ['paddingTop'], pr: ['paddingRight'], pb: ['paddingBottom'], pl: ['paddingLeft'], ps: ['paddingLeft'], pe: ['paddingRight'] };
const MAR_DIR = { mx: ['marginLeft', 'marginRight'], my: ['marginTop', 'marginBottom'], mt: ['marginTop'], mr: ['marginRight'], mb: ['marginBottom'], ml: ['marginLeft'] };
const BORD_SIDE = { borderT: 'borderTopWidth', borderR: 'borderRightWidth', borderB: 'borderBottomWidth', borderL: 'borderLeftWidth' };

const space = (v) => (typeof v === 'number' ? v : SPACING[v]);
// native dims: numbers, numeric strings, 'N%', 'auto'. 'fit' → 'auto' (gpuix has no fit-content)
const dim = (v) =>
	v === 'full' ? '100%'
	: v === 'fit' || v === 'auto' ? 'auto'
	: typeof v === 'number' ? v
	: typeof v === 'string' && /^-?[\d.]+(%|px)?$/.test(v) ? v
	: undefined;
// insets are f64-only on the native side — no %, no strings
const inset = (v) => (typeof v === 'number' ? v : typeof v === 'string' && SPACING[v] != null ? SPACING[v] : undefined);

/** unknown props are recorded, not silently dropped — same audit contract as tokens.js */
export const droppedProps = new Set();

function applyProps(p, ctx, out, state) {
	for (const k in p) {
		const v = p[k];
		if (v == null || v === false) continue;
		switch (k) {
			// layout
			case 'display': out.display = v; break;
			case 'flex': if (v) { out.display = 'flex'; out.flexDirection ??= 'row'; } break;
			case 'grid': if (v) out.display = 'grid'; break;
			case 'direction': case 'flexDirection': out.flexDirection = DIRECTION[v] ?? v; break;
			case 'row': if (v) { out.display = 'flex'; out.flexDirection = 'row'; } break;
			case 'col': case 'column': if (v) { out.display = 'flex'; out.flexDirection = 'column'; } break;
			case 'wrap': case 'flexWrap': out.flexWrap = WRAP[v] ?? v; break;
			case 'grow': case 'flexGrow': out.flexGrow = typeof v === 'number' ? v : 1; break;
			case 'flex1': if (v) { out.flexGrow = 1; out.flexShrink = 1; } break;
			case 'shrink': case 'flexShrink': out.flexShrink = typeof v === 'number' ? v : 1; break;
			case 'basis': case 'flexBasis': out.flexBasis = v; break;
			case 'items': case 'alignItems': out.alignItems = ALIGN[v] ?? v; break;
			case 'self': case 'alignSelf': out.alignSelf = ALIGN[v] ?? v; break;
			case 'justify': case 'justifyContent': out.justifyContent = JUSTIFY[v] ?? v; break;
			case 'content': case 'alignContent': out.alignContent = JUSTIFY[v] ?? v; break;
			case 'gap': { const x = space(v); if (x != null) { out.rowGap = x; out.columnGap = x; } else droppedProps.add('gap:' + v); break; }
			case 'rowGap': case 'columnGap': { const x = space(v); if (x != null) out[k] = x; else droppedProps.add(k + ':' + v); break; }
			case 'gridCols': case 'gridTemplateColumns': { if (typeof v === 'number') out.gridTemplateColumns = v; else droppedProps.add(k + ':' + v); break; }
			case 'gridRows': case 'gridTemplateRows': { if (typeof v === 'number') out.gridTemplateRows = v; else droppedProps.add(k + ':' + v); break; }
			// spacing
			case 'p': case 'padding': { const x = space(v); if (x != null) out.padding = x; break; }
			case 'm': case 'margin': { const x = space(v); if (x != null) out.margin = x; break; }
			default: {
				if (PAD_DIR[k] || MAR_DIR[k]) {
					const x = space(v);
					const dir = PAD_DIR[k] ?? MAR_DIR[k];
					if (x != null) for (const d of dir) out[d] = x;
					break;
				}
				// sizing
				if (k === 'control') { const x = CONTROL_H[v] ?? (typeof v === 'number' ? v : undefined); if (x !== undefined) out.height = x; else droppedProps.add('control:' + v); break; }
				if (k === 'icon') { const x = ICON[v] ?? (typeof v === 'number' ? v : undefined); if (x !== undefined) { out.width = x; out.height = x; } else droppedProps.add('icon:' + v); break; }
				if (k === 'w' || k === 'width' || k === 'h' || k === 'height' ||
					k === 'minW' || k === 'minWidth' || k === 'minH' || k === 'minHeight' ||
					k === 'maxW' || k === 'maxWidth' || k === 'maxH' || k === 'maxHeight') {
					const key = { w: 'width', h: 'height', minW: 'minWidth', minH: 'minHeight', maxW: 'maxWidth', maxH: 'maxHeight' }[k] ?? k;
					const x = dim(v);
					if (x !== undefined) out[key] = x; else droppedProps.add(k + ':' + v);
					break;
				}
				if (k === 'aspect') { droppedProps.add('aspect (no aspectRatio in StyleDesc)'); break; }
				// box
				if (k === 'bg' || k === 'backgroundColor') { const c = resolveColorRef(v, ctx); if (c != null) out.backgroundColor = c; else droppedProps.add('bg:' + v); break; }
				if (k === 'background') { out.background = v; break; } // gradients pass through
				if (k === 'fg' || k === 'color') { const c = resolveColorRef(v, ctx); if (c != null) out.color = c; else droppedProps.add('fg:' + v); break; }
				if (k === 'border' || k === 'borderColor') {
					if (k === 'border' && (v === true || v === 1)) { out.borderWidth = 1; break; }
					const c = resolveColorRef(v, ctx); if (c != null) out.borderColor = c; else droppedProps.add('border:' + v);
					break;
				}
				if (k === 'borderW' || k === 'borderWidth') { out.borderWidth = v === true ? 1 : v; break; }
				if (BORD_SIDE[k]) { out[BORD_SIDE[k]] = v === true ? 1 : v; break; }
				if (k === 'radius' || k === 'borderRadius') { const x = typeof v === 'number' ? v : RADIUS[v]; if (x !== undefined) out.borderRadius = x; else droppedProps.add('radius:' + v); break; }
				if (k === 'ring' || k === 'ringColor') { if (k === 'ring') state.ringW = v === true ? 1 : v; else { const c = resolveColorRef(v, ctx); if (c != null) state.ringC = c; else droppedProps.add('ringColor:' + v); } break; }
				if (k === 'shadow' || k === 'boxShadow') { const x = typeof v === 'object' ? v : SHADOWS[v]; if (x !== undefined) out.boxShadow = x; else droppedProps.add('shadow:' + v); break; }
				if (k === 'opacity') { out.opacity = v; break; }
				if (k === 'overflow' || k === 'overflowX' || k === 'overflowY') { out[k] = OVERFLOW[v] ?? v; break; }
				if (k === 'visibility') { out.visibility = v; break; }
				// text
				if (k === 'text' || k === 'fontSize') { const x = typeof v === 'number' ? v : FONT_SIZE[v]; if (x !== undefined) out.fontSize = x; else droppedProps.add('text:' + v); break; }
				if (k === 'fontW' || k === 'fontWeight') { const x = FONT_W[v] ?? (typeof v === 'number' ? v : undefined); if (x !== undefined) out.fontWeight = x; else droppedProps.add('fontW:' + v); break; }
				if (k === 'font' || k === 'fontFamily') { out.fontFamily = v; break; }
				if (k === 'align' || k === 'textAlign') { out.textAlign = v; break; }
				if (k === 'tracking' || k === 'letterSpacing') { const x = typeof v === 'number' ? v : TRACK[v]; if (x !== undefined) out.letterSpacing = x; else droppedProps.add('tracking:' + v); break; }
				if (k === 'lineHeight') { out.lineHeight = v; break; }
				if (k === 'whitespace' || k === 'whiteSpace') { out.whiteSpace = v; break; }
				if (k === 'ellipsis' || k === 'truncate') { if (v) { out.whiteSpace = 'nowrap'; out.textOverflow = 'ellipsis'; out.overflowX = 'hidden'; } break; }
				if (k === 'lineClamp') { out.lineClamp = v; break; }
				if (k === 'underline') { if (v) droppedProps.add('underline (no textDecoration)'); break; }
				// position
				if (k === 'absolute' || k === 'fixed') { if (v) out.position = k; break; }
				if (k === 'position') { out.position = v; break; }
				if (k === 'top' || k === 'right' || k === 'bottom' || k === 'left') { const x = inset(v); if (x !== undefined) out[k] = x; else droppedProps.add(k + ':' + v); break; }
				if (k === 'inset') { const x = inset(v); if (x !== undefined) { out.top = out.right = out.bottom = out.left = x; } else droppedProps.add('inset:' + v); break; }
				// behavior
				if (k === 'cursor') { out.cursor = CURSOR[v] ?? v; break; }
				if (k === 'select' || k === 'userSelect') { out.userSelect = v === 'none' ? 'none' : v === true ? 'none' : v; break; }
				if (k === 'pointerEvents') { out.pointerEvents = v; break; }
				if (k === 'selectionColor') { out.selectionColor = v; break; }
				// interaction
				if (k === 'stateLayer') { state.stateLayer = true; break; }
				if (k === 'hover' || k === 'active') {
					const sub = { ringW: undefined, ringC: undefined, stateLayer: false };
					const bucket = (out[k] ??= {});
					applyProps(v, ctx, bucket, sub);
					if (sub.ringW != null)
						bucket.boxShadow = { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: sub.ringW, color: sub.ringC ?? state.ringC ?? out.borderColor ?? PALETTE.neutral.muted };
					if (sub.stateLayer) {
						const fgc = typeof bucket.color === 'string' ? bucket.color : typeof out.color === 'string' ? out.color : PALETTE.neutral.readable;
						bucket.backgroundColor ??= overlay(bucket.backgroundColor ?? out.backgroundColor, fgc, k === 'hover' ? STATE_HOVER : STATE_PRESSED);
					}
					break;
				}
				droppedProps.add(k);
			}
		}
	}
}

/** deterministic on (props identity via cache key) — recipes are static, cache by JSON */
const sCache = new Map();
registerTokenCacheClear(() => sCache.clear());

/** StyleProps → StyleDesc. ctx: { color } for `color-*` placeholder refs. */
export function s(props, ctx = {}) {
	void themeRev.v; // subscribe: theme swaps re-resolve every mounted style
	if (props == null) return {};
	const key = (ctx.color ?? '') + '|' + stableKey(props);
	const hit = sCache.get(key);
	if (hit) return hit;
	const out = {};
	const state = { ringW: undefined, ringC: undefined, stateLayer: false };
	applyProps(props, ctx, out, state);
	if (state.ringW != null)
		out.boxShadow = { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: state.ringW, color: state.ringC ?? out.borderColor ?? PALETTE.neutral.muted };
	if (state.stateLayer) {
		const fg = typeof out.color === 'string' ? out.color : PALETTE.neutral.readable;
		(out.hover ??= {}).backgroundColor ??= overlay(out.backgroundColor, fg, STATE_HOVER);
		(out.active ??= {}).backgroundColor ??= overlay(out.backgroundColor, fg, STATE_PRESSED);
	}
	// designTokens.raisedWithBorder: elevated (shadowed) surfaces get the hairline
	if (out.boxShadow && getRaisedWithBorder() && out.borderWidth == null && out.borderColor == null) {
		out.borderWidth = 1;
		out.borderColor = PALETTE.neutral.muted;
	}
	if (sCache.size > 4000) sCache.clear(); // bounded — rect-derived styles churn keys
	sCache.set(key, out);
	return out;
}

function stableKey(v, acc = '') {
	if (v == null || typeof v !== 'object') return String(v);
	const keys = Object.keys(v).sort();
	let out = '{';
	for (const k of keys) out += k + ':' + stableKey(v[k]) + ',';
	return out + '}';
}

/** merge two resolved StyleDescs — hover/active merge key-wise, base last-wins */
export function mergeStyleDesc(a, b) {
	if (!a) return b ?? {};
	if (!b) return a;
	const out = { ...a, ...b };
	if (a.hover || b.hover) out.hover = { ...a.hover, ...b.hover };
	if (a.active || b.active) out.active = { ...a.active, ...b.active };
	return out;
}

/** merge StyleProps — nested hover/active merge key-wise, everything else last-wins */
export function mergeProps(into, src) {
	if (!src) return into;
	for (const k in src) {
		const v = src[k];
		if (v === null) { delete into[k]; continue; } // null unsets a base prop
		if (v === undefined) continue;
		// deep-merge only style-prop dicts — atomic objects (shadow etc.) replace
		if ((k === 'hover' || k === 'active' || k === 'focus' || k === 'style') && typeof v === 'object' && !Array.isArray(v))
			into[k] = mergeProps(typeof into[k] === 'object' && into[k] != null ? into[k] : {}, v);
		else into[k] = v;
	}
	return into;
}
