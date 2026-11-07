/**
 * QuickGUI backend: interprets the same op stream the gpuix renderer consumes
 * and applies it through @quickgui/native's retained-tree API (native-tree.ts).
 *
 * Op vocabulary (emitted by gdom.ts):
 *   createElement(id, tag)   setText(id, s)        setStyle(id, {camel: v})
 *   setCustomProp(id, k, v)  setEventListener(id, type, true)
 *   appendChild(pid, cid)    insertBefore(pid, cid, beforeId)
 *   moveBefore(pid, cid, beforeId|null) — reparent/reorder a live subtree
 *   destroyElement(id)       setRoot(id)
 *
 * Headless: RecordingHost implements the NativeNodeHost contract in pure JS —
 * no dylib, no window. Live: the real `Window` object is the host; its `root`
 * NativeNode is passed in and ops materialize against the Rust core.
 */
import {
	NativeNode,
	NativeNodeTag,
	PropertyCode,
	insertNativeNode,
	removeNativeNode,
	replaceNativeText,
	setNativeEventListener,
	setNativeProperty,
	parseColor,
	type NativeEventType,
	type QuickGuiEvent,
} from '@quickgui/native';
import { dispatchPayload } from '@svelte-desktop/gpuix/gdom';
import { resolveStyleProps } from '@svelte-desktop/gpuix/gen/nkit/style.js';
import {
	resolveColorRef,
	getSpacingUnit,
	getDefaultColor,
	SPACING,
	CONTROL_H,
	ROW_H,
	ICON,
	HIT,
	INDENT,
	FONT_SIZE,
	FONT_W,
	RADIUS,
	ELEVATION,
	getRaisedWithBorder,
} from '@svelte-desktop/gpuix/gen/nkit/tokens.js';

// ── Tag mapping: our element tags → NativeNodeTag ─────────────────────────
// gdom already maps unknown html tags to 'div'; quickgui's vocabulary is a
// closed set, so anything unrecognized falls back to View.
const QG_TAG: Record<string, NativeNodeTag> = {
	div: NativeNodeTag.View,
	text: NativeNodeTag.View,
	button: NativeNodeTag.Button,
	input: NativeNodeTag.Input,
	textarea: NativeNodeTag.Input,
	markdown: NativeNodeTag.Markdown,
	'virtual-list': NativeNodeTag.VirtualList,
	svg: NativeNodeTag.Svg,
	img: NativeNodeTag.Image,
	image: NativeNodeTag.Image,
};

// ── Event mapping: our internal (gpuix-flavoured) names → quickgui types ──
// Notable: gpuix 'change' fires per-edit; quickgui's per-edit event is 'input'.
const QG_EVENT: Record<string, NativeEventType> = {
	click: 'click',
	mouseDown: 'mousedown',
	mouseUp: 'mouseup',
	mouseMove: 'mousemove',
	mouseEnter: 'mouseenter',
	mouseLeave: 'mouseleave',
	keyDown: 'keydown',
	keyUp: 'keyup',
	focus: 'focus',
	blur: 'blur',
	change: 'input',
	submit: 'submit',
	scroll: 'wheel',
};

// PropertyCode members are PascalCase versions of the camelCase names.
function propCode(name: string): PropertyCode | undefined {
	const pascal = name[0].toUpperCase() + name.slice(1);
	const code = (PropertyCode as Record<string, number>)[pascal];
	return code === undefined ? undefined : (code as PropertyCode);
}

// Codes whose values must be packed colors (mirrors solid's colorProperties set).
const COLOR_CODES = new Set<number>([
	PropertyCode.BackgroundColor,
	PropertyCode.Color,
	PropertyCode.BorderColor,
	PropertyCode.OutlineColor,
	PropertyCode.TextDecorationColor,
	PropertyCode.HoverBackgroundColor,
	PropertyCode.HoverColor,
	PropertyCode.ActiveBackgroundColor,
	PropertyCode.ActiveColor,
	PropertyCode.FocusBackgroundColor,
	PropertyCode.FocusColor,
	PropertyCode.TerminalCursorColor,
	PropertyCode.MarkdownBorderColor,
	PropertyCode.MarkdownMutedColor,
	PropertyCode.MarkdownLinkColor,
	PropertyCode.MarkdownCodeTextColor,
]);

/** css value → NativePropertyValue (mirrors their normalizeValue/normalizeLength). */
function normalizeProp(code: PropertyCode, value: unknown): boolean | number | string | null {
	if (value === null || value === undefined) return null;
	if (COLOR_CODES.has(code)) {
		if (typeof value === 'number') return parseColor(value);
		return resolveColor(String(value)); // named → hex → binding parser
	}
	if (typeof value === 'number' || typeof value === 'boolean') return value;
	const s = String(value).trim();
	if (s.endsWith('px')) {
		const n = Number(s.slice(0, -2));
		return Number.isFinite(n) ? n : null;
	}
	if (s === '0') return 0;
	const n = Number(s);
	return Number.isFinite(n) && s !== '' ? n : s;
}

// ── Stylesheet mirror (JS sibling of native/src/stylesheet.rs) ──────────────
// Component *.styles.js sidecars emit 'stylesheet.register' with parsed
// NativeStyleRule[] — the QG sink is a JS host, so the rules are resolved
// here instead of in Rust. Same contract: compounds joined by combinator
// markers (`comb`), attribute selectors (`attr`, prop names already
// native-mapped JS-side), `:not(compound)`, the five state pseudo-classes.
// Cascade by (spec, order), decls applied field-by-field, inline styles win.
//
// Pseudo states: a `state` comp is routing, not a predicate (stylesheet.rs
// Rule.state). Rules carrying one are resolved like base rules and their
// decls pack into the core's StateStyleDeclaration JSON, which the Rust core
// swaps in natively on state flips — no interaction-state plumbing needed
// on the sink. Transportable: hover/active/focus/focusWithin via the
// HoverStyle/ActiveStyle/FocusStyle/FocusWithinStyle codes. Transport-
// blocked: focusVisible — @quickgui/native 0.1.5 has no code for it (the
// core has DISABLED/INVALID/DRAGGING/DRAG_OVER/SELECTED style codes but no
// focus-visible), so those decls drop the same way a malformed decl does.
type PseudoStateName = 'hover' | 'active' | 'focus' | 'focusWithin' | 'focusVisible';
const PSEUDO_STATES = new Set<string>([
	'hover',
	'active',
	'focus',
	'focusWithin',
	'focusVisible',
]);
const STATE_STYLE_CODE: Partial<Record<PseudoStateName, PropertyCode>> = {
	hover: PropertyCode.HoverStyle,
	active: PropertyCode.ActiveStyle,
	focus: PropertyCode.FocusStyle,
	focusWithin: PropertyCode.FocusWithinStyle,
};

const COMB_KINDS = new Set([' ', '>', '+', '~']);

interface SelCompWire {
	k: string;
	v?: string;
	op?: string;
	x?: unknown;
	sel?: SelCompWire[];
}
interface SheetRuleWire {
	sel?: SelCompWire[];
	decls?: string;
	spec?: number[];
	order?: number;
}
interface SheetRule {
	sel: SelCompWire[]; // full selector incl. `comb` markers — the match predicate
	decls: [string, string][];
	spec: [number, number, number];
	order: number;
	state: PseudoStateName | null;
	/** any combinator — matching then walks parents/siblings, not just the node */
	hasComb: boolean;
	/** attr names the rule tests — a setCustomProp on one is a match input */
	attrNames: Set<string>;
}

const kebab = (k: string) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** CSS decl text → [camelKey, value][] — the JS port of stylesheet.rs
 *  parse_decls' first pass: `!important` strips (it carries no weight — no
 *  higher layer exists for it to beat), `--*` custom props are collected as
 *  var() sources and never emitted, and a later decl of the same property
 *  overwrites an earlier one. */
const parseDecls = (css: string): [string, string][] => {
	const raw = new Map<string, string>();
	for (const decl of css.split(';')) {
		const i = decl.indexOf(':');
		if (i === -1) continue;
		const name = decl.slice(0, i).trim();
		let value = decl.slice(i + 1).trim();
		if (value.slice(-10).toLowerCase() === '!important') {
			value = value.slice(0, -10).trimEnd();
		}
		if (!name || !value) continue;
		raw.set(name.startsWith('--') ? name : kebab(name), value);
	}
	const out: [string, string][] = [];
	for (const [key, value] of raw) {
		if (key.startsWith('--')) continue;
		out.push([key, resolveVars(value, raw).trim()]);
	}
	return out;
};

/** `var(--name)` / `var(--name, fallback)` resolve against the rule's own
 *  `--*` decls — the same depth-capped substitution as Rust's resolve_vars.
 *  An unknown name with no fallback survives verbatim so the unsafe-value
 *  drop still sees it. */
function resolveVars(value: string, props: Map<string, string>, depth = 0): string {
	if (depth > 4) return value;
	let out = '';
	let rest = value;
	for (;;) {
		const at = rest.indexOf('var(');
		if (at === -1) return out + rest;
		out += rest.slice(0, at);
		const inner = rest.slice(at + 4);
		const close = inner.indexOf(')');
		if (close === -1) return out + rest; // unterminated — verbatim, unsafe drop sees it
		const body = inner.slice(0, close).trim();
		const comma = body.indexOf(',');
		const name = (comma === -1 ? body : body.slice(0, comma)).trim();
		const fallback = comma === -1 ? undefined : body.slice(comma + 1).trim();
		if (name.startsWith('--')) {
			const own = props.get(name);
			out += own !== undefined ? resolveVars(own, props, depth + 1) : (fallback ?? rest.slice(at, at + 4 + close + 1));
		} else {
			out += rest.slice(at, at + 4 + close + 1);
		}
		rest = rest.slice(at + 4 + close + 1);
	}
}
const cmpSpec = (a: [number, number, number], b: [number, number, number]) =>
	a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** `:not()` args must be a combinator-free compound without state or
 *  nested `not` — the same bound Rust's parse_comp(in_not=true) enforces. */
function parseNotCompound(sel: SelCompWire[] | undefined): SelCompWire[] | null {
	const out: SelCompWire[] = [];
	for (const c of sel ?? []) {
		if (c.k === 'comb' || c.k === 'state' || c.k === 'not') return null;
		if ((c.k === 'tag' || c.k === 'class' || c.k === 'id' || c.k === 'attr') && c.v === undefined)
			return null;
		if (c.k !== 'tag' && c.k !== 'class' && c.k !== 'id' && c.k !== 'attr' && c.k !== 'universal')
			return null;
		out.push(c);
	}
	return out.length ? out : null;
}

