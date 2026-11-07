// StyleProps → StyleDesc — the native-first styling vocabulary.
// Same palette/spacing tables as tokens.js, but authored as typed props
// instead of classname strings: no parsing, no pseudo-pseudo handling.
//
//   style({ display:'flex', px:'lg', bg:'color-muted', hover:{ bg:'color-light' } },
//     { color:'primary' })
//
// `ctx.color` resolves the `color-*` placeholder refs (same as the token lane).

import {
	SPACING, CONTROL_H, ICON, FONT_SIZE, RADIUS, FONT_W, ALIGN, JUSTIFY,
	SHADOWS, CURSOR, COLOR_NAME_REF,
	resolveColorRef, registerTokenCacheClear, getRaisedWithBorder,
} from './tokens.js';
import { themeRev } from './revision.svelte.js';

const DIRECTION = { row: 'row', col: 'column', column: 'column', 'row-reverse': 'row-reverse', 'col-reverse': 'column-reverse', 'column-reverse': 'column-reverse' };
const WRAP = { wrap: 'wrap', nowrap: 'nowrap' };
const OVERFLOW = { auto: 'scroll' }; // gpuix has no 'auto' — scroll is the semantic
const PAD_DIR = { px: ['paddingLeft', 'paddingRight'], py: ['paddingTop', 'paddingBottom'], pt: ['paddingTop'], pr: ['paddingRight'], pb: ['paddingBottom'], pl: ['paddingLeft'], ps: ['paddingLeft'], pe: ['paddingRight'] };
const MAR_DIR = { mx: ['marginLeft', 'marginRight'], my: ['marginTop', 'marginBottom'], mt: ['marginTop'], mr: ['marginRight'], mb: ['marginBottom'], ml: ['marginLeft'], ms: ['marginLeft'], me: ['marginRight'] };

/** ring → an outset shadow member flagged `ring` so the native `raised-*`
 *  merge keeps it (svelai's --tw-ring-shadow composes ahead of --tw-shadow).
 *  Default color is currentColor — Tailwind v4's --tw-ring-color default;
 *  the native resolver maps it onto the element's resolved text color. */
const ringShadow = (w, color, inset) => ({
	offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: w,
	color: color ?? 'currentColor', ring: true, ...(inset ? { inset: true } : {}),
});
const BORD_SIDE = { borderT: 'borderTopWidth', borderR: 'borderRightWidth', borderB: 'borderBottomWidth', borderL: 'borderLeftWidth' };
// corner-radius vocab → the fields it writes (mirror of style_props::key_fields)
const RADIUS_DIR = {
	radiusTl: ['borderTopLeftRadius'], borderTopLeftRadius: ['borderTopLeftRadius'],
	radiusTr: ['borderTopRightRadius'], borderTopRightRadius: ['borderTopRightRadius'],
	radiusBl: ['borderBottomLeftRadius'], borderBottomLeftRadius: ['borderBottomLeftRadius'],
	radiusBr: ['borderBottomRightRadius'], borderBottomRightRadius: ['borderBottomRightRadius'],
	radiusT: ['borderTopLeftRadius', 'borderTopRightRadius'],
	radiusB: ['borderBottomLeftRadius', 'borderBottomRightRadius'],
	radiusL: ['borderTopLeftRadius', 'borderBottomLeftRadius'],
	radiusR: ['borderTopRightRadius', 'borderBottomRightRadius'],
};

/** every field a vocab key can write — `null` deletes them. Mirror of
 *  style_props::key_fields: theme-ladder levels ship as unmerged fragments,
 *  so this is the only unset channel on the stream. Field-level, not
 *  vocab-level (`{px}` + `{p:null}` clears px too — p owns all four). */