/** RuleWire[] → parsed rules, dropping what Rust's Rule::from_wire drops:
 *  unknown comp kinds, a `state` comp with an unknown name, more than one
 *  `state` comp, a `state` comp outside the subject compound, or malformed
 *  combinator placement. Decls pre-parse here like `fields` does at
 *  register. */
function parseSheetRules(wire: SheetRuleWire[] | undefined): SheetRule[] {
	const rules: SheetRule[] = [];
	for (const r of wire ?? []) {
		const sel: SelCompWire[] = [];
		let state: PseudoStateName | null = null;
		let stateIdx = -1;
		let lastCombIdx = -1;
		const attrNames = new Set<string>();
		let drop = false;
		const comps = r.sel ?? [];
		for (let i = 0; i < comps.length; i++) {
			const c = comps[i]!;
			if (c.k === 'state') {
				if (state !== null || !PSEUDO_STATES.has(c.v ?? '')) {
					drop = true;
					break;
				}
				state = c.v as PseudoStateName;
				stateIdx = sel.length;
				sel.push(c);
				continue;
			}
			if (c.k === 'comb') {
				const prev = sel[sel.length - 1];
				if (!c.v || !COMB_KINDS.has(c.v) || !prev || prev.k === 'comb') {
					drop = true;
					break;
				}
				lastCombIdx = sel.length;
				sel.push(c);
				continue;
			}
			if (c.k === 'not') {
				const inner = parseNotCompound(c.sel);
				if (!inner) {
					drop = true;
					break;
				}
				for (const ic of inner) if (ic.k === 'attr' && ic.v) attrNames.add(ic.v);
				sel.push(c);
				continue;
			}
			if (c.k === 'tag' || c.k === 'class' || c.k === 'id' || c.k === 'attr') {
				if (c.v === undefined) {
					drop = true;
					break;
				}
				if (c.k === 'attr') attrNames.add(c.v);
			} else if (c.k !== 'universal') {
				drop = true;
				break;
			}
			sel.push(c);
		}
		// a state comp before the last combinator routes into an ANCESTOR's
		// bucket — unsupported, the rule drops like Rust's from_wire.
		if (
			drop ||
			sel.length === 0 ||
			sel[sel.length - 1]!.k === 'comb' ||
			(stateIdx >= 0 && stateIdx < lastCombIdx)
		)
			continue;
		rules.push({
			sel,
			decls: parseDecls(r.decls ?? ''),
			spec: [r.spec?.[0] ?? 0, r.spec?.[1] ?? 0, r.spec?.[2] ?? 0],
			order: r.order ?? 0,
			state,
			hasComb: lastCombIdx >= 0,
			attrNames,
		});
	}
	return rules;
}

const tryColor = (v: string): number | null => {
	try {
		return parseColor(v);
	} catch {
		return null;
	}
};
/** CSS box-shadow text → the core's NativeBoxShadow[] encoding, or null when
 *  no layer parses (a malformed decl drops instead of shadow_none-ing). */
function parseBoxShadows(value: string): Record<string, unknown>[] | null {
	const trimmed = value.trim();
	if (trimmed === 'none') return [];
	// comma-split is paren-aware — rgba()/hsla() colors carry commas
	const layers: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of trimmed) {
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		if (ch === ',' && depth === 0) {
			layers.push(current);
			current = '';
		} else current += ch;
	}
	layers.push(current);
	const shadows: Record<string, unknown>[] = [];
	for (const layer of layers) {
		const m = /^\s*(inset\s+)?(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?(?:\s+([\d.]+)(?:px)?)?(?:\s+(-?[\d.]+)(?:px)?)?\s*(.*)$/.exec(
			layer,
		);
		if (!m) continue;
		const shadow: Record<string, unknown> = {
			offsetX: Number(m[2]),
			offsetY: Number(m[3]),
			blurRadius: Number(m[4] ?? 0),
			spreadRadius: Number(m[5] ?? 0),
			inset: !!m[1],
		};
		const colorText = (m[6] ?? '').trim();
		if (colorText) {
			const packed = resolveColor(colorText);
			if (packed !== null) shadow.color = packed;
		}
		shadows.push(shadow);
	}
	return shadows.length ? shadows : null;
}

/** One decl of a state rule → StateStyleDeclaration fields (0–2 entries;
 *  `border` expands like the base shorthand). Keys the core has no field
 *  for — layout props, fonts — drop the way an unparseable value does. */
function stateDeclEntries(key: string, value: string): [string, unknown][] {
	switch (key) {
		case 'backgroundColor': {
			const packed = resolveColor(value);
			return packed === null ? [] : [['backgroundColor', packed]];
		}
		case 'background': {
			// A solid fill travels as backgroundColor; a gradient goes
			// verbatim — the core's parse_gradient owns the grammar.
			const packed = resolveColor(value);
			if (packed !== null) return [['backgroundColor', packed]];
			return /-gradient\s*\(/.test(value) ? [['background', value]] : [];
		}
		case 'color': {
			const packed = resolveColor(value);
			return packed === null ? [] : [['color', packed]];
		}
		case 'borderColor': {
			const packed = resolveColor(value);
			return packed === null ? [] : [['borderColor', packed]];
		}
		case 'borderWidth': {
			const n = toNumber(value);
			return n === null ? [] : [['borderWidth', n]];
		}
		case 'borderRadius': {
			const n = toNumber(value);
			return n === null ? [] : [['borderRadius', n]];
		}
		case 'border': {
			const m = /^(\S+)\s+(?:solid|dashed|dotted|double)\s*(.*)$/.exec(value.trim());
			if (!m) return [];
			const out: [string, unknown][] = [];
			const width = toNumber(m[1]!);
			if (width !== null) out.push(['borderWidth', width]);
			const packed = m[2] ? resolveColor(m[2]) : null;
			if (packed !== null) out.push(['borderColor', packed]);
			return out;
		}
		case 'outline':
			return [['outline', value]];
		case 'boxShadow': {
			const shadows = parseBoxShadows(value);
			return shadows === null ? [] : [['boxShadow', shadows]];
		}
		case 'opacity': {
			const n = toNumber(value);
			return n === null ? [] : [['opacity', n]];
		}
		case 'cursor':
			return [['cursor', value]];
		case 'transform':
			return [['transform', value]];
		case 'transformOrigin':
			return [['transformOrigin', value]];
		default:
			return [];
	}
}

// ── Base-decl expansion: stylesheet.rs parse_decls → PropertyCode pairs ────
// The Rust registry expands shorthands, resolves var(), evaluates calc() and
// drops what its field types can't hold; the mirror does the same work one
// level down, where a decl becomes (code, value) pairs instead of symbolic
// fields. What has no code or type on this side drops exactly like Rust's
// unrepresentable fields.

/** Whitespace split that keeps functional values whole — `calc(0.25rem * 2)`
 *  is one component, `10px 16px` is two. */
function splitCssComponents(value: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		else if (/\s/.test(ch) && depth === 0) {
			if (start < i) parts.push(value.slice(start, i));
			start = i + 1;
		}
	}
	if (start < value.length) parts.push(value.slice(start));
	return parts;
}

/** `-?digits[.digits][unit]` → [numberText, unit] like split_dimension. */
function splitDimension(value: string): [string, string] | null {
	const m = /^(-?[\d.]*\d)([a-z%]*)$/.exec(value);
	return m === null ? null : [m[1]!, m[2]!];
}

/** css dimension → px number | "N%" | "auto" | null. em/rem scale to px,
 *  viewport units degrade to % (no viewport measure on this side either). */
function toDimension(value: string): number | string | null {
	if (value === 'auto') return 'auto';
	const dim = splitDimension(value);
	if (dim === null) return null;
	const n = Number(dim[0]);
	if (!Number.isFinite(n)) return null;
	switch (dim[1]) {
		case '':
		case 'px':
			return n;
		case '%':
			return `${n}%`;
		case 'rem':
		case 'em':
			return n * 16;
		case 'vh':
		case 'vw':
		case 'svh':
		case 'svw':
		case 'lvh':
		case 'lvw':
		case 'dvh':
		case 'dvw':
			return `${n}%`;
		default:
			return null;
	}
}

/** Numeric-only dimension: calc() evaluates first, plain dimensions follow.
 *  `%` results are not numbers. */
function toNumber(value: string): number | null {
	const parsed = value.startsWith('calc(') ? evalCalc(value) : toDimension(value);
	return typeof parsed === 'number' ? parsed : null;
}

function tokenizeCalc(s: string): string[] | null {
	const tokens: string[] = [];
	let i = 0;
	while (i < s.length) {
		const c = s[i]!;
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		// `-` is a sign only when a digit (or .digit) follows; otherwise it's
		// the binary operator — same read as the Rust tokenizer.
		const negativeNumber = c === '-' && /[\d.]/.test(s[i + 1] ?? '');
		if (negativeNumber || /[\d.]/.test(c)) {
			const start = i;
			if (c === '-') i++;
			while (i < s.length && /[\d.]/.test(s[i]!)) i++;
			while (i < s.length && /[a-z%]/.test(s[i]!)) i++;
			tokens.push(s.slice(start, i));
			continue;
		}
		if ('()+-*/'.includes(c)) {
			tokens.push(c);
			i++;
			continue;
		}
		return null;
	}
	return tokens;
}

type CalcValue = { n: number; unit: string };
function calcFactor(tokens: string[], pos: { i: number }): CalcValue | null {
	const token = tokens[pos.i];
	if (token === '(') {
		pos.i++;
		const value = calcExpr(tokens, pos);
		if (tokens[pos.i] !== ')') return null;
		pos.i++;
		return value;
	}
	pos.i++;
	if (token === undefined) return null;
	const dim = splitDimension(token);
	if (dim === null) return null;
	const n = Number(dim[0]);
	if (!Number.isFinite(n)) return null;
	switch (dim[1]) {
		case '':
		case 'px':
			return { n, unit: 'px' };
		case 'rem':
		case 'em':
			return { n: n * 16, unit: 'px' };
		case '%':
		case 'vh':
		case 'vw':
		case 'svh':
		case 'svw':
		case 'lvh':
		case 'lvw':
		case 'dvh':
		case 'dvw':
			return { n, unit: '%' };
		default:
			return null;
	}
}
function calcTerm(tokens: string[], pos: { i: number }): CalcValue | null {
	let value = calcFactor(tokens, pos);
	if (value === null) return null;
	while (tokens[pos.i] === '*' || tokens[pos.i] === '/') {
		const op = tokens[pos.i]!;
		pos.i++;
		const rhs = calcFactor(tokens, pos);
		if (rhs === null) return null;
		if (rhs.unit !== '' && value.unit !== '' && rhs.unit !== value.unit) return null;
		const unit = value.unit === '' ? rhs.unit : value.unit;
		value = { n: op === '*' ? value.n * rhs.n : value.n / rhs.n, unit };
	}
	return value;
}
function calcExpr(tokens: string[], pos: { i: number }): CalcValue | null {
	let value = calcTerm(tokens, pos);
	if (value === null) return null;
	while (tokens[pos.i] === '+' || tokens[pos.i] === '-') {
		const op = tokens[pos.i]!;
		pos.i++;
		const rhs = calcTerm(tokens, pos);
		if (rhs === null || rhs.unit !== value.unit) return null;
		value = { n: op === '+' ? value.n + rhs.n : value.n - rhs.n, unit: value.unit };
	}
	return value;
}
/** calc() → px number | "N%" | null — same grammar as Rust's eval_calc. */
function evalCalc(expr: string): number | string | null {
	const inner = /^calc\((.*)\)$/s.exec(expr.trim())?.[1]?.trim();
	if (inner === undefined) return null;
	const tokens = tokenizeCalc(inner);
	if (tokens === null) return null;
	const pos = { i: 0 };
	const value = calcExpr(tokens, pos);
	if (value === null || pos.i !== tokens.length) return null;
	return value.unit === '%' ? `${value.n}%` : value.n;
}

/** Values the native side cannot represent — same needle list as Rust's
 *  unsafe_value (a survivor `var(` lands here when it had no source). */
const UNSAFE_NEEDLES = [
	'var(',
	'url(',
	'clamp(',
	'attr(',
	'env(',
	'color-mix(',
	'gradient(',
	'conic(',
	'min(',
	'max(',
	'mix(',
	'oklch from',
	'calc(',
];
const unsafeValue = (value: string) => UNSAFE_NEEDLES.some((n) => value.includes(n));
const CSS_WIDE = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);

/** The named-color table — the binding's parseColor takes hex/rgb()/the
 *  three built-in keywords only, so names normalize to hex here the way
 *  csscolorparser does on the Rust side. */
const NAMED_COLORS: Record<string, string> = {
	aliceblue: '#f0f8ff', antiquewhite: '#faebd7', aqua: '#00ffff', aquamarine: '#7fffd4',
	azure: '#f0ffff', beige: '#f5f5dc', bisque: '#ffe4c4', black: '#000000',
	blanchedalmond: '#ffebcd', blue: '#0000ff', blueviolet: '#8a2be2', brown: '#a52a2a',
	burlywood: '#deb887', cadetblue: '#5f9ea0', chartreuse: '#7fff00', chocolate: '#d2691e',
	coral: '#ff7f50', cornflowerblue: '#6495ed', cornsilk: '#fff8dc', crimson: '#dc143c',
	cyan: '#00ffff', darkblue: '#00008b', darkcyan: '#008b8b', darkgoldenrod: '#b8860b',
	darkgray: '#a9a9a9', darkgreen: '#006400', darkgrey: '#a9a9a9', darkkhaki: '#bdb76b',
	darkmagenta: '#8b008b', darkolivegreen: '#556b2f', darkorange: '#ff8c00', darkorchid: '#9932cc',
	darkred: '#8b0000', darksalmon: '#e9967a', darkseagreen: '#8fbc8f', darkslateblue: '#483d8b',
	darkslategray: '#2f4f4f', darkslategrey: '#2f4f4f', darkturquoise: '#00ced1', darkviolet: '#9400d3',
	deeppink: '#ff1493', deepskyblue: '#00bfff', dimgray: '#696969', dimgrey: '#696969',
	dodgerblue: '#1e90ff', firebrick: '#b22222', floralwhite: '#fffaf0', forestgreen: '#228b22',
	fuchsia: '#ff00ff', gainsboro: '#dcdcdc', ghostwhite: '#f8f8ff', gold: '#ffd700',
	goldenrod: '#daa520', gray: '#808080', green: '#008000', greenyellow: '#adff2f',
	grey: '#808080', honeydew: '#f0fff0', hotpink: '#ff69b4', indianred: '#cd5c5c',
	indigo: '#4b0082', ivory: '#fffff0', khaki: '#f0e68c', lavender: '#e6e6fa',
	lavenderblush: '#fff0f5', lawngreen: '#7cfc00', lemonchiffon: '#fffacd', lightblue: '#add8e6',
	lightcoral: '#f08080', lightcyan: '#e0ffff', lightgoldenrodyellow: '#fafad2', lightgray: '#d3d3d3',
	lightgreen: '#90ee90', lightgrey: '#d3d3d3', lightpink: '#ffb6c1', lightsalmon: '#ffa07a',
	lightseagreen: '#20b2aa', lightskyblue: '#87cefa', lightslategray: '#778899', lightslategrey: '#778899',
	lightsteelblue: '#b0c4de', lightyellow: '#ffffe0', lime: '#00ff00', limegreen: '#32cd32',
	linen: '#faf0e6', magenta: '#ff00ff', maroon: '#800000', mediumaquamarine: '#66cdaa',
	mediumblue: '#0000cd', mediumorchid: '#ba55d3', mediumpurple: '#9370db', mediumseagreen: '#3cb371',
	mediumslateblue: '#7b68ee', mediumspringgreen: '#00fa9a', mediumturquoise: '#48d1cc', mediumvioletred: '#c71585',
	midnightblue: '#191970', mintcream: '#f5fffa', mistyrose: '#ffe4e1', moccasin: '#ffe4b5',
	navajowhite: '#ffdead', navy: '#000080', oldlace: '#fdf5e6', olive: '#808000',
	olivedrab: '#6b8e23', orange: '#ffa500', orangered: '#ff4500', orchid: '#da70d6',
	palegoldenrod: '#eee8aa', palegreen: '#98fb98', paleturquoise: '#afeeee', palevioletred: '#db7093',
	papayawhip: '#ffefd5', peachpuff: '#ffdab9', peru: '#cd853f', pink: '#ffc0cb',
	plum: '#dda0dd', powderblue: '#b0e0e6', purple: '#800080', rebeccapurple: '#663399',
	red: '#ff0000', rosybrown: '#bc8f8f', royalblue: '#4169e1', saddlebrown: '#8b4513',
	salmon: '#fa8072', sandybrown: '#f4a460', seagreen: '#2e8b57', seashell: '#fff5ee',
	sienna: '#a0522d', silver: '#c0c0c0', skyblue: '#87ceeb', slateblue: '#6a5acd',
	slategray: '#708090', slategrey: '#708090', snow: '#fffafa', springgreen: '#00ff7f',
	steelblue: '#4682b4', tan: '#d2b48c', teal: '#008080', thistle: '#d8bfd8',
	tomato: '#ff6347', turquoise: '#40e0d0', violet: '#ee82ee', wheat: '#f5deb3',
	white: '#ffffff', whitesmoke: '#f5f5f5', yellow: '#ffff00', yellowgreen: '#9acd32',
};

/** Named color → hex, else the binding's parser (hex/rgb()/keywords), else
 *  null. `currentColor` and palette tokens have no element context on this
 *  side — they drop the way an unparseable color does. */
function resolveColor(value: string): number | null {
	const named = NAMED_COLORS[value.trim().toLowerCase()];
	return tryColor(named ?? value);
}

/** 1–4-value box shorthands → per-side codes, like Rust's box_longhands. */
const BOX_LONGHANDS: Record<string, [PropertyCode, PropertyCode, PropertyCode, PropertyCode]> = {
	padding: [PropertyCode.PaddingTop, PropertyCode.PaddingRight, PropertyCode.PaddingBottom, PropertyCode.PaddingLeft],
	margin: [PropertyCode.MarginTop, PropertyCode.MarginRight, PropertyCode.MarginBottom, PropertyCode.MarginLeft],
	inset: [PropertyCode.Top, PropertyCode.Right, PropertyCode.Bottom, PropertyCode.Left],
	borderWidth: [
		PropertyCode.BorderTopWidth,
		PropertyCode.BorderRightWidth,
		PropertyCode.BorderBottomWidth,
		PropertyCode.BorderLeftWidth,
	],
	borderRadius: [
		PropertyCode.BorderTopLeftRadius,
		PropertyCode.BorderTopRightRadius,
		PropertyCode.BorderBottomRightRadius,
		PropertyCode.BorderBottomLeftRadius,
	],
};

/** css logical props → physical codes (only the pairs that have codes here —
 *  logical border *colors* don't, and Rust's per-part to_number keeps them
 *  dead anyway). */
const LOGICAL_FIELDS: Record<string, PropertyCode[]> = {
	insetBlock: [PropertyCode.Top, PropertyCode.Bottom],
	insetBlockStart: [PropertyCode.Top],
	insetBlockEnd: [PropertyCode.Bottom],
	insetInline: [PropertyCode.Left, PropertyCode.Right],
	insetInlineStart: [PropertyCode.Left],
	insetInlineEnd: [PropertyCode.Right],
	paddingBlock: [PropertyCode.PaddingTop, PropertyCode.PaddingBottom],
	paddingInline: [PropertyCode.PaddingLeft, PropertyCode.PaddingRight],
	marginBlock: [PropertyCode.MarginTop, PropertyCode.MarginBottom],
	marginInline: [PropertyCode.MarginLeft, PropertyCode.MarginRight],
	borderBlockWidth: [PropertyCode.BorderTopWidth, PropertyCode.BorderBottomWidth],
	borderInlineWidth: [PropertyCode.BorderLeftWidth, PropertyCode.BorderRightWidth],
	borderStartStartRadius: [PropertyCode.BorderTopLeftRadius],
	borderStartEndRadius: [PropertyCode.BorderTopRightRadius],
	borderEndStartRadius: [PropertyCode.BorderBottomLeftRadius],
	borderEndEndRadius: [PropertyCode.BorderBottomRightRadius],
};

/** Codes that must carry a bare number — a `%`/`auto`/keyword value drops
 *  rather than writing the wrong type (Rust's number_field). */