const KEY_FIELDS = {
	display: ['display'],
	flex: ['display', 'flexDirection'], row: ['display', 'flexDirection'],
	col: ['display', 'flexDirection'], column: ['display', 'flexDirection'],
	grid: ['display'],
	direction: ['flexDirection'], flexDirection: ['flexDirection'],
	wrap: ['flexWrap'], flexWrap: ['flexWrap'],
	grow: ['flexGrow'], flexGrow: ['flexGrow'], flex1: ['flexGrow', 'flexShrink'],
	shrink: ['flexShrink'], flexShrink: ['flexShrink'],
	basis: ['flexBasis'], flexBasis: ['flexBasis'],
	items: ['alignItems'], alignItems: ['alignItems'],
	self: ['alignSelf'], alignSelf: ['alignSelf'],
	justify: ['justifyContent'], justifyContent: ['justifyContent'],
	content: ['alignContent'], alignContent: ['alignContent'],
	gap: ['rowGap', 'columnGap'], rowGap: ['rowGap'], columnGap: ['columnGap'],
	gridCols: ['gridTemplateColumns'], gridTemplateColumns: ['gridTemplateColumns'],
	gridRows: ['gridTemplateRows'], gridTemplateRows: ['gridTemplateRows'],
	p: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
	padding: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
	m: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'],
	margin: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'],
	control: ['height'], icon: ['width', 'height'],
	w: ['width'], width: ['width'], h: ['height'], height: ['height'],
	minW: ['minWidth'], minWidth: ['minWidth'], minH: ['minHeight'], minHeight: ['minHeight'],
	maxW: ['maxWidth'], maxWidth: ['maxWidth'], maxH: ['maxHeight'], maxHeight: ['maxHeight'],
	aspect: ['aspectRatio'], aspectRatio: ['aspectRatio'],
	bg: ['backgroundColor'], backgroundColor: ['backgroundColor'], background: ['background'],
	fg: ['color'], color: ['color'],
	border: ['borderColor', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'],
	borderColor: ['borderColor'],
	borderW: ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'],
	borderWidth: ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'],
	borderT: ['borderTopWidth'], borderR: ['borderRightWidth'],
	borderB: ['borderBottomWidth'], borderL: ['borderLeftWidth'],
	// pad/mar longhands — same field lists the write path uses
	...Object.fromEntries(Object.entries(PAD_DIR)),
	...Object.fromEntries(Object.entries(MAR_DIR)),
	radius: ['borderRadius'], borderRadius: ['borderRadius'],
	radiusTl: ['borderTopLeftRadius'], borderTopLeftRadius: ['borderTopLeftRadius'],
	radiusTr: ['borderTopRightRadius'], borderTopRightRadius: ['borderTopRightRadius'],
	radiusBl: ['borderBottomLeftRadius'], borderBottomLeftRadius: ['borderBottomLeftRadius'],
	radiusBr: ['borderBottomRightRadius'], borderBottomRightRadius: ['borderBottomRightRadius'],
	radiusT: ['borderTopLeftRadius', 'borderTopRightRadius'],
	radiusB: ['borderBottomLeftRadius', 'borderBottomRightRadius'],
	radiusL: ['borderTopLeftRadius', 'borderBottomLeftRadius'],
	radiusR: ['borderTopRightRadius', 'borderBottomRightRadius'],
	shadow: ['boxShadow'], boxShadow: ['boxShadow'],
	opacity: ['opacity'],
	overflow: ['overflowX', 'overflowY'], overflowX: ['overflowX'], overflowY: ['overflowY'],
	visibility: ['visibility'],
	text: ['fontSize'], fontSize: ['fontSize'],
	fontW: ['fontWeight'], fontWeight: ['fontWeight'],
	font: ['fontFamily'], fontFamily: ['fontFamily'],
	align: ['textAlign'], textAlign: ['textAlign'],
	tracking: ['letterSpacing'], letterSpacing: ['letterSpacing'],
	lineHeight: ['lineHeight'],
	leading: ['lineHeightScale'], lineHeightScale: ['lineHeightScale'],
	fontFeatures: ['fontFeatures'],
	textTransform: ['textTransform'], case: ['textTransform'],
	whitespace: ['whiteSpace'], whiteSpace: ['whiteSpace'],
	ellipsis: ['whiteSpace', 'textOverflow', 'overflowX'], truncate: ['whiteSpace', 'textOverflow', 'overflowX'],
	lineClamp: ['lineClamp'],
	underline: ['textDecoration'], textDecoration: ['textDecoration'], lineThrough: ['textDecoration'],
	decoration: ['textDecorationColor'], textDecorationColor: ['textDecorationColor'],
	italic: ['fontStyle'], fontStyle: ['fontStyle'],
	absolute: ['position'], fixed: ['position'], position: ['position'],
	top: ['top'], right: ['right'], bottom: ['bottom'], left: ['left'],
	inset: ['top', 'right', 'bottom', 'left'],
	cursor: ['cursor'], select: ['userSelect'], userSelect: ['userSelect'],
	pointerEvents: ['pointerEvents'], selectionColor: ['selectionColor'],
	stateLayer: ['stateLayer'], raised: ['raised'], lift: ['lift'],
	hover: ['hover'], active: ['active'], focus: ['focus'],
	focusWithin: ['focusWithin'], focusVisible: ['focusVisible'],
};

// Token names cross the wire — the native resolver owns ×--spacing, named
// scales, and geometry prefixes, so a theme swap restyles without JS
// re-emitting values. JSON numbers stay raw px; STRING numerics ("4")
// follow the ×--spacing class-token convention.
const space = (v) =>
	typeof v === 'number' ? v
	: v === 'px' ? 1
	: typeof v === 'string' && (SPACING[v] != null || /^-?\d+(\.\d+)?$/.test(v)) ? v
	: undefined;
// native dims: numbers, numeric strings, 'N%', 'auto'/'fit'/'full', geometry names
const dim = (v) =>
	typeof v === 'number' ? v
	: v === 'fit' ? 'auto'
	: typeof v === 'string' && (
			/^(full|auto)$/.test(v) ||
			/^-?[\d.]+(%|px)?$/.test(v) ||
			SPACING[v] != null ||
			/^(control|row|icon|hit|indent)-(xs|sm|md|lg|xl)$/.test(v)
		) ? v
	: undefined;
// insets resolve against the spacing scale — token names and numerics pass through
const inset = (v) =>
	typeof v === 'number' ? v
	: typeof v === 'string' && (SPACING[v] != null || /^-?\d+(\.\d+)?$/.test(v) || /^indent-(sm|md|lg|xl)$/.test(v)) ? v
	: undefined;

/** unknown props are recorded, not silently dropped — same audit contract as tokens.js */
export const droppedProps = new Set();

/** literals (`#hex`, `rgb()`, …) always pass — the native parser owns them */
const isColorLiteral = (v) => typeof v === 'string' && /^(#.+|.+\(.*\))/.test(v);
/** color-ref gate — same contract as the class lane: palette resolve OR
 *  well-formed grammar (scoped-palette names + literals must cross; the
 *  native resolver owns them). `ctx.strict` — the definition sweep — exempts
 *  only literals, so bare names resolving under no palette surface as typos. */
const colorOk = (v, ctx) =>
	resolveColorRef(v, ctx) != null ||
	(typeof v === 'string' && (ctx?.strict ? isColorLiteral(v) : COLOR_NAME_REF.test(v)));

function applyProps(p, ctx, out, state, dropped = droppedProps) {
	for (const k in p) {
		const v = p[k];
		// null deletes the fields this key owns — the stream-level unset that
		// replaces mergeProps' delete now that ladder levels ship unmerged.
		// undefined/false stay skips (conditional-prop idiom).
		if (v === null) {
			if (k === 'ring') state.ringW = undefined;
			else if (k === 'ringColor') state.ringC = undefined;
			else if (k === 'ringInset') state.ringInset = undefined;
			else for (const f of KEY_FIELDS[k] ?? []) delete out[f];
			continue;
		}
		if (v === undefined || v === false) continue;
		// a pre-mapped field map joins the ordered stream — the class lane's
		// resolveTokens output rides along so `class` still wins over props
		if (k === '@desc' && typeof v === 'object' && !Array.isArray(v)) {
			for (const fk in v) {
				if (BUCKETS.includes(fk) && typeof v[fk] === 'object' && typeof out[fk] === 'object')
					out[fk] = { ...out[fk], ...v[fk] };
				else out[fk] = v[fk];
			}
			continue;
		}
		switch (k) {
			// layout
			case 'display': out.display = v; break;
			case 'flex': if (v) { out.display = 'flex'; out.flexDirection ??= 'row'; } break;
			case 'grid': if (v) out.display = 'grid'; break;
			case 'direction': case 'flexDirection': out.flexDirection = DIRECTION[v] ?? v; break;
			case 'row': if (v) { out.display = 'flex'; out.flexDirection = 'row'; } break;
			case 'col': case 'column': if (v) { out.display = 'flex'; out.flexDirection = 'column'; } break;
			case 'wrap': case 'flexWrap': {
				// a bare `wrap: true` is not a value — record, don't leak a
				// bool into the flexWrap String slot (fails the desc parse)
				const x = WRAP[v] ?? (typeof v === 'string' ? v : undefined);
				if (x !== undefined) out.flexWrap = x; else dropped.add('wrap:' + v);
				break;
			}
			case 'grow': case 'flexGrow': out.flexGrow = typeof v === 'number' ? v : 1; break;
			case 'flex1': if (v) { out.flexGrow = 1; out.flexShrink = 1; } break;
			case 'shrink': case 'flexShrink': out.flexShrink = typeof v === 'number' ? v : 1; break;
			case 'basis': case 'flexBasis': {
				// `N/M` fractions normalize to percent — a raw '1/2' reaches the
				// desc unclassified and fails `flex_basis: DimensionValue` wholesale
				const f = typeof v === 'string' && /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(v);
				const x = f ? (+f[2] !== 0 ? `${(+f[1] / +f[2]) * 100}%` : undefined) : dim(v);
				if (x !== undefined) out.flexBasis = x; else dropped.add('basis:' + v);
				break;
			}
			case 'items': case 'alignItems': out.alignItems = ALIGN[v] ?? v; break;
			case 'self': case 'alignSelf': out.alignSelf = ALIGN[v] ?? v; break;
			case 'justify': case 'justifyContent': out.justifyContent = JUSTIFY[v] ?? v; break;
			case 'content': case 'alignContent': out.alignContent = JUSTIFY[v] ?? v; break;
			case 'gap': { const x = space(v); if (x != null) { out.rowGap = x; out.columnGap = x; } else dropped.add('gap:' + v); break; }
			case 'rowGap': case 'columnGap': { const x = space(v); if (x != null) out[k] = x; else dropped.add(k + ':' + v); break; }
			case 'gridCols': case 'gridTemplateColumns': { if (typeof v === 'number') out.gridTemplateColumns = v; else dropped.add(k + ':' + v); break; }
			case 'gridRows': case 'gridTemplateRows': { if (typeof v === 'number') out.gridTemplateRows = v; else dropped.add(k + ':' + v); break; }
			// spacing — shorthands expand to longhands in authored order, so a
			// later longhand wins over an earlier shorthand (and the reverse).
			// The native resolver does the same expansion; `padding`/`margin`
			// field names stay for the raw `setStyle` desc lane only.
			case 'p': case 'padding': { const x = space(v); if (x != null) { out.paddingTop = out.paddingRight = out.paddingBottom = out.paddingLeft = x; } else dropped.add('p:' + v); break; }
			case 'm': case 'margin': { const x = space(v); if (x != null) { out.marginTop = out.marginRight = out.marginBottom = out.marginLeft = x; } else dropped.add('m:' + v); break; }
			default: {
				if (PAD_DIR[k] || MAR_DIR[k]) {
					const x = space(v);
					const dir = PAD_DIR[k] ?? MAR_DIR[k];
					if (x != null) for (const d of dir) out[d] = x;
					break;
				}
				// sizing
				if (k === 'control') { const x = typeof v === 'number' ? v : CONTROL_H[v] != null ? 'control-' + v : undefined; if (x !== undefined) out.height = x; else dropped.add('control:' + v); break; }
				if (k === 'icon') { const x = typeof v === 'number' ? v : ICON[v] != null ? 'icon-' + v : undefined; if (x !== undefined) { out.width = x; out.height = x; } else dropped.add('icon:' + v); break; }
				if (k === 'w' || k === 'width' || k === 'h' || k === 'height' ||
					k === 'minW' || k === 'minWidth' || k === 'minH' || k === 'minHeight' ||
					k === 'maxW' || k === 'maxWidth' || k === 'maxH' || k === 'maxHeight') {
					const key = { w: 'width', h: 'height', minW: 'minWidth', minH: 'minHeight', maxW: 'maxWidth', maxH: 'maxHeight' }[k] ?? k;
					const x = dim(v);
					if (x !== undefined) out[key] = x; else dropped.add(k + ':' + v);
					break;
				}
				if (k === 'aspect' || k === 'aspectRatio') {
					// number or 'W/H' — svelai's aspect-square is aspect:1
					const x = typeof v === 'number' ? v
						: typeof v === 'string' && /^\d+(\.\d+)?\/\d+(\.\d+)?$/.test(v)
							? v.split('/').reduce((a, b) => +a / +b)
							: undefined;
					if (x !== undefined && x > 0) out.aspectRatio = x; else dropped.add('aspect:' + v);
					break;
				}
				// box
				// color refs cross verbatim — the native resolver owns the
				// palette grammar incl. ctx `color-*`; resolveColorRef stays
				// as the validity gate for the dropped audit.
				if (k === 'bg' || k === 'backgroundColor') { if (colorOk(v, ctx)) out.backgroundColor = v; else dropped.add('bg:' + v); break; }
				if (k === 'background') { out.background = v; break; } // gradients pass through
				if (k === 'fg' || k === 'color') { if (colorOk(v, ctx)) out.color = v; else dropped.add('fg:' + v); break; }
				if (k === 'border' || k === 'borderColor') {
					if (k === 'border' && (v === true || v === 1)) {
						out.borderTopWidth = out.borderRightWidth = out.borderBottomWidth = out.borderLeftWidth = 1;
						break;
					}
					if (colorOk(v, ctx)) out.borderColor = v; else dropped.add('border:' + v);
					break;
				}
				if (k === 'borderW' || k === 'borderWidth') {
					const w = v === true ? 1 : v;
					out.borderTopWidth = out.borderRightWidth = out.borderBottomWidth = out.borderLeftWidth = w;
					break;
				}
				if (BORD_SIDE[k]) { out[BORD_SIDE[k]] = v === true ? 1 : v; break; }
				if (k === 'radius' || k === 'borderRadius') { const x = typeof v === 'number' ? v : RADIUS[v] != null ? v : undefined; if (x !== undefined) out.borderRadius = x; else dropped.add('radius:' + v); break; }
				if (RADIUS_DIR[k]) { const x = typeof v === 'number' ? v : RADIUS[v] != null ? v : undefined; if (x !== undefined) for (const f of RADIUS_DIR[k]) out[f] = x; else dropped.add(k + ':' + v); break; }
				if (k === 'ring' || k === 'ringColor' || k === 'ringInset') {
					if (k === 'ring') state.ringW = v === true ? 1 : v;
					else if (k === 'ringInset') { if (v) state.ringInset = true; }
					else { if (colorOk(v, ctx)) state.ringC = v; else dropped.add('ringColor:' + v); }
					break;
				}
				if (k === 'shadow' || k === 'boxShadow') { const x = typeof v === 'object' ? v : SHADOWS[v]; if (x !== undefined) out.boxShadow = x; else dropped.add('shadow:' + v); break; }
				if (k === 'opacity') { out.opacity = v; break; }
				if (k === 'overflow') { out.overflowX = out.overflowY = OVERFLOW[v] ?? v; break; }
				if (k === 'overflowX' || k === 'overflowY') { out[k] = OVERFLOW[v] ?? v; break; }
				if (k === 'visibility') { out.visibility = v; break; }
				// text
				if (k === 'text' || k === 'fontSize') { const x = typeof v === 'number' ? v : FONT_SIZE[v] != null ? v : undefined; if (x !== undefined) out.fontSize = x; else dropped.add('text:' + v); break; }
				if (k === 'fontW' || k === 'fontWeight') { const x = typeof v === 'number' ? v : FONT_W[v] != null ? v : undefined; if (x !== undefined) out.fontWeight = x; else dropped.add('fontW:' + v); break; }
				if (k === 'font' || k === 'fontFamily') { out.fontFamily = v; break; }
				if (k === 'align' || k === 'textAlign') { out.textAlign = v; break; }
				// letter-spacing rides gpui-fork TextStyle.letter_spacing →
				// kCTKernAttributeName at shape time. px numbers only — the
				// named tracking scale resolves to px upstream in tokens.js.
				if (k === 'tracking' || k === 'letterSpacing') { if (typeof v === 'number') out.letterSpacing = v; else dropped.add('tracking:' + v); break; }
				if (k === 'lineHeight') { out.lineHeight = v; break; }
				if (k === 'leading' || k === 'lineHeightScale') { if (typeof v === 'number') out.lineHeightScale = v; else dropped.add('leading:' + v); break; }
				if (k === 'fontFeatures') { if (v && typeof v === 'object') out.fontFeatures = v; else dropped.add('fontFeatures:' + v); break; }
				if (k === 'textTransform' || k === 'case') {
					if (v === 'uppercase' || v === 'lowercase' || v === 'capitalize' || v === 'none') out.textTransform = v;
					else dropped.add('case:' + v);
					break;
				}
				if (k === 'whitespace' || k === 'whiteSpace') { out.whiteSpace = v; break; }
				if (k === 'ellipsis' || k === 'truncate') { if (v) { out.whiteSpace = 'nowrap'; out.textOverflow = 'ellipsis'; out.overflowX = 'hidden'; } break; }
				if (k === 'lineClamp') { out.lineClamp = v; break; }
				if (k === 'underline' || k === 'textDecoration') {
					out.textDecoration = v === true ? 'underline' : v; // underline|line-through|none
					break;
				}
				if (k === 'lineThrough') { if (v) out.textDecoration = 'line-through'; break; }
				if (k === 'decoration' || k === 'textDecorationColor') {
					if (colorOk(v, ctx)) out.textDecorationColor = v; else dropped.add('decoration:' + v);
					break;
				}
				if (k === 'italic' || k === 'fontStyle') {
					out.fontStyle = v === true ? 'italic' : v === false ? 'normal' : v;
					break;
				}
				// position
				if (k === 'absolute' || k === 'fixed') { if (v) out.position = k; break; }
				if (k === 'position') { out.position = v; break; }
				if (k === 'top' || k === 'right' || k === 'bottom' || k === 'left') { const x = inset(v); if (x !== undefined) out[k] = x; else dropped.add(k + ':' + v); break; }
				if (k === 'inset') { const x = inset(v); if (x !== undefined) { out.top = out.right = out.bottom = out.left = x; } else dropped.add('inset:' + v); break; }
				// behavior
				if (k === 'cursor') { out.cursor = CURSOR[v] ?? v; break; }
				if (k === 'select' || k === 'userSelect') { out.userSelect = v === 'none' ? 'none' : v === true ? 'none' : v; break; }
				if (k === 'pointerEvents') { out.pointerEvents = v; break; }
				if (k === 'selectionColor') { out.selectionColor = v; break; }
				// interaction — `stateLayer` is a flag on the wire; the native
				// resolver bakes the currentColor overlay (or paints it for x-*)
				if (k === 'stateLayer') { if (v) out.stateLayer = true; break; }
				if (k === 'raised' || k === 'lift') { out[k] = v === true ? '' : v; break; }
				// pseudo buckets — focus/focusWithin/focusVisible have native
				// refinement channels; a non-object value is malformed, drop it.
				if (k === 'hover' || k === 'active' || k === 'focus' || k === 'focusWithin' || k === 'focusVisible') {
					if (typeof v !== 'object' || Array.isArray(v)) { dropped.add(k + ' (bucket)'); break; }
					const sub = { ringW: undefined, ringC: undefined, ringInset: undefined };
					const bucket = (out[k] ??= {});
					applyProps(v, ctx, bucket, sub, dropped);
					if (sub.ringW != null)
						bucket.boxShadow = ringShadow(sub.ringW, sub.ringC ?? state.ringC ?? out.borderColor, sub.ringInset);
					break;
				}
				dropped.add(k);
			}
		}
	}
}

// ── the native envelope ─────────────────────────────────────────────────
// `style()` no longer maps props to fields in JS — it returns a tagged envelope
// carrying the *raw* StyleProps fragments plus an optional recipe binding.
// `applyNativeStyle` (gdom) emits them as `setStyleProps`/`setRecipe` ops and
// Rust's `style_props`/`recipe` engines map + resolve natively. A plain
// desc-shaped object (no `__native`) still takes the `setStyle` lane.

export const isNativeStyle = (v) => v != null && v.__native === true;

/** Stamps the spreadable `style` view on a native envelope — `<div
 *  {...card.style}>` spreads `{ styleProps: env }` and the gdom `styleProps`
 *  prop routes the envelope into applyNativeStyle, same lane as
 *  `use:applyStyle`. Non-enumerable so env spreads (the `__ctx` re-stamp
 *  above, mergeProps' `__`-skip walk, JSON) never copy a self-reference —
 *  the fresh wrapper per access is harmless: dedup keys on env identity. */
export const spreadable = (env) => {
	Object.defineProperty(env, 'style', { get: () => ({ styleProps: env }) });
	return env;
};

/** Every native envelope is itself a Svelte attachment — `{@attach card}`
 *  applies it through the element's `styleProps` prop (the gdom lane) and
 *  clears on teardown/re-run. The callable carries the `__native` fields as
 *  own props, so one value serves all three lanes: `{@attach env}`,
 *  `{...env.style}`, and `use:applyStyle={env}` — plus mergeStyleDesc
 *  composition, which reads fields not callability. */
export const envify = (fields) => {
	const env = (el) => {
		el.styleProps = env;
		return () => {
			el.styleProps = null;
		};
	};
	Object.assign(env, fields);
	return spreadable(env);
};

/** StyleProps (or an ordered fragment array, or a recipe envelope) → the
 *  native envelope. `ctx.color` rides as `__ctx` — applyNativeStyle turns it
 *  into the `color` custom prop (svelai's data-color bridge). */
export function style(props, ctx = {}) {
	void themeRev.v; // subscribe: theme swaps re-resolve every mounted style
	if (isNativeStyle(props)) {
		return ctx?.color && props.__ctx !== ctx.color
			? envify({ ...props, __ctx: ctx.color })
			: props;
	}
	const frags = [];
	let binding = null;
	// Sanitize the stream — a non-object member would serialize to `null` and
	// fail the wire's shape check, dropping the WHOLE batch it rides in.
	for (const f of Array.isArray(props) ? props : [props]) {
		if (f == null || f === false || f === true) continue;
		if (isNativeStyle(f)) {
			if (f.__recipe) {
				if (binding) reportIssues('style()', [`recipe '${f.__recipe.name}' dropped — one binding per element`]);
				else binding = f.__recipe;
			}
			frags.push(...f.__frags);
		} else if (typeof f === 'object' && !Array.isArray(f)) frags.push(f);
		else reportIssues('style()', [`non-style fragment dropped (${typeof f})`]);
	}
	return envify({
		__native: true,
		__frags: frags,
		__recipe: binding,
		__ctx: ctx?.color ?? null,
	});
}

/** `s` — kept as the shorthand alias; `style` is the canonical name. */
export { style as s };

/** JS mirror of the native mapping — StyleProps → symbolic field map.
 *  The production path never calls this; it exists for the definition-time
 *  validator (checkStyleProps), probes, and the JS↔Rust drift check. It must
 *  stay field-identical to `style_props::resolve_style_props`: stream-level
 *  ring scope, ordered expansion, null deletes, fragment order wins. */
export function resolveStyleProps(props, ctx = {}) {
	if (props == null) return {};
	let out = {};
	// the ring accumulator spans the stream — `ring`/`ringColor` split across
	// ladder levels recombine like the old merged-props path.
	const state = { ringW: undefined, ringC: undefined, ringInset: undefined };
	const frags = Array.isArray(props) ? props : [props];
	for (const frag of frags) {
		if (frag == null || frag === false || typeof frag !== 'object') continue;
		applyProps(frag, ctx, out, state);
	}
	if (state.ringW != null)
		out.boxShadow = ringShadow(state.ringW, state.ringC ?? out.borderColor, state.ringInset);
	// svelai's `data-color` bridge — the resolved color ctx crosses as the
	// `color` custom prop so the subtree's `color-*` refs see it natively.
	if (ctx?.color) out.ctxColor = ctx.color;
	// designTokens.raisedWithBorder: elevated (shadowed) surfaces get the
	// hairline — the border color stays a token so it resolves theme-aware.
	// Post-expansion a border declaration lives on the four side fields.
	const bordered =
		out.borderWidth != null || out.borderColor != null ||
		out.borderTopWidth != null || out.borderRightWidth != null ||
		out.borderBottomWidth != null || out.borderLeftWidth != null;
	if (out.boxShadow && getRaisedWithBorder() && !bordered) {
		out.borderWidth = 1;
		out.borderColor = 'neutral-muted';
	}
	return out;
}

const BUCKETS = ['hover', 'active', 'focus', 'focusWithin', 'focusVisible'];

/** merge two styles — plain descs merge field-wise (pseudo buckets
 *  key-wise, base last-wins); a native envelope concatenates its ordered
 *  fragment stream, and a plain desc joins it as a `@desc` fragment so a
 *  `class`-lane override still lands on top. */
export function mergeStyleDesc(a, b) {
	if (isNativeStyle(a) || isNativeStyle(b)) {
		const frags = [];
		for (const side of [a, b]) {
			if (side == null) continue;
			if (isNativeStyle(side)) frags.push(...side.__frags);
			else frags.push({ '@desc': side });
		}
		if (isNativeStyle(a) && a.__recipe && isNativeStyle(b) && b.__recipe)
			reportIssues('mergeStyleDesc', [`recipe '${a.__recipe.name}' overridden by '${b.__recipe.name}' — one binding per element`]);
		return envify({
			__native: true,
			__frags: frags,
			__recipe: (isNativeStyle(b) && b.__recipe) || (isNativeStyle(a) && a.__recipe) || null,
			__ctx: (isNativeStyle(b) ? b.__ctx : null) ?? (isNativeStyle(a) ? a.__ctx : null) ?? null,
		});
	}
	if (!a) return b ?? {};
	if (!b) return a;
	const out = { ...a, ...b };
	for (const k of BUCKETS) if (a[k] || b[k]) out[k] = { ...a[k], ...b[k] };
	return out;
}

/** merge StyleProps — nested pseudo buckets merge key-wise, everything else last-wins.
 *  `__`-prefixed keys are envelope metadata and never merge. */
export function mergeProps(into, src) {
	if (!src || typeof src !== 'object') return into;
	for (const k in src) {
		if (k.startsWith('__')) continue;
		const v = src[k];
		if (v === null) { delete into[k]; continue; } // null unsets a base prop
		if (v === undefined) continue;
		// deep-merge only style-prop dicts — atomic objects (shadow etc.) replace
		if ((BUCKETS.includes(k) || k === 'style') && typeof v === 'object' && !Array.isArray(v))
			into[k] = mergeProps(typeof into[k] === 'object' && into[k] != null ? into[k] : {}, v);
		else into[k] = v;
	}
	return into;
}

// ── definition-time validation — the StyleX-shaped layer. Fragments are
// checked when they're DEFINED (typo'd keys, malformed values, non-object
// buckets) instead of landing in the runtime audit only. Color refs gate on
// grammar here; palette membership is re-checked by validateDefinitions()
// after themes register custom names. ──

/** run the prop walk — grammar-tier gate (lenient colors) — returns drops */
export function checkStyleProps(props) {
	if (props == null) return [];
	const dropped = new Set();
	applyProps(props, {}, {}, { ringW: undefined, ringC: undefined, ringInset: undefined }, dropped);
	return [...dropped];
}

/** {label, key, lane} — everything definition-time checks have flagged.
 *  lane 'props' issues are always bugs (closed vocabulary); lane 'class'
 *  includes intentional boundary drops (data-/peer-/arbitrary pseudos). */
export const definitionIssues = [];
const seenIssues = new Set();
const defRegistry = []; // {label, props} — re-checked against the live palette

export function reportIssues(label, keys, { lane = 'props', loud = lane === 'props' } = {}) {
	for (const k of keys) {
		const id = label + ' → ' + k;
		if (seenIssues.has(id)) continue;
		seenIssues.add(id);
		definitionIssues.push({ label, key: k, lane });
		if (loud) console.error(`[nkit] dropped style prop '${k}' in ${label}`);
	}
}

/** register a fragment for the palette sweep; returns grammar-tier drops */
export function registerStyleDef(label, props) {
	if (props == null) return [];
	const issues = checkStyleProps(props);
	defRegistry.push({ label, props });
	return issues;
}

/** palette-tier re-check — runs after every theme/palette swap (registered
 *  via registerTokenCacheClear). Reports refs that are grammatically fine but
 *  resolve under no registered palette. */
export function validateDefinitions() {
	for (const { label, props } of defRegistry) {
		const dropped = new Set();
		applyProps(props, { strict: true }, {}, { ringW: undefined, ringC: undefined, ringInset: undefined }, dropped);
		reportIssues(label, [...dropped]);
	}
}
registerTokenCacheClear(validateDefinitions);

export function deepFreeze(v) {
	if (v == null || typeof v !== 'object') return v;
	for (const k in v) deepFreeze(v[k]);
	return Object.freeze(v);
}

/** stylex.create() — a named map of validated, frozen StyleProps fragments.
 *  Consume with style(fragment, ctx) / mergeProps. Issues surface at definition,
 *  not at first render. */
export function defineStyles(map, label = 'styles') {
	for (const name in map) {
		const fragLabel = `${label}.${name}`;
		reportIssues(fragLabel, registerStyleDef(fragLabel, map[name]));
		deepFreeze(map[name]);
	}
	return Object.freeze(map);
}