const NUMBER_CODES = new Set<number>([
	PropertyCode.FontSize,
	PropertyCode.LineHeight,
	PropertyCode.Opacity,
	PropertyCode.FlexGrow,
	PropertyCode.FlexShrink,
	PropertyCode.Gap,
	PropertyCode.RowGap,
	PropertyCode.ColumnGap,
	PropertyCode.Padding,
	PropertyCode.PaddingTop,
	PropertyCode.PaddingRight,
	PropertyCode.PaddingBottom,
	PropertyCode.PaddingLeft,
	PropertyCode.Margin,
	PropertyCode.MarginTop,
	PropertyCode.MarginRight,
	PropertyCode.MarginBottom,
	PropertyCode.MarginLeft,
	PropertyCode.Top,
	PropertyCode.Right,
	PropertyCode.Bottom,
	PropertyCode.Left,
	PropertyCode.BorderWidth,
	PropertyCode.BorderTopWidth,
	PropertyCode.BorderRightWidth,
	PropertyCode.BorderBottomWidth,
	PropertyCode.BorderLeftWidth,
	PropertyCode.BorderStartWidth,
	PropertyCode.BorderEndWidth,
	PropertyCode.BorderRadius,
	PropertyCode.BorderTopLeftRadius,
	PropertyCode.BorderTopRightRadius,
	PropertyCode.BorderBottomRightRadius,
	PropertyCode.BorderBottomLeftRadius,
	PropertyCode.OutlineWidth,
	PropertyCode.LineClamp,
	PropertyCode.GridTemplateColumns,
	PropertyCode.GridTemplateRows,
	PropertyCode.LetterSpacing,
	PropertyCode.WordSpacing,
	PropertyCode.TextDecorationThickness,
]);

/** DimensionValue codes: number | `N%` | `auto` (Rust's dimension_field). */
const DIMENSION_CODES = new Set<number>([
	PropertyCode.Width,
	PropertyCode.Height,
	PropertyCode.MinWidth,
	PropertyCode.MinHeight,
	PropertyCode.MaxWidth,
	PropertyCode.MaxHeight,
	PropertyCode.FlexBasis,
]);

/** `border`/`outline` shorthand → width + color codes. Like Rust's parse the
 *  whole shorthand needs all three components (`2px solid` alone emits
 *  nothing); the style keyword is consumed — `border-style` arrives as its
 *  own decl. `outline:` expands the same way because this protocol has no
 *  verbatim Outline code, only the three fields. */
function borderShorthand(
	value: string,
	widthCode: PropertyCode,
	colorCode: PropertyCode,
): [PropertyCode, number | string][] {
	const m = /^(\S+)\s+(solid|dashed|dotted|double)\s+(.+)$/.exec(value.trim());
	if (!m) return [];
	const out: [PropertyCode, number | string][] = [];
	const width = toNumber(m[1]!);
	if (width !== null) out.push([widthCode, width]);
	const packed = resolveColor(m[3]!.trim());
	if (packed !== null) out.push([colorCode, packed]);
	return out;
}

/** `text-decoration: underline dotted red` → line + style + color codes. */
function textDecorationShorthand(value: string): [PropertyCode, number | string][] {
	const out: [PropertyCode, number | string][] = [];
	for (const part of splitCssComponents(value)) {
		if (part === 'none' || part === 'underline' || part === 'overline' || part === 'line-through') {
			out.push([PropertyCode.TextDecorationLine, part]);
		} else if (['solid', 'dashed', 'dotted', 'double', 'wavy'].includes(part)) {
			out.push([PropertyCode.TextDecorationStyle, part]);
		} else {
			const packed = resolveColor(part);
			if (packed !== null) out.push([PropertyCode.TextDecorationColor, packed]);
		}
	}
	return out;
}

/** One base decl → (code, value) pairs — the expansion work Rust's
 *  parse_decls does per key, targeted at the codes this protocol has. */
function expandDecl(key: string, value: string): [PropertyCode, boolean | number | string][] {
	const box = BOX_LONGHANDS[key];
	if (box) {
		const parts = splitCssComponents(value);
		if (parts.length < 1 || parts.length > 4) return [];
		const values = [parts[0]!, parts[1] ?? parts[0]!, parts[2] ?? parts[0]!, parts[3] ?? parts[1] ?? parts[0]!];
		const nums = values.map(toNumber);
		// Rust: every component must convert or the whole shorthand drops.
		if (nums.some((n) => n === null)) return [];
		return box.map((code, i) => [code, nums[i]!]);
	}
	switch (key) {
		case 'gap': {
			const parts = splitCssComponents(value);
			const out: [PropertyCode, number][] = [];
			const row = toNumber(parts[0] ?? '');
			if (row !== null) out.push([PropertyCode.RowGap, row]);
			const column = toNumber(parts[1] ?? parts[0] ?? '');
			if (column !== null) out.push([PropertyCode.ColumnGap, column]);
			return out;
		}
		case 'flex': {
			const parts = splitCssComponents(value);
			if (parts[0] === 'none') {
				return [
					[PropertyCode.FlexGrow, 0],
					[PropertyCode.FlexShrink, 0],
				];
			}
			if (parts[0] === 'auto') {
				return [
					[PropertyCode.FlexGrow, 1],
					[PropertyCode.FlexShrink, 1],
				];
			}
			const grow = Number(parts[0]);
			if (!Number.isFinite(grow)) return [];
			const shrink = parts[1] !== undefined && Number.isFinite(Number(parts[1])) ? Number(parts[1]) : 1;
			const out: [PropertyCode, number | string][] = [
				[PropertyCode.FlexGrow, grow],
				[PropertyCode.FlexShrink, shrink],
			];
			if (parts[2] !== undefined) {
				const basis = toNumber(parts[2]);
				if (basis !== null) out.push([PropertyCode.FlexBasis, basis]);
			}
			return out;
		}
		case 'overflow': {
			const parts = splitCssComponents(value);
			const out: [PropertyCode, string][] = [];
			for (const [code, component] of [
				[PropertyCode.OverflowX, parts[0]],
				[PropertyCode.OverflowY, parts[1] ?? parts[0]],
			] as [PropertyCode, string | undefined][]) {
				if (component !== undefined) {
					out.push([code, component === 'auto' ? 'scroll' : component]);
				}
			}
			return out;
		}
		case 'overflowX':
		case 'overflowY': {
			const code = propCode(key)!;
			return [[code, value === 'auto' ? 'scroll' : value]];
		}
		case 'border':
			return borderShorthand(value, PropertyCode.BorderWidth, PropertyCode.BorderColor);
		case 'outline':
			return borderShorthand(value, PropertyCode.OutlineWidth, PropertyCode.OutlineColor);
		case 'gridTemplateColumns':
		case 'gridTemplateRows': {
			const code = propCode(key)!;
			const repeat = /^repeat\(\s*(\d+)/.exec(value);
			const count = repeat ? Number(repeat[1]) : toNumber(value);
			return count !== null && count > 0 ? [[code, count]] : [];
		}
		case 'boxShadow':
			// The property code carries the CSS text — the core parses layers
			// itself (a scalar channel, unlike the *Style JSON struct).
			return [[PropertyCode.BoxShadow, value]];
		case 'textShadow':
			return [[PropertyCode.TextShadow, value]];
		case 'background': {
			const packed = resolveColor(value);
			return packed === null ? [] : [[PropertyCode.BackgroundColor, packed]];
		}
		case 'fontFamily': {
			const first = value.split(',')[0]?.trim().replace(/^['"]+|['"]+$/g, '');
			return first ? [[PropertyCode.FontFamily, first]] : [];
		}
		case 'letterSpacing':
		case 'wordSpacing': {
			const code = propCode(key)!;
			const n = toNumber(value);
			return n === null ? [] : [[code, n]];
		}
		case 'aspectRatio': {
			const [a, b] = value.split('/');
			const ratio =
				b !== undefined
					? Number(a) / Number(b)
					: toNumber(value);
			return Number.isFinite(ratio) && ratio > 0 ? [[PropertyCode.AspectRatio, ratio]] : [];
		}
		case 'textDecoration':
			return textDecorationShorthand(value);
		default:
			break;
	}
	const logical = LOGICAL_FIELDS[key];
	if (logical) {
		const parts = splitCssComponents(value);
		const first = parts[0] ?? value;
		const second = parts[1] ?? first;
		const out: [PropertyCode, number][] = [];
		for (const [index, code] of logical.entries()) {
			const n = toNumber(index === 0 ? first : second);
			if (n !== null) out.push([code, n]);
		}
		return out;
	}
	const code = propCode(key);
	if (code === undefined) return [];
	// Rust's default-arm order: typed fields first (they own calc()/units),
	// then the css-wide + unsafe drops, then verbatim passthrough.
	if (NUMBER_CODES.has(code)) {
		const n = toNumber(value);
		return n === null ? [] : [[code, n]];
	}
	if (DIMENSION_CODES.has(code)) {
		const dimension = value.startsWith('calc(') ? evalCalc(value) : toDimension(value);
		if (dimension !== null) return [[code, dimension]];
		// fit-content/min-content/max-content/stretch all mean the Auto arm.
		if (['fit-content', 'min-content', 'max-content', 'stretch'].includes(value)) {
			return [[code, 'auto']];
		}
		return [];
	}
	if (CSS_WIDE.has(value) || unsafeValue(value)) return [];
	const normalized = normalizeProp(code, value);
	return normalized === null ? [] : [[code, normalized]];
}

/** Rule decls → the ordered (code, value) writes for the base bucket, with
 *  the unitless line-height × font-size post-pass Rust applies last. */
function expandDecls(decls: [string, string][]): [PropertyCode, boolean | number | string][] {
	const out: [PropertyCode, boolean | number | string][] = [];
	for (const [key, value] of decls) out.push(...expandDecl(key, value));
	const emitted = new Map(out);
	const lineHeight = emitted.get(PropertyCode.LineHeight);
	if (typeof lineHeight === 'number' && lineHeight > 0 && lineHeight < 8) {
		const fontSize = emitted.get(PropertyCode.FontSize);
		const resolved = lineHeight * (typeof fontSize === 'number' ? fontSize : 16);
		out.push([PropertyCode.LineHeight, Math.round(resolved * 100) / 100]);
	}
	return out;
}

// ── StyleProps mirror (setStyleProps / setRecipe / registerRecipe) ────────
// The env lanes carry raw StyleProps fragments; Rust runs
// `resolve_style_props` → `theme.resolve_style` → StyleDesc. The mirror runs
// the same two steps in JS: `resolveStyleProps` (nkit's field-identical
// mirror) produces the symbolic field map, then the tables below resolve
// token refs to concrete values like tokens.rs does against the live JS
// tables. Scoped `theme` declarations do not re-resolve here (the mirror
// resolves against the global JS tables — the same approximation the sheet
// lane makes); `color-*` refs do follow the element's `color` ctx chain.

const GEOMETRY_TABLES: Record<string, Record<string, number>> = {
	control: CONTROL_H,
	row: ROW_H,
	icon: ICON,
	hit: HIT,
	indent: INDENT,
};

/** recipe.js `variant_token` verbatim: null/absent → '', scalars → String. */
const variantToken = (v: unknown): string =>
	v == null ? '' : typeof v === 'string' ? v
		: typeof v === 'boolean' || typeof v === 'number' ? String(v) : '';

/** Symbolic dimension → concrete px | `N%` | 'auto'. Named scales and
 *  geometry prefixes hit the token tables; a bare numeric string follows
 *  the ×spacing-unit class-token convention; unit-ful strings parse. */
function resolveDimValue(v: unknown): number | string | null {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (v === null || v === undefined || typeof v === 'object') return null;
	const s = String(v).trim();
	if (s === 'auto' || s === 'fit') return 'auto';
	if (s === 'full') return '100%';
	const geo = /^(control|row|icon|hit|indent)-(xs|sm|md|lg|xl)$/.exec(s);
	if (geo) return GEOMETRY_TABLES[geo[1]!]?.[geo[2]!] ?? null;
	if (SPACING[s as keyof typeof SPACING] !== undefined) return SPACING[s as keyof typeof SPACING];
	if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s) * getSpacingUnit();
	return toDimension(s);
}

/** Symbolic color ref → packed color: palette roles resolve against the
 *  element ctx first, literals/named fall through to the binding parser. */
function resolveSymbolicColor(v: unknown, ctxColor?: string): number | null {
	if (typeof v === 'number') return parseColor(v);
	if (typeof v !== 'string') return null;
	return resolveColor(resolveColorRef(v, { color: ctxColor }) ?? v);
}

/** Symbolic boxShadow object → CSS text for the base-lane code. */
function shadowCss(v: Record<string, unknown>, ctxColor?: string): string | null {
	if (typeof v !== 'object') return typeof v === 'string' ? v : null;
	const parts = [
		v.inset ? 'inset' : '',
		`${Number(v.offsetX ?? 0)}px`,
		`${Number(v.offsetY ?? 0)}px`,
		`${Number(v.blurRadius ?? 0)}px`,
		`${Number(v.spreadRadius ?? 0)}px`,
	].filter(Boolean);
	const color = v.color !== undefined ? resolveSymbolicColor(v.color, ctxColor) : null;
	// unresolved currentColor etc → let the core's parser see the raw word
	const colorText = color !== null ? `#${(color >>> 0).toString(16).padStart(8, '0')}` : String(v.color ?? '');
	return [...parts, colorText].filter(Boolean).join(' ');
}

/** Symbolic boxShadow object → the core's NativeBoxShadow shape (state lane). */
function shadowObject(v: unknown, ctxColor?: string): Record<string, unknown> | null {
	if (typeof v === 'string') {
		const parsed = parseBoxShadows(v);
		return parsed?.[0] ?? null;
	}
	if (typeof v !== 'object' || v === null) return null;
	const s = v as Record<string, unknown>;
	const out: Record<string, unknown> = {
		offsetX: Number(s.offsetX ?? 0),
		offsetY: Number(s.offsetY ?? 0),
		blurRadius: Number(s.blurRadius ?? 0),
		spreadRadius: Number(s.spreadRadius ?? 0),
		inset: !!s.inset,
	};
	if (s.color !== undefined) {
		const packed = resolveSymbolicColor(s.color, ctxColor);
		if (packed !== null) out.color = packed;
	}
	return out;
}

/** `raised`/`lift` level name → elevation index (mirror of ELEVATION_ALIAS). */
const ELEVATION_ALIAS: Record<string, number> = { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, xs: 1, sm: 2, md: 3, lg: 4, xl: 5, '2xl': 5 };

/** One symbolic field → (code, value) pairs — the same dispatch shape as
 *  expandDecl but driven by typed values instead of CSS text. */
function symbolicFieldEntries(
	key: string,
	v: unknown,
	ctxColor?: string,
): [PropertyCode, boolean | number | string][] {
	switch (key) {
		case 'fontSize': {
			const n = typeof v === 'number' ? v : FONT_SIZE[v as keyof typeof FONT_SIZE] ?? null;
			return n === null ? [] : [[PropertyCode.FontSize, n]];
		}
		case 'fontWeight': {
			const n =
				typeof v === 'number' ? v
				: FONT_W[v as keyof typeof FONT_W] !== undefined ? FONT_W[v as keyof typeof FONT_W]
				: Number.isFinite(Number(v)) ? Number(v) : null;
			return n === null ? [] : [[PropertyCode.FontWeight, n]];
		}
		case 'borderRadius':
		case 'borderTopLeftRadius':
		case 'borderTopRightRadius':
		case 'borderBottomRightRadius':
		case 'borderBottomLeftRadius': {
			const d = typeof v === 'string' && RADIUS[v as keyof typeof RADIUS] !== undefined
				? RADIUS[v as keyof typeof RADIUS]
				: resolveDimValue(v);
			return typeof d === 'number' ? [[propCode(key)!, d]] : [];
		}
		case 'boxShadow': {
			const css = shadowCss(v, ctxColor);
			return css === null ? [] : [[PropertyCode.BoxShadow, css]];
		}
		case 'textShadow': {
			const css = shadowCss(v, ctxColor);
			return css === null ? [] : [[PropertyCode.TextShadow, css]];
		}
		case 'background': {
			// gradients arrive as {stops:[{color}]} — the core paints a real
			// gradient; the transport's `background` field wants gradient text.
			if (typeof v === 'object' && v !== null) {
				const stops = (v as { stops?: { color?: unknown }[] }).stops;
				const cols = (stops ?? [])
					.map((s) => resolveSymbolicColor(s.color, ctxColor))
					.filter((c): c is number => c !== null)
					.map((c) => `#${(c >>> 0).toString(16).padStart(8, '0')}`);
				return cols.length ? [[PropertyCode.BackgroundColor, cols[0]!]] : [];
			}
			const packed = resolveSymbolicColor(v, ctxColor);
			return packed === null ? [] : [[PropertyCode.BackgroundColor, packed]];
		}
		case 'raised':
		case 'lift': {
			// Rust expands the level into shadow + (raised) hairline + tint.
			const level = ELEVATION_ALIAS[String(v === '' ? 'md' : v)] ?? 0;
			const entry = ELEVATION[level];
			const out: [PropertyCode, number | string][] = [];
			if (entry?.shadow) {
				const css = shadowCss(entry.shadow, ctxColor);
				if (css) out.push([PropertyCode.BoxShadow, css]);
			}
			if (key === 'raised' && level > 0 && getRaisedWithBorder()) {
				out.push([PropertyCode.BorderWidth, 1]);
				const c = resolveSymbolicColor('neutral-muted', ctxColor);
				if (c !== null) out.push([PropertyCode.BorderColor, c]);
			}
			return out;
		}
		// ctx markers the env lane strips before the stream / a core overlay
		// this host can't paint — they drop like an unrepresentable field.
		case 'ctxColor':
		case 'stateLayer':
		case '@desc':
			return [];
		default:
			break;
	}
	const code = propCode(key);
	if (code === undefined) return [];
	if (COLOR_CODES.has(code)) {
		const packed = resolveSymbolicColor(v, ctxColor);
		return packed === null ? [] : [[code, packed]];
	}
	if (NUMBER_CODES.has(code)) {
		const d = resolveDimValue(v);
		return typeof d === 'number' ? [[code, d]] : [];
	}
	if (DIMENSION_CODES.has(code)) {
		const d = resolveDimValue(v);
		return d === null ? [] : [[code, d]];
	}
	if (typeof v === 'object') return [];
	const normalized = normalizeProp(code, v);
	return normalized === null ? [] : [[code, normalized]];
}

/** One symbolic state-bucket field → StateStyleDeclaration entries — the
 *  same closed vocabulary stateDeclEntries owns, with typed values. */
function symbolicStateEntries(key: string, v: unknown, ctxColor?: string): [string, unknown][] {
	switch (key) {
		case 'backgroundColor':
		case 'color':
		case 'borderColor': {
			const packed = resolveSymbolicColor(v, ctxColor);
			return packed === null ? [] : [[key, packed]];
		}
		case 'background': {
			const packed = resolveSymbolicColor(v, ctxColor);
			return packed === null ? [] : [['backgroundColor', packed]];
		}
		case 'borderWidth':
		case 'borderRadius':
		case 'opacity': {
			const d = resolveDimValue(v);
			return typeof d === 'number' ? [[key, d]] : [];
		}
		case 'boxShadow': {
			const s = shadowObject(v, ctxColor);
			return s === null ? [] : [['boxShadow', [s]]];
		}
		case 'letterSpacing': {
			const n = typeof v === 'number' ? v : toNumber(String(v));
			return n === null ? [] : [[PropertyCode.LetterSpacing, n]];
		}
		case 'textTransform':
			return typeof v === 'string' ? [[PropertyCode.TextTransform, v]] : [];
		case 'cursor':
		case 'transform':
		case 'transformOrigin':
			return typeof v === 'string' ? [[key, v]] : [];
		default:
			return [];
	}
}

/** A symbolic field map (resolveStyleProps output or a compiled recipe's
 *  merged fields) → the (code → value) map the env layer writes. Buckets
 *  pack into the core's *Style JSON like the sheet lane's state rules. */
function symbolicToCodes(
	fields: Record<string, unknown>,
	ctxColor?: string,
): Map<number, boolean | number | string> {
	const out = new Map<number, boolean | number | string>();
	for (const [key, v] of Object.entries(fields)) {
		if (v === null || v === undefined) continue;
		if (PSEUDO_STATES.has(key)) {
			const code = STATE_STYLE_CODE[key as PseudoStateName];
			if (code === undefined || typeof v !== 'object') continue;
			const bucket: Record<string, unknown> = {};
			for (const [sk, sv] of Object.entries(v as Record<string, unknown>))
				for (const [f, packed] of symbolicStateEntries(sk, sv, ctxColor)) bucket[f] = packed;
			if (Object.keys(bucket).length > 0) out.set(code, JSON.stringify(bucket));
			continue;
		}
		for (const [code, val] of symbolicFieldEntries(key, v, ctxColor)) out.set(code, val);
	}
	// the unitless line-height × font-size post-pass, same as expandDecls
	const lineHeight = out.get(PropertyCode.LineHeight);
	if (typeof lineHeight === 'number' && lineHeight > 0 && lineHeight < 8) {
		const fontSize = out.get(PropertyCode.FontSize);
		out.set(PropertyCode.LineHeight, Math.round(lineHeight * (typeof fontSize === 'number' ? fontSize : 16) * 100) / 100);
	}
	// lineHeightScale (leading-* multiplier) — the protocol has no scale code;
	// bake it against the emitted fontSize like the unitless hack above.
	const scale = typeof fields.lineHeightScale === 'number' ? fields.lineHeightScale : null;
	if (scale !== null && scale > 0) {
		const fontSize = out.get(PropertyCode.FontSize);
		out.set(PropertyCode.LineHeight, Math.round(scale * (typeof fontSize === 'number' ? fontSize : 16) * 100) / 100);
	}
	return out;
}

/** A registered recipe compiled to symbolic maps — the JS mirror of Rust's
 *  compile_recipe_config + Recipe::from_json (fragments resolve at
 *  registration; call sites ship only variant tokens). */
interface MirrorRecipe {
	base: Record<string, unknown>;
	/** axis → token → symbolic map (declaration order survives via entries) */
	variants: [string, [string, Record<string, unknown>][]][];
	defaults: Record<string, string>;
	compounds: { conds: [string, string[]][]; style: Record<string, unknown> }[];
}

function compileRecipeMirror(cfg: unknown): MirrorRecipe {
	const c = (f: unknown) => resolveStyleProps(f, {});
	const obj = cfg as Record<string, unknown> | null;
	const variants: MirrorRecipe['variants'] = [];
	for (const [axis, table] of Object.entries((obj?.variants as Record<string, unknown>) ?? {})) {
		const entries: [string, Record<string, unknown>][] = [];
		for (const [tok, frag] of Object.entries(table as Record<string, unknown>))
			entries.push([tok, c(frag)]);
		variants.push([axis, entries]);
	}
	const defaults: Record<string, string> = {};
	for (const [axis, v] of Object.entries((obj?.defaultVariants as Record<string, unknown>) ?? {}))
		defaults[axis] = variantToken(v);
	const compounds: MirrorRecipe['compounds'] = [];
	for (const entry of (obj?.compoundVariants as unknown[]) ?? []) {
		const map = entry as Record<string, unknown>;
		if (map?.style === undefined) continue;
		const conds: [string, string[]][] = [];
		for (const [k, v] of Object.entries(map)) {
			if (k === 'style') continue;
			conds.push([k, Array.isArray(v) ? v.map(variantToken) : [variantToken(v)]]);
		}
		compounds.push({ conds, style: c(map.style) });
	}
	return { base: c(obj?.base), variants, defaults, compounds };
}

/** merged_json verbatim: base → per-axis token matches in declaration
 *  order → compounds (every cond's tokens contain the effective token).
 *  `color` enters the effective tuple from ctx before the axis loop, and a
 *  `color` axis overrides it — svelai's `{color:'x', variant:'y'}`
 *  compounds. Empty/absent call values fall back to defaults. */
function recipeMergedFields(rc: MirrorRecipe, variants: unknown, ctxColor: string): Record<string, unknown> {
	const props = (variants ?? {}) as Record<string, unknown>;
	const eff: Record<string, string> = { color: ctxColor };
	const out: Record<string, unknown> = {};
	mergeSymbolic(out, rc.base);
	for (const [axis, entries] of rc.variants) {
		const tok = variantToken(props[axis]) || rc.defaults[axis] || '';
		if (!tok) continue;
		eff[axis] = tok;
		for (const [token, frag] of entries) if (token === tok) mergeSymbolic(out, frag);
	}
	for (const { conds, style } of rc.compounds) {
		const matches = conds.every(([k, toks]) => eff[k] !== undefined && toks.includes(eff[k]!));
		if (matches) mergeSymbolic(out, style);
	}
	return out;
}

/** Symbolic-map merge: objects merge key-wise, null retracts, scalars
 *  last-write-wins — recipe.rs `merge`. */
function mergeSymbolic(dst: Record<string, unknown>, src: Record<string, unknown>) {
	for (const [k, v] of Object.entries(src ?? {})) {
		if (v === null) continue; // null marker: contributes nothing
		const cur = dst[k];
		if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur))
			mergeSymbolic(cur as Record<string, unknown>, v as Record<string, unknown>);
		else dst[k] = v;
	}
}

export class QuickguiSink {
	/** our nativeId → NativeNode */
	readonly nodes = new Map<number, NativeNode>();
	/** setEventListener ops already wired — listener presence is idempotent there */
	private wired = new Set<string>();
	/** gpuix event names the app delegated — wire onto every node (native-side
	 *  delegation replaces per-element setEventListener ops for these). */
	private delegated = new Set<string>();

	/** Wire a delegated type onto one node — the same dedup + listener shape
	 *  the `setEventListener` case uses. */
	private wireDelegated(id: number, node: NativeNode, type: string) {
		const qg = QG_EVENT[type];
		if (!qg) return;
		const key = `${id}:${qg}`;
		if (this.wired.has(key)) return;
		this.wired.add(key);
		setNativeEventListener(node, qg, (ev: QuickGuiEvent) => this.onNativeEvent(id, ev));
	}
	/** headless focus tracking (live host does its own) */
	lastFocused: number | null = null;
	/** host root that setRoot/inserts attach to */
	readonly root: NativeNode;
	/** windowId → mounted root — the JS backend renders one host, but the
	 *  setRoot trailing arg still records the binding so multi-window probes
	 *  can assert routing. */
	readonly windowRoots = new Map<number, NativeNode>();
	/** last `setTheme` declaration — the app-level theme, tree state in Rust */
	themeDecl: unknown = null;
	/** registered sheets: id → parsed rules */
	private sheets = new Map<string, SheetRule[]>();
	/** per-node match context + inline props the cascade must not override */
	private nodeTag = new Map<number, string>();
	private nodeClass = new Map<number, string>();
	private nodeIdAttr = new Map<number, string>();
	/** every setCustomProp key/value per node — the attr-selector input. The
	 *  native side reads its custom_props map the same way; `class` is the
	 *  one comp that reads nodeClass instead (see compoundMatches). */
	private nodeAttrs = new Map<number, Map<string, unknown>>();
	private inlineProps = new Map<number, Set<number>>();
	/** codes the last setStyle object carried — its release domain. Kept
	 *  separate from inlineProps because setCustomProp also marks codes
	 *  inline (theme `color`, placeholder, …) and a style-object replace
	 *  must not clear codes it never carried. */
	private styleOwned = new Map<number, Set<number>>();
	/** property codes the sheet resolution currently owns per node — the
	 *  retraction set when the resolved map shrinks on re-resolve */
	private sheetProps = new Map<number, Set<number>>();
	/** the env layer (setRecipe+setStyleProps travel as a pair): registered
	 *  configs, per-node bindings, per-node frag stream, owned codes */
	private recipes = new Map<string, MirrorRecipe>();
	private nodeRecipes = new Map<number, { name: string; variants: unknown; extra: unknown }>();
	private nodeFrags = new Map<number, unknown[]>();
	private envOwned = new Map<number, Set<number>>();
	/** per-node `color` ctx (the `color` custom prop) — `color-*` refs in the
	 *  env layer resolve against the nearest ancestor's, like Rust's fold */
	private nodeColorCtx = new Map<number, string>();

	constructor(root: NativeNode) {
		this.root = root;
		this.nodes.set(root.id, root);
	}

	/** Same signature as GpuixRenderer.applyBatch — called from native.ts flush(). */
	applyBatch(json: string): number[] {
		const ops = JSON.parse(json) as unknown[][];
		for (const op of ops) this.apply(op);
		return []; // quickgui tracks removal internally; nothing extra to unbind
	}

	// ── selector matching (stylesheet.rs Rule::matches) ──────────────────

	/** Right-to-left compound walk with backtracking — same shape as
	 *  Rule::matches_compound: the subject compound must hold on `id`, then
	 *  each combinator picks candidates to the left (parent / previous
	 *  siblings / ancestors) and recursion retries the rest against each. */
	private ruleMatches(rule: SheetRule, id: number): boolean {
		const groups: SelCompWire[][] = [[]];
		const combs: string[] = [];
		for (const c of rule.sel) {
			if (c.k === 'comb') {
				combs.push(c.v!);
				groups.push([]);
			} else {
				groups[groups.length - 1]!.push(c);
			}
		}
		const matchAt = (gi: number, nodeId: number): boolean => {
			if (!this.compoundMatches(groups[gi]!, nodeId)) return false;
			if (gi === 0) return true;
			const node = this.nodes.get(nodeId);
			switch (combs[gi - 1]) {
				case '>': {
					const p = node?.parent;
					return p !== undefined && p !== null && matchAt(gi - 1, p.id);
				}
				case '+': {
					const s = this.prevSiblingId(nodeId);
					return s !== null && matchAt(gi - 1, s);
				}
				case ' ': {
					let a = node?.parent?.id;
					while (a !== undefined && a !== null) {
						if (matchAt(gi - 1, a)) return true;
						a = this.nodes.get(a)?.parent?.id;
					}
					return false;
				}
				default: {
					// '~'
					let s = this.prevSiblingId(nodeId);
					while (s !== null) {
						if (matchAt(gi - 1, s)) return true;
						s = this.prevSiblingId(s);
					}
					return false;
				}
			}
		};
		return matchAt(groups.length - 1, id);
	}

	private compoundMatches(comps: SelCompWire[], id: number): boolean {
		const cls = new Set((this.nodeClass.get(id) ?? '').split(/\s+/).filter(Boolean));
		const tag = this.nodeTag.get(id);
		const idAttr = this.nodeIdAttr.get(id);
		return comps.every((c) => {
			switch (c.k) {
				case 'universal':
					return true;
				case 'state':
					return true; // routing, not a predicate
				case 'tag':
					return c.v !== undefined && c.v.toLowerCase() === tag?.toLowerCase();
				case 'class':
					return cls.has(c.v!);
				case 'id':
					return c.v === idAttr;
				case 'attr':
					return this.attrMatches(c, id, cls);
				case 'not':
					return !this.compoundMatches(c.sel ?? [], id);
				default:
					return false;
			}
		});
	}

	/** `[attr]`/`[attr op v]` — `class` reads the token list joined (the
	 *  attr text CSS would have seen); other names read the prop map. `=`
	 *  accepts the coerced value first, then a string compare. */
	private attrMatches(c: SelCompWire, id: number, cls: Set<string>): boolean {
		const raw =
			c.v === 'class'
				? cls.size
					? [...cls].join(' ')
					: undefined
				: this.nodeAttrs.get(id)?.get(c.v!);
		if (raw === undefined || raw === null) return false;
		if (!c.op) return true;
		const actual = String(raw);
		const expected = c.x === undefined || c.x === null ? '' : String(c.x);
		if (c.op === '=') return raw === c.x || actual === expected;
		switch (c.op) {
			case '~=':
				return actual.split(/\s+/).includes(expected);
			case '|=':
				return actual === expected || actual.startsWith(`${expected}-`);
			case '^=':
				return actual.startsWith(expected);
			case '$=':
				return actual.endsWith(expected);
			case '*=':
				return expected !== '' && actual.includes(expected);
			default:
				return false;
		}
	}

	/** The element before `id` in its parent's child list, or null. */
	private prevSiblingId(id: number): number | null {
		const node = this.nodes.get(id);
		const parent = node?.parent;
		if (!parent) return null;
		const idx = parent.children.indexOf(node);
		return idx > 0 ? (parent.children[idx - 1]?.id ?? null) : null;
	}

	/** Any registered rule carries a combinator — class/attr/structural
	 *  mutations then re-resolve the whole set (the mirror has no
	 *  dirty-marking; Rust scopes to the parent subtree instead). */
	private get hasComplexSelectors(): boolean {
		for (const rules of this.sheets.values())
			if (rules.some((r) => r.hasComb)) return true;
		return false;
	}

	/** Whether any rule's attr comps test `name` (the Rust registry's
	 *  `tests_attr`). */
	private selectorTestsAttr(name: string): boolean {
		for (const rules of this.sheets.values())
			for (const r of rules) if (r.attrNames.has(name)) return true;
		return false;
	}

	/** Re-resolve the node's matched rules into the full owned-property map —
	 *  base decls at their codes, state decls packed into the *Style JSON —
	 *  then swap it in: codes no longer resolved retract (setNativeProperty
	 *  null), new codes apply. Inline props are never written or retracted —
	 *  the sheet layer sits under them like the Rust cascade. Runs on every
	 *  match-context mutation (tag/class/id) and on sheet changes. */
	private resolveSheet(id: number) {
		const node = this.nodes.get(id);
		if (!node) return;
		const matched = [...this.sheets.values()]
			.flat()
			.filter((r) => this.ruleMatches(r, id))
			.sort((a, b) => cmpSpec(a.spec, b.spec) || a.order - b.order);
		const next = new Map<number, boolean | number | string>();
		const stateDecls = new Map<PropertyCode, Record<string, unknown>>();
		for (const rule of matched) {
			if (rule.state !== null) {
				// Routed, not matched: decls merge per-field into the state's
				// declaration object, which is one JSON property on the node.
				const code = STATE_STYLE_CODE[rule.state];
				if (code === undefined) continue; // focusVisible — no transport
				const fields = stateDecls.get(code) ?? {};
				for (const [key, value] of rule.decls) {
					for (const [field, resolved] of stateDeclEntries(key, value)) {
						fields[field] = resolved;
					}
				}
				// A rule whose decls all dropped must not materialize an
				// empty bucket — same skip as Rust's `fields.is_empty()`.
				if (Object.keys(fields).length > 0) stateDecls.set(code, fields);
				continue;
			}
			for (const [code, normalized] of expandDecls(rule.decls)) {
				next.set(code, normalized);
			}
		}
		for (const [code, fields] of stateDecls) next.set(code, JSON.stringify(fields));

		const inline = this.inlineProps.get(id);
		const previous = this.sheetProps.get(id);
		if (previous) {
			for (const code of previous) {
				if (!next.has(code) && !inline?.has(code)) {
					setNativeProperty(node, code, null);
				}
			}
		}
		for (const [code, value] of next) {
			if (inline?.has(code)) continue;
			setNativeProperty(node, code, value);
		}
		if (next.size > 0) this.sheetProps.set(id, new Set(next.keys()));
		else this.sheetProps.delete(id);
	}

	/** A sheet registered, replaced, or unregistered can change the resolved
	 *  map of ANY element — re-resolve the whole retained set like the Rust
	 *  caller does over the union of old and new rules. */
	private resolveAllSheets() {
		for (const id of this.nodeTag.keys()) this.resolveSheet(id);
	}

	/** The element's `color` ctx — nearest ancestor `color` custom prop,
	 *  else the theme's defaultColor (Rust's ctx_color fold). */
	private ctxColorOf(id: number): string {
		for (let n = this.nodes.get(id)?.parent; n; n = n.parent) {
			const c = this.nodeColorCtx.get(n.id);
			if (c !== undefined) return c;
		}
		return getDefaultColor();
	}

	/** Re-resolve the env layer (recipe binding + frag stream) into codes and
	 *  swap it in — same ownership discipline as setStyle: codes that vanish
	 *  retract so the sheet layer can re-claim them, and the layer sits under
	 *  direct custom-prop writes only via shared inlineProps bookkeeping.
	 *  Rust order is sheet < setStyle < recipe+extra < setStyleProps <
	 *  customProps — recipe fields and env frags merge into one owned map
	 *  here since gdom emits them together on every env change. */
	private resolveEnv(id: number) {
		const node = this.nodes.get(id);
		if (!node) return;
		const merged: Record<string, unknown> = {};
		const ctxColor = this.ctxColorOf(id);
		const binding = this.nodeRecipes.get(id);
		const rc = binding ? this.recipes.get(binding.name) : undefined;
		if (binding && rc) {
			mergeSymbolic(merged, recipeMergedFields(rc, binding.variants, ctxColor));
			// the `style:` escape compiles to symbolic fields, layered over the
			// recipe's merged map exactly like binding.extra in Rust
			if (binding.extra) mergeSymbolic(merged, resolveStyleProps(binding.extra, {}));
		}
		const frags = this.nodeFrags.get(id);
		if (frags?.length) mergeSymbolic(merged, resolveStyleProps(frags, {}));

		const next = symbolicToCodes(merged, ctxColor);
		const inline = this.inlineProps.get(id) ?? new Set<number>();
		let released = false;
		const prev = this.envOwned.get(id);
		if (prev) {
			for (const code of prev) {
				if (!next.has(code)) {
					inline.delete(code);
					setNativeProperty(node, code, null);
					released = true;
				}
			}
		}
		for (const [code, value] of next) {
			inline.add(code);
			setNativeProperty(node, code, value);
		}
		if (inline.size > 0) this.inlineProps.set(id, inline);
		else this.inlineProps.delete(id);
		if (next.size > 0) this.envOwned.set(id, new Set(next.keys()));
		else this.envOwned.delete(id);
		if (released) this.resolveSheet(id);
	}

	private resolveAllEnvs() {
		for (const id of new Set([...this.nodeRecipes.keys(), ...this.nodeFrags.keys()]))
			this.resolveEnv(id);
	}

	private apply(op: unknown[]) {
		switch (op[0] as string) {
			case 'stylesheet.register': {
				// Same-id registration replaces — a re-sent sheet is an edit,
				// and the re-resolve covers both rule sets (Rust returns the
				// replaced rules for exactly this scope).
				this.sheets.set(op[1] as string, parseSheetRules(op[2] as SheetRuleWire[]));
				this.resolveAllSheets();
				break;
			}
			case 'stylesheet.unregister': {
				this.sheets.delete(op[1] as string);
				this.resolveAllSheets();
				break;
			}
			case 'setClass': {
				const id = op[1] as number;
				this.nodeClass.set(id, (op[2] as string) ?? '');
				// A class flip can change ancestor/sibling compounds — Rust
				// scopes the restyle to the parent subtree; the mirror just
				// re-resolves the set.
				if (this.hasComplexSelectors) this.resolveAllSheets();
				else this.resolveSheet(id);
				break;
			}
			case 'createElement': {
				const id = op[1] as number;
				const tag = op[2] as string;
				// gdom emits a 'text' element for DOM text nodes — that is a real
				// Text node in quickgui, not a View.
				const node =
					tag === 'text'
						? new NativeNode(NativeNodeTag.Text, '', id)
						: new NativeNode(QG_TAG[tag] ?? NativeNodeTag.View, '', id);
				if (tag === 'textarea') setNativeProperty(node, PropertyCode.Multiline, true);
				this.nodes.set(id, node);
				this.nodeTag.set(id, tag);
				for (const type of this.delegated) this.wireDelegated(id, node, type);
				this.resolveSheet(id);
				break;
			}
			case 'setText': {
				const node = this.nodes.get(op[1] as number);
				if (node && node.tag === NativeNodeTag.Text) replaceNativeText(node, op[2] as string);
				break;
			}
			case 'setStyle': {
				const node = this.nodes.get(op[1] as number);
				if (!node) break;
				const id = op[1] as number;
				// The payload is the FULL resolved inline object — a prop absent
				// from it was removed (style.removeProperty pushes the whole
				// object). Released codes drop back to the sheet layer, exactly
				// like an inline decl retracting under the Rust cascade.
				const nextOwned = new Set<number>();
				for (const [k, v] of Object.entries(op[2] as Record<string, unknown>)) {
					const code = propCode(k);
					if (code === undefined) continue;
					if (v === null || v === undefined) {
						setNativeProperty(node, code, null);
						continue;
					}
					nextOwned.add(code);
					setNativeProperty(node, code, normalizeProp(code, v));
				}
				const inline = this.inlineProps.get(id) ?? new Set<number>();
				let released = false;
				const prevOwned = this.styleOwned.get(id);
				if (prevOwned) {
					for (const code of prevOwned) {
						if (!nextOwned.has(code)) {
							inline.delete(code);
							setNativeProperty(node, code, null);
							released = true;
						}
					}
				}
				for (const code of nextOwned) inline.add(code);
				if (inline.size > 0) this.inlineProps.set(id, inline);
				else this.inlineProps.delete(id);
				if (nextOwned.size > 0) this.styleOwned.set(id, nextOwned);
				else this.styleOwned.delete(id);
				if (released) this.resolveSheet(id);
				break;
			}
			case 'setCustomProp': {
				const node = this.nodes.get(op[1] as number);
				if (!node) break;
				const id = op[1] as number;
				const key = op[2] as string;
				// every prop lands in the attr map — `[data-x]` selectors test it
				let attrs = this.nodeAttrs.get(id);
				if (op[3] === null || op[3] === undefined) attrs?.delete(key);
				else {
					if (!attrs) this.nodeAttrs.set(id, (attrs = new Map()));
					attrs.set(key, op[3]);
				}
				// the `color` ctx prop drives `color-*` resolution for the env
				// layer on this node and its descendants
				if (key === 'color') {
					if (op[3] === null || op[3] === undefined || op[3] === '') this.nodeColorCtx.delete(id);
					else this.nodeColorCtx.set(id, String(op[3]));
					// descendants' env fields resolve against this ctx — the
					// mirror has no dirty-marking; re-resolve the whole set
					this.resolveAllEnvs();
				}
				if (key === 'id') {
					if (op[3] === null || op[3] === undefined) this.nodeIdAttr.delete(id);
					else this.nodeIdAttr.set(id, op[3] as string);
					this.resolveSheet(id);
					break;
				}
				// A selector-tested attr (`[data-open]`) is a match input —
				// re-resolve like a class change. Combinators widen the scope
				// to the whole set (ancestor/sibling compounds may test it).
				if (this.selectorTestsAttr(key)) {
					if (this.hasComplexSelectors) this.resolveAllSheets();
					else this.resolveSheet(id);
				}
				const code = propCode(key);
				if (code !== undefined) {
					if (op[3] === null || op[3] === undefined) {
						// removeAttribute: clear first (the sheet may not own the
						// code), then release so a sheet decl re-claims it.
						this.inlineProps.get(id)?.delete(code);
						setNativeProperty(node, code, null);
						this.resolveSheet(id);
					} else {
						let inline = this.inlineProps.get(id);
						if (!inline) this.inlineProps.set(id, (inline = new Set()));
						inline.add(code);
						setNativeProperty(node, code, normalizeProp(code, op[3]));
					}
				}
				break;
			}
			case 'registerRecipe': {
				// Definition-time registration — the mirror compiles each
				// fragment to its symbolic map now, like compile_recipe_config.
				const name = op[1] as string;
				this.recipes.set(name, compileRecipeMirror(op[2]));
				// elements already bound to the name re-resolve against the
				// new registration (Rust: register_recipe returns bound ids)
				for (const [id, b] of this.nodeRecipes) if (b.name === name) this.resolveEnv(id);
				break;
			}
			case 'setRecipe': {
				const id = op[1] as number;
				const name = op[2] as string | null;
				if (name == null) this.nodeRecipes.delete(id);
				else this.nodeRecipes.set(id, { name, variants: op[3], extra: op[4] });
				this.resolveEnv(id);
				break;
			}
			case 'setStyleProps': {
				const id = op[1] as number;
				const frags = op[2] as unknown[] | null;
				if (frags == null) this.nodeFrags.delete(id);
				else this.nodeFrags.set(id, frags);
				this.resolveEnv(id);
				break;
			}
			case 'setEventListener': {
				const id = op[1] as number;
				const type = op[2] as string;
				const node = this.nodes.get(id);
				const qg = QG_EVENT[type];
				if (!node || !qg) break;
				const key = `${id}:${qg}`;
				if (this.wired.has(key)) break;
				this.wired.add(key);
				setNativeEventListener(node, qg, (ev: QuickGuiEvent) => this.onNativeEvent(id, ev));
				break;
			}
			case 'setDelegatedEvents': {
				// Native stores the set and attaches at build; the mirror wires
				// existing nodes eagerly (creates get theirs in the create arm).
				this.delegated = new Set(op[1] as string[]);
				for (const [id, node] of this.nodes)
					for (const type of this.delegated) this.wireDelegated(id, node, type);
				break;
			}
			case 'appendChild': {
				const parent = this.nodes.get(op[1] as number);
				const child = this.nodes.get(op[2] as number);
				if (parent && child && child.parent !== parent) insertNativeNode(parent, child);
				// Combinator matches see ancestry/sibling changes on both sides.
				if (this.hasComplexSelectors) this.resolveAllSheets();
				break;
			}
			case 'insertBefore': {
				const parent = this.nodes.get(op[1] as number);
				const child = this.nodes.get(op[2] as number);
				const before = this.nodes.get(op[3] as number);
				if (!parent || !child) break;
				// their insertNativeNode throws on a bad anchor; ours tolerates
				if (before && before.parent === parent) insertNativeNode(parent, child, before);
				else if (child.parent !== parent) insertNativeNode(parent, child);
				if (this.hasComplexSelectors) this.resolveAllSheets();
				break;
			}
			case 'moveBefore': {
				// Always a live-subtree move — insertNativeNode detaches +
				// re-links natively (same-parent reorders included), nothing
				// is destroyed. Rust falls back to end-of-children on a stale
				// or absent anchor; insertNativeNode throws, so guard it.
				const parent = this.nodes.get(op[1] as number);
				const child = this.nodes.get(op[2] as number);
				const before = op[3] != null ? this.nodes.get(op[3] as number) : undefined;
				if (!parent || !child) break;
				if (before && before.parent === parent) insertNativeNode(parent, child, before);
				else insertNativeNode(parent, child);
				if (this.hasComplexSelectors) this.resolveAllSheets();
				break;
			}
			case 'destroyElement': {
				const id = op[1] as number;
				const node = this.nodes.get(id);
				if (node?.parent) removeNativeNode(node.parent, node);
				this.nodeTag.delete(id);
				this.nodeClass.delete(id);
				this.nodeIdAttr.delete(id);
				this.nodeAttrs.delete(id);
				this.inlineProps.delete(id);
				this.styleOwned.delete(id);
				this.sheetProps.delete(id);
				this.nodeRecipes.delete(id);
				this.nodeFrags.delete(id);
				this.envOwned.delete(id);
				this.nodeColorCtx.delete(id);
				// surviving siblings' `~`/`+` matches changed with the removal
				if (this.hasComplexSelectors) this.resolveAllSheets();
				break;
			}
			case 'setRoot': {
				const node = this.nodes.get(op[1] as number);
				if (node && node.parent !== this.root) insertNativeNode(this.root, node);
				if (node) this.windowRoots.set((op[2] as number) ?? 0, node);
				break;
			}
			case 'setTheme': {
				// App-level declaration — the Rust renderer stores it on the
				// retained tree and seeds every ancestor fold. The mirror keeps
				// it for inspection; quickgui's token table resolves the JS
				// tables directly, so nothing needs re-resolving here.
				this.themeDecl = op[1] ?? null;
				break;
			}
		}
	}

	/** Native event → our DOM dispatch. value carries text edits / key names. */
	private onNativeEvent(id: number, ev: QuickGuiEvent) {
		// quickgui event names are already DOM-ish; dispatchPayload's domEvent()
		// passes unknown names through, so feed the type straight through.
		const payload: Record<string, unknown> = {
			elementId: id,
			eventType: ev.type,
			value: ev.value,
		};
		// keydown/keyup carry the key name in `value` on quickgui
		if (ev.type === 'keydown' || ev.type === 'keyup') payload.key = ev.value;
		dispatchPayload(payload as { elementId: number; eventType: string; value?: string });
	}

	// ── GpuixRenderer-shaped native methods (called via deferCall/deferAfterRender) ──

	focusElement(id: number) {
		const node = this.nodes.get(id);
		if (node) {
			this.lastFocused = id;
			node.focus(); // → host._focusNode → binding.focusHostedNode on a live window
		}
	}

	setWindowKeyEvents(keyDown: boolean, keyUp: boolean, sentinel: number) {
		// No window-key API: approximate by listening on the root — events bubble
		// up the parent chain, so focused-element keys reach the root listener.
		if (keyDown)
			setNativeEventListener(this.root, 'keydown', (ev) =>
				dispatchPayload({ elementId: sentinel, eventType: 'windowKeyDown', value: ev.value, key: ev.value } as never),
			);
		if (keyUp)
			setNativeEventListener(this.root, 'keyup', (ev) =>
				dispatchPayload({ elementId: sentinel, eventType: 'windowKeyUp', value: ev.value, key: ev.value } as never),
			);
	}

	/** No layout readback in @quickgui/native — honest null. */
	getElementBounds(_id: number): number[] | null {
		return null;
	}
	getScrollOffset(_id: number): number[] | null {
		return null;
	}
	scrollTo(_id: number, _x: number, _y: number) {}
	scrollToItem(_id: number, _index: number, _offset: number) {}

	/** Serialized native tree — conformance `tree()` equivalent. */
	getAutomationTree(): string {
		const tagName = (t: NativeNodeTag) =>
			t === NativeNodeTag.Text ? 'text'
			: t === NativeNodeTag.Input ? 'input'
			: t === NativeNodeTag.Button ? 'button'
			: 'div';
		const ser = (n: NativeNode): unknown => ({
			id: n.id,
			type: tagName(n.tag),
			text: n.tag === NativeNodeTag.Text ? n.text : undefined,
			bounds: { x: 0, y: 0, width: 0, height: 0 },
			children: n.children.map(ser),
		});
		return JSON.stringify(ser(this.root));
	}

	/** conformance `painted()` equivalent — every Text node's string, in order. */
	getPaintedText(): string[] {
		const out: string[] = [];
		const walk = (n: NativeNode) => {
			if (n.tag === NativeNodeTag.Text && n.text) out.push(n.text);
			n.children.forEach(walk);
		};
		walk(this.root);
		return out;
	}
}

// ── RecordingHost: NativeNodeHost in pure JS for headless tests ───────────

/** The subset of NativeNodeHost the tree actually calls (structural). */
export function createHeadlessRoot() {
	const ops: string[] = [];
	const root = new NativeNode(NativeNodeTag.View, '', 0);
	const host = {
		nativeId: 1,
		app: { nativeId: 1 },
		nodes: new Map<number, NativeNode>([[0, root]]),
		closed: false,
		flush() {
			return undefined;
		},
		_trackMount(_dispose: () => void) {
			return () => {};
		},
		_focusNode(node: NativeNode) {
			ops.push(`focus:${node.id}`);
			return true;
		},
		_enqueueCreate(n: NativeNode) {
			ops.push(`create:${n.id}:${NativeNodeTag[n.tag]}`);
		},
		_enqueueProperty(n: NativeNode, p: PropertyCode, v: unknown) {
			ops.push(`prop:${n.id}:${PropertyCode[p]}=${JSON.stringify(v)}`);
		},
		_enqueueText(n: NativeNode) {
			ops.push(`text:${n.id}=${JSON.stringify(n.text)}`);
		},
		_enqueueInsert(parent: NativeNode, child: NativeNode, before?: NativeNode) {
			ops.push(`insert:${parent.id}<-${child.id}${before ? `@${before.id}` : ''}`);
		},
		_enqueueRemove(parent: NativeNode, child: NativeNode) {
			ops.push(`remove:${parent.id}>-${child.id}`);
		},
		_enqueueCleanup(parent: NativeNode, children: readonly NativeNode[]) {
			ops.push(`cleanup:${parent.id}>-[${children.map((c) => c.id)}]`);
		},
	};
	root.host = host as never;
	root.materialized = true;
	return { root, host, ops };
}

/** Mirror of Window._dispatchEvent — bubble listeners up the parent chain. */
export function dispatchQgEvent(
	sink: QuickguiSink,
	targetId: number,
	type: NativeEventType,
	value?: string,
) {
	// synthesize through the same path a real native event takes: the node owns
	// a listener that forwards into our DOM dispatch.
	const node = sink.nodes.get(targetId);
	if (!node) return;
	const listener = node.listeners.get(type);
	if (!listener) throw new Error(`no ${type} listener on node ${targetId}`);
	listener({ type, target: node, currentTarget: node, value } as QuickGuiEvent);
}
