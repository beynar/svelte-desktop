/**
 * Minimal DOM implementation that materializes into gpuix native mutations.
 *
 * Svelte 5's compiled output drives svelte/internal/client, which talks to
 * real DOM objects. init_operations() captures firstChild/nextSibling getters
 * from the global Node/Element/Text prototypes *lazily at first mount* — so
 * installing these globals beforehand makes Svelte's own traversal run on this
 * tree unchanged, including its document-level event delegation.
 *
 * Comments are pure JS anchors: they never get a native node, and native
 * insertBefore anchors resolve forward to the next materialized sibling.
 */
import { allocId, bindNative, boundsFreshAfterFrame, deferAfterRender, deferCall, emit, measureBounds, nativeBounds, nodeForNativeId, scrollOffset, unbindNative } from './native';
import * as nativeBridge from './native';
import { nativeAttrName, nativeAttrValue } from './native-attr';
import type { CssAnimationRule, CssKeyframesDef, NativeStyleRule, SelComp } from './native-css/parse';

const HTML_NS = 'http://www.w3.org/1999/xhtml';

/** tag (+ key attrs) → implicit ARIA role. Explicit `role` always wins. */
const IMPLICIT_ROLE: Record<string, string> = {
	a: 'link', nav: 'navigation', main: 'main', aside: 'complementary',
	header: 'banner', footer: 'contentinfo', section: 'region', article: 'article',
	button: 'button', select: 'combobox', textarea: 'textbox', option: 'option',
	ul: 'list', ol: 'list', li: 'listitem', table: 'table', thead: 'rowgroup',
	tbody: 'rowgroup', tr: 'row', form: 'form', fieldset: 'group',
	progress: 'progressbar', img: 'img', figure: 'figure', dialog: 'dialog',
};
const implicitRole = (el: { tagName: string; attributes: Map<string, string> }): string | null => {
	const tag = el.tagName.toLowerCase();
	if (/^h[1-6]$/.test(tag)) return 'heading';
	if (tag === 'th') return 'columnheader';
	if (tag === 'td') return 'cell';
	if (tag === 'input') {
		const t = el.attributes.get('type') ?? 'text';
		if (t === 'checkbox') return 'checkbox';
		if (t === 'radio') return 'radio';
		if (t === 'range') return 'slider';
		if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
		if (t === 'search') return 'searchbox';
		if (t === 'hidden') return null;
		return 'textbox';
	}
	if (tag === 'a' && !el.attributes.has('href')) return null;
	return IMPLICIT_ROLE[tag] ?? null;
};
/** Sentinel elementId for window-scoped events that aren't about one
 *  element — key events via setWindowKeyEvents, and the per-render
 *  `frame` event that ticks the rAF queue. */
export const WINDOW_EVENT_ID = 0x7fffff01;
/** element_id sentinel for platform-service events + async call results. */
export const PLATFORM_EVENT_ID = 0x7fffff02;
/** native-api registers here — avoids a gdom→native-api import cycle. */
let platformSink: ((eventType: string, data: unknown) => void) | null = null;
export function setPlatformEventSink(fn: typeof platformSink) { platformSink = fn; }
/** Additive tap beside the bus-owned platformSink. gpuix can't import
 *  @svelte-desktop/platform (the dep direction is platform → gpuix), so
 *  in-package consumers (nkit Theme) subscribe to raw `platform:*` events
 *  here instead of going through the bus. Listeners see the event type as
 *  sent ('platform:appearanceChanged') and the EventPayload.data value. */
const platformEventListeners = new Set<(eventType: string, data: unknown) => void>();
export function onPlatformEvent(fn: (eventType: string, data: unknown) => void): () => void {
	platformEventListeners.add(fn);
	return () => platformEventListeners.delete(fn);
}

const GPUIX_TAGS = new Set([
	'div', 'text', 'img', 'svg', 'canvas', 'input', 'textarea',
	'anchored', 'code', 'diff', 'markdown', 'virtual-list',
]);
/** `x-*` tags are our custom-element registry namespace — they pass through
 *  verbatim so `<x-button>` reaches `custom_elements/x_button.rs`. */
const CUSTOM_TAG = /^x-/;
const VOID_TAGS = new Set([
	'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
]);

const DOM_TO_GPUIX_EVENT: Record<string, string> = {
	click: 'click', mousedown: 'mouseDown', mouseup: 'mouseUp',
	mousemove: 'mouseMove', mouseover: 'mouseEnter', mouseout: 'mouseLeave',
	mouseenter: 'mouseEnter', mouseleave: 'mouseLeave',
	keydown: 'keyDown', keyup: 'keyUp', focus: 'focus', blur: 'blur',
	focusin: 'focus', focusout: 'blur', input: 'change', change: 'change',
	submit: 'submit', scroll: 'scroll',
	// OS file drag/drop (Finder paths). DOM-vs-native honesty note: a
	// registered `drop` listener accepts drops outright — there is no
	// `dragover.preventDefault()` gate like the DOM drag model requires.
	// Native delivers to registered elements directly (more permissive).
	drop: 'fileDrop', dragenter: 'fileDragEnter',
	dragover: 'fileDragOver', dragleave: 'fileDragLeave',
	// overlay + native-element events
	mousedownoutside: 'mouseDownOutside', auxclick: 'auxClick',
	contextmenu: 'contextMenu', visiblerange: 'visibleRange',
	// pointer events subsume mouse — native only has the mouse feed, so
	// pointerdown/up register the real feed (fanout below re-dispatches
	// them). dblclick needs the click feed it is synthesized from; touch*
	// maps for registration/retraction symmetry though nothing dispatches
	// them (no touch input source on the desktop).
	pointerdown: 'mouseDown', pointerup: 'mouseUp',
	touchstart: 'mouseDown', touchend: 'mouseUp',
	dblclick: 'click',
	linkclick: 'linkClick', lineclick: 'lineClick', togglefile: 'toggleFile',
	showmore: 'showMore', highlight: 'highlight',
};
// Built by hand — inverting the forward map loses collisions (focus/focusin
// both map to native 'focus'; last-write-wins would mislabel real focus events).
const GPUIX_TO_DOM_EVENT: Record<string, string> = {
	click: 'click', mouseDown: 'mousedown', mouseUp: 'mouseup',
	mouseMove: 'mousemove', mouseEnter: 'mouseover', mouseLeave: 'mouseout',
	keyDown: 'keydown', keyUp: 'keyup', focus: 'focus', blur: 'blur',
	change: 'change', submit: 'submit', scroll: 'scroll',
	windowKeyDown: 'keydown', windowKeyUp: 'keyup',
	mouseDownOutside: 'mousedownoutside', auxClick: 'auxclick',
	contextMenu: 'contextmenu', visibleRange: 'visiblerange',
	linkClick: 'linkclick', lineClick: 'lineclick', toggleFile: 'togglefile',
	showMore: 'showmore',
	fileDrop: 'drop', fileDragEnter: 'dragenter',
	fileDragOver: 'dragover', fileDragLeave: 'dragleave',
};
// One native event can map to several DOM dispatches (browser semantics):
// gpuix 'change' per-edit = DOM input+change; focus/blur = focus+focusin etc.
const NATIVE_FANOUT: Record<string, string[]> = {
	change: ['input', 'change'],
	focus: ['focus', 'focusin'],
	blur: ['blur', 'focusout'],
	mouseover: ['mouseover', 'mouseenter'],
	mouseout: ['mouseout', 'mouseleave'],
	// A mouse press is also a pointerdown (mouse is a pointer type);
	// touch* deliberately absent — mouse input must not fire touch handlers.
	mousedown: ['mousedown', 'pointerdown'],
	mouseup: ['mouseup', 'pointerup'],
};
// DOM events that must not walk the ancestor chain.
const NO_BUBBLE = new Set(['focus', 'blur', 'scroll', 'load', 'error', 'mouseenter', 'mouseleave']);

/** Scoped-CSS bridge: svelte emits `<style>` rules like `.a.svelte-<hash> {}`.
 * Each rule stores the classes of its last compound selector; an element matches
 * when it carries *all* of them (combinators/pseudo-classes unsupported). */
interface ClassRule {
	tag?: string;
	required: string[];
	props: Map<string, string>;
	state?: 'hover' | 'focus' | 'active';
}
type Rule = ClassRule & {
	ix: number; // source order — last-wins semantics need stable ordering
	attrs?: [string, string | true][];
	notAttrs?: [string, string | true][];
};
const classRules: Rule[] = [];
// index: class name → rules requiring it; rules with no required classes
// (tag-only, attr-only, universal) live in globalRules. Matching an element is
// union-of-its-classes instead of a scan of the whole table.
const rulesByClass = new Map<string, Rule[]>();
const globalRules: Rule[] = [];
let hasStateRules = false;

/** CSS `animation-timing-function` keywords → easing curves. Applied to the
 *  whole-iteration progress — close enough to per-segment easing for the
 *  two-frame animations CSS authors actually write. */
const CSS_EASINGS: Record<string, (t: number) => number> = {
	linear: (t) => t,
	ease: (t) => t * t * (3 - 2 * t),
	'ease-in': (t) => t * t * t,
	'ease-out': (t) => 1 - (1 - t) ** 3,
	'ease-in-out': (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
};

// ── declared CSS animations ──────────────────────────────────────────
// `@keyframes` + `animation:` arrive at registerCssAnimations() from the
// stylesheet pipeline (native-css/parse → registerSheet). Matching a rule
// to an element lowers the declaration onto element.animate() — the same
// lowering browsers do from CSS Animations onto WAAPI. JS orchestrates the
// timing (as it does for every animation); the style payload boundary is
// unchanged. The spec/rule/keyframes types live in native-css/parse.ts —
// imported type-only so lightningcss never enters the runtime graph.
const cssKeyframesBySheet = new Map<string, Map<string, CssKeyframesDef['frames']>>();
const cssAnimRulesBySheet = new Map<string, CssAnimationRule[]>();
let cssSheetSeq = 0;
const cssSheetOrder = new Map<string, number>();

/** (Re)register one sheet's animation payload — mirrors registerSheet's
 *  replace contract, then re-resolves live elements like a stylesheet
 *  change would. */
export function registerCssAnimations(
	sheetId: string,
	keyframes: CssKeyframesDef[] | undefined,
	animations: CssAnimationRule[] | undefined,
) {
	if (keyframes?.length) {
		const m = new Map<string, CssKeyframesDef['frames']>();
		for (const k of keyframes) m.set(k.name, k.frames);
		cssKeyframesBySheet.set(sheetId, m);
	} else cssKeyframesBySheet.delete(sheetId);
	if (animations?.length) cssAnimRulesBySheet.set(sheetId, animations);
	else cssAnimRulesBySheet.delete(sheetId);
	if (!cssSheetOrder.has(sheetId)) cssSheetOrder.set(sheetId, cssSheetSeq++);
	refreshCssAnimations();
}

/** Sheet dropped — its keyframes/rules leave; live elements reconcile. */
export function unregisterCssAnimations(sheetId: string) {
	if (!cssKeyframesBySheet.delete(sheetId) && !cssAnimRulesBySheet.delete(sheetId)) return;
	cssSheetOrder.delete(sheetId);
	refreshCssAnimations();
}

function refreshCssAnimations() {
	const walk = (n: GNode) => {
		if (n.nodeType === 1) reconcileCssAnimation(n as GElement);
		n.childNodes.forEach(walk);
	};
	if (doc.documentElement) walk(doc.documentElement);
}

/** Re-resolve the element's declared animation: the highest-cascade matching
 *  rule (specificity, then sheet/registration order, then source order) owns
 *  it. A changed spec restarts; no match cancels. */
function reconcileCssAnimation(el: GElement) {
	const cls = new Set(el._className.split(/\s+/).filter(Boolean));
	const tag = el.tagName.toLowerCase();
	type Cand = { r: CssAnimationRule; so: number };
	const beats = (a: Cand, b: Cand) =>
		a.r.spec3[0] !== b.r.spec3[0] || a.r.spec3[1] !== b.r.spec3[1] || a.r.spec3[2] !== b.r.spec3[2]
			? a.r.spec3[0] > b.r.spec3[0] ||
				(a.r.spec3[0] === b.r.spec3[0] &&
					(a.r.spec3[1] > b.r.spec3[1] ||
						(a.r.spec3[1] === b.r.spec3[1] && a.r.spec3[2] > b.r.spec3[2])))
			: a.so !== b.so
				? a.so > b.so
				: a.r.order > b.r.order;
	let best: Cand | null = null;
	for (const [sheetId, rules] of cssAnimRulesBySheet) {
		const so = cssSheetOrder.get(sheetId) ?? 0;
		for (const r of rules) {
			if (r.tag && r.tag !== tag) continue;
			if (!r.classes.every((c) => cls.has(c))) continue;
			const cand: Cand = { r, so };
			if (!best || beats(cand, best)) best = cand;
		}
	}
	const frames = best ? lookupCssKeyframes(best.r.spec.name) : null;
	// Keyframe content is part of the identity: an HMR sheet edit that only
	// touched @keyframes bodies must still restart the running animation.
	const sig = best && frames ? `${best.r.spec.name}:${JSON.stringify(best.r.spec)}:${JSON.stringify(frames)}` : '';
	if (sig === el._cssAnimSig) return;
	el._cssAnim?.cancel();
	el._cssAnim = null;
	el._cssAnimSig = '';
	if (!best || !frames) return;
	// Keyframe record → animate() input: offset stays a sibling field, props
	// spread in as the animatable declarations.
	el._cssAnim = el.animate(
		frames.map((f) => ({ offset: f.offset, ...f.props })) as Record<string, unknown>[],
		{
			duration: best.r.spec.duration,
			delay: best.r.spec.delay,
			iterations: best.r.spec.iterations === 'infinite' ? Infinity : best.r.spec.iterations,
			direction: best.r.spec.direction,
			easing: best.r.spec.easing,
			fill: best.r.spec.fill === 'none' ? undefined : best.r.spec.fill,
		},
	) as unknown as { cancel(): void };
	el._cssAnimSig = sig;
}

function lookupCssKeyframes(name: string): CssKeyframesDef['frames'] | null {
	let hit: CssKeyframesDef['frames'] | null = null;
	for (const m of cssKeyframesBySheet.values()) if (m.has(name)) hit = m.get(name)!;
	return hit;
}

// ── computed-style rule mirror ───────────────────────────────────────
// Registered sheets live natively (stylesheet.register — Rust matches and
// resolves). This read-only mirror exists so getComputedStyle can report
// class-derived values the same way a browser's cascade does — slide() and
// friends read longhands here, so a class-only padding must resolve or its
// keyframes silently drop it (the 16px stall). The props never re-enter the
// styling pipeline: mergedStyleProps/nativeStyleFor are untouched.
type ComputedRule = { sheet: string; seq: number; rule: NativeStyleRule; props: Map<string, string> };
const computedStyleRules: ComputedRule[] = [];
const computedSheetSeq = new Map<string, number>();
let computedSeq = 0;

export function registerComputedStyleRules(id: string, rules: NativeStyleRule[] | undefined): void {
	for (let i = computedStyleRules.length - 1; i >= 0; i--)
		if (computedStyleRules[i].sheet === id) computedStyleRules.splice(i, 1);
	if (!computedSheetSeq.has(id)) computedSheetSeq.set(id, computedSeq++);
	for (const rule of rules ?? []) {
		const props = new Map<string, string>();
		for (const decl of rule.decls.split(';')) {
			const i = decl.indexOf(':');
			if (i === -1) continue;
			const k = decl.slice(0, i).trim();
			const v = decl.slice(i + 1).trim();
			if (k && v) props.set(k.startsWith('--') ? k : kebabToCamel(k), v);
		}
		computedStyleRules.push({ sheet: id, seq: computedSheetSeq.get(id)!, rule, props });
	}
}

export function unregisterComputedStyleRules(id: string): void {
	for (let i = computedStyleRules.length - 1; i >= 0; i--)
		if (computedStyleRules[i].sheet === id) computedStyleRules.splice(i, 1);
	computedSheetSeq.delete(id);
}

function parentEl(el: GElement): GElement | null {
	let p = el.parentNode as GNode | null;
	while (p && p.nodeType !== 1) p = p.parentNode as GNode | null;
	return (p as GElement | null) ?? null;
}
function prevEl(el: GElement): GElement | null {
	let s = el.previousSibling as GNode | null;
	while (s && s.nodeType !== 1) s = s.previousSibling as GNode | null;
	return (s as GElement | null) ?? null;
}

function stateMatches(el: GElement, v: string): boolean {
	if (v === 'hover') return el._hovered;
	if (v === 'active') return el._active;
	if (v === 'focus') return el._focused;
	// focusWithin covers a focused descendant; focusVisible approximates focus
	if (v === 'focusWithin') {
		if (el._focused) return true;
		let hit = false;
		const walk = (n: GNode) => {
			if (hit) return;
			if (n.nodeType === 1 && (n as GElement)._focused) hit = true;
			for (const c of n.childNodes) walk(c);
		};
		for (const c of el.childNodes) walk(c);
		return hit;
	}
	if (v === 'focusVisible') return el._focused;
	return false;
}

function attrCompMatches(el: GElement, c: { v: string; op?: string; x?: unknown }): boolean {
	for (const [k, raw] of el.attributes) {
		if (nativeAttrName(k) !== c.v) continue;
		const v = String(raw);
		if (c.op === undefined) return true;
		const x = String(c.x ?? '');
		switch (c.op) {
			case '=': if (v === x) return true; break;
			case '~=': if (v.split(/\s+/).includes(x)) return true; break;
			case '|=': if (v === x || v.startsWith(x + '-')) return true; break;
			case '^=': if (v.startsWith(x)) return true; break;
			case '$=': if (v.endsWith(x)) return true; break;
			case '*=': if (v.includes(x)) return true; break;
		}
	}
	return false;
}

/** One compound — every comp matches the same element. */
function compoundMatches(el: GElement, comps: SelComp[]): boolean {
	for (const c of comps) {
		switch (c.k) {
			case 'universal': break;
			case 'tag': if (el.tagName.toLowerCase() !== c.v) return false; break;
			case 'class': if (!el._className.split(/\s+/).includes(c.v)) return false; break;
			case 'id': if (el.attributes.get('id') !== c.v) return false; break;
			case 'state': if (!stateMatches(el, c.v)) return false; break;
			case 'attr': if (!attrCompMatches(el, c)) return false; break;
			case 'not': if (compoundMatches(el, c.sel)) return false; break;
			default: return false;
		}
	}
	return true;
}

/** Full selector: compounds joined by combinators, matched right-to-left. */
function selMatches(el: GElement, sel: SelComp[]): boolean {
	const compounds: SelComp[][] = [[]];
	const combs: string[] = [];
	for (const c of sel) {
		if (c.k === 'comb') {
			combs.push(c.v);
			compounds.push([]);
		} else compounds[compounds.length - 1].push(c);
	}
	let cur: GElement | null = el;
	if (!compoundMatches(cur, compounds[compounds.length - 1])) return false;
	for (let i = compounds.length - 2; i >= 0; i--) {
		const need = compounds[i], comb = combs[i];
		if (comb === '>') {
			cur = parentEl(cur);
			if (!cur || !compoundMatches(cur, need)) return false;
		} else if (comb === '+') {
			cur = prevEl(cur);
			if (!cur || !compoundMatches(cur, need)) return false;
		} else {
			// ' ' ancestor chain, '~' preceding siblings — scan until a match
			const next = comb === '~' ? prevEl : parentEl;
			let p = next(cur);
			cur = null;
			while (p) {
				if (compoundMatches(p, need)) { cur = p; break; }
				p = next(p);
			}
			if (!cur) return false;
		}
	}
	return true;
}

/** State-bucket keys in the native merged map — nested objects, not props. */
const COMPUTED_STATE_BUCKET = new Set(['hover', 'active', 'focus', 'focusWithin', 'focusVisible']);
/** Wire values are numbers for px-resolved dimensions and bare for unitless
 *  props — this set decides which get 'px' when getComputedStyle formats
 *  them back into CSS strings. DimensionValue fields also arrive as
 *  strings ('30%', 'auto') and pass through untouched. */
const COMPUTED_LENGTH = new Set([
	'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'flexBasis',
	'top', 'right', 'bottom', 'left',
	'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
	'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
	'gap', 'rowGap', 'columnGap',
	'borderWidth', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
	'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
	'fontSize', 'lineHeight', 'letterSpacing', 'gridTemplateColumns', 'gridTemplateRows',
]);
/** One wire-format value → CSS text in `props`. Objects (shadow lists,
 *  font-feature maps) serialize so reads get something parseable rather
 *  than '[object Object]'. */
function writeComputed(props: Record<string, string>, k: string, v: unknown) {
	if (v === null || v === undefined) return;
	if (typeof v === 'number') props[k] = COMPUTED_LENGTH.has(k) ? `${v}px` : String(v);
	else if (typeof v === 'string') props[k] = v;
	else if (typeof v === 'boolean') props[k] = String(v);
	else props[k] = JSON.stringify(v);
}

/** Cascaded class-rule props for el: specificity → sheet order → source
 *  order, per-prop last-wins — the author layer getComputedStyle merges
 *  under inline styles. */
function computedClassProps(el: GElement): Map<string, string> {
	const matched: { spec: [number, number, number]; so: number; ord: number; props: Map<string, string> }[] = [];
	for (const cr of computedStyleRules) {
		if (selMatches(el, cr.rule.sel)) {
			matched.push({ spec: cr.rule.spec, so: cr.seq, ord: cr.rule.order, props: cr.props });
		}
	}
	matched.sort((a, b) =>
		a.spec[0] !== b.spec[0] ? a.spec[0] - b.spec[0]
		: a.spec[1] !== b.spec[1] ? a.spec[1] - b.spec[1]
		: a.spec[2] !== b.spec[2] ? a.spec[2] - b.spec[2]
		: a.so !== b.so ? a.so - b.so
		: a.ord - b.ord);
	const out = new Map<string, string>();
	for (const m of matched) for (const [k, v] of m.props) out.set(k, v);
	return out;
}
/** elements currently holding _active — cleared on ANY mouseup (native
 *  delivers it to the hit element, which may differ from the mousedown
 *  target — a window-level clear prevents :active sticking forever) */
const activeElements = new Set<GElement>();

function indexRule(r: Rule) {
	if (r.required.length === 0) {
		globalRules.push(r);
		return;
	}
	for (const c of r.required) {
		const b = rulesByClass.get(c);
		if (b) b.push(r);
		else rulesByClass.set(c, [r]);
	}
}

function parseStyleSheet(css: string) {
	// strip @media/@supports/… blocks by brace depth — inner rules must not
	// leak out as unconditional top-level rules
	{
		let out = '', depth = 0, i = 0;
		while (i < css.length) {
			const at = css.indexOf('@', i);
			if (at === -1) { out += css.slice(i); break; }
			out += css.slice(i, at);
			const brace = css.indexOf('{', at);
			const semi = css.indexOf(';', at);
			if (semi !== -1 && (brace === -1 || semi < brace)) { i = semi + 1; continue; } // @import …; — drop the statement
			if (brace === -1) break;
			depth = 1; let j = brace + 1;
			while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
			i = j;
		}
		css = out;
	}
	const ruleRe = /([^{}]+)\{([^}]*)\}/g;
	let m: RegExpExecArray | null;
	while ((m = ruleRe.exec(css))) {
		const selRaw = m[1], body = m[2];
		if (selRaw === undefined || body === undefined) continue;
		const selectors = selRaw.trim();
		if (selectors.startsWith('@')) continue;
		const props = new Map<string, string>();
		for (const decl of body.split(';')) {
			const i = decl.indexOf(':');
			if (i === -1) continue;
			const raw = decl.slice(0, i).trim();
			const k = raw.startsWith('--') ? raw : kebabToCamel(raw);
			const v = decl.slice(i + 1).trim().replace(/\s*!important\s*$/, '');
			if (k && v) props.set(k, v);
		}
		for (const sel of selectors.split(',')) {
			const s = sel.trim();
			if (!s) continue;
			// :where(...) is zero-specificity — unwrap to its inner compound
			// (:where([data-active]:not([data-active="false"])) etc., one level deep)
			const s1 = s.replace(/:where\(([^()]*(?:\([^()]*\))?[^()]*)\)/g, '$1');
			// :not([attr]) / :not([attr="v"]) — tailwind's `data-x:` variant emits
			// `[data-x]:not([data-x="false"])`; negative attr conditions we can check
			const notAttrs: [string, string | true][] = [];
			const s0 = s1.replace(
				/:not\(\s*\[([\w-]+)(?:=["']?([^"'\])]*)["']?)?\]\s*\)/g,
				(_, k, v) => {
					notAttrs.push([k, v === undefined || v === '' ? true : v]);
					return '';
				},
			);
			// split off a trailing interaction pseudo we can model natively
			// (:hover via mouseEnter/Leave, :active via mouseDown/Up, :focus);
			// escaped colons inside class names (.md\:block) are not pseudos
			const unesc = s0.replace(/\\./g, '');
			const st = /:(hover|focus-visible|focus|active)$/.exec(unesc)?.[1] as
				| 'hover'
				| 'focus-visible'
				| 'focus'
				| 'active'
				| undefined;
			const state: Rule['state'] = st === 'focus-visible' ? 'focus' : st === undefined ? undefined : st;
			const s2 = state ? s0.slice(0, s0.lastIndexOf(':')) : s0;
			if (!state && unesc.includes(':')) continue; // other pseudos still dropped
			const parts = s2.split(/[\s>+~]+/).filter(Boolean);
			// descendant/child selectors need ancestor evaluation we don't do —
			// applying only the last compound would match far too much
			// (e.g. `.x > button{display:none}` would hide EVERY button)
			if (parts.length !== 1) continue;
			const compound = parts[0];
			if (!compound) continue;
			const required = [...compound.matchAll(/\.((?:\\.|[^\s.>+~:[\]])+)/g)].flatMap((x) =>
				x[1] === undefined ? [] : [x[1].replace(/\\(.)/g, '$1')], // tailwind escapes: .w-\(--x\) → w-(--x)
			);
			const attrs: [string, string | true][] = [
				...compound.matchAll(/\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/g),
			].flatMap((x) =>
				x[1] === undefined
					? []
					: [[x[1], x[2] === undefined || x[2] === '' ? true : x[2]] as [string, string | true]],
			);
			const tag = /^[a-zA-Z][\w-]*/.exec(compound)?.[0]?.toLowerCase();
			const rule: Rule = {
				ix: classRules.length,
				tag: tag && tag !== '*' ? tag : undefined,
				required, attrs, notAttrs, props, state,
			};
			classRules.push(rule);
			indexRule(rule);
			if (state) hasStateRules = true;
		}
	}
	// rules can land after elements materialized — re-apply to the live tree
	const walk = (n: GNode) => {
		if (n.nodeType === 1) {
			const el = n as GElement;
			applyClassStyles(el);
			if (el._hasStateRule && el.nativeId) {
				for (const t of ['mouseover', 'mouseout', 'mousedown', 'mouseup']) emitListener(el, t);
			}
		}
		n.childNodes.forEach(walk);
	};
	walk(doc.documentElement);
}

/** Recompute the element's class-derived style props (inline styles win at push). */
function applyClassStyles(el: GElement) {
	const cls = new Set(el._className.split(/\s+/).filter(Boolean));
	// candidate rules = global (no required classes) ∪ rules indexed by the
	// element's own classes — then re-ordered to source order for last-wins
	const cand = new Set<Rule>(globalRules);
	for (const c of cls) {
		const b = rulesByClass.get(c);
		if (b) for (const r of b) cand.add(r);
	}
	const ordered = cand.size === globalRules.length ? globalRules : [...cand].sort((a, b) => a.ix - b.ix);
	const match = (r: Rule) =>
		(!r.tag || r.tag === el.tagName.toLowerCase()) &&
		r.required.every((c) => cls.has(c)) &&
		(!r.attrs ||
			r.attrs.every(([k, v]) => (v === true ? el.attributes.has(k) : el.attributes.get(k) === v))) &&
		(!r.notAttrs ||
			r.notAttrs.every(([k, v]) =>
				v === true ? !el.attributes.has(k) : el.attributes.get(k) !== v,
			));
	el._classProps.clear();
	for (const r of ordered) {
		if (r.state || !match(r)) continue;
		for (const [k, v] of r.props) el._classProps.set(k, v);
	}
	// interaction-state rules carry an extra pseudo = higher specificity —
	// they layer on top of base rules regardless of source order
	let stateRuleMatch = false;
	for (const r of ordered) {
		if (!r.state || !match(r)) continue;
		stateRuleMatch = true;
		if (r.state === 'hover' && !el._hovered) continue;
		if (r.state === 'focus' && !el._focused) continue;
		if (r.state === 'active' && !el._active) continue;
		for (const [k, v] of r.props) el._classProps.set(k, v);
	}
	el._hasStateRule = stateRuleMatch;
	reconcileCssAnimation(el);
	if (el.nativeId) el.style.push();
}

/** kit lane: install/replace a resolved native StyleDesc — bypasses the CSS
 *  engine entirely; merged into every subsequent style push.
 *
 *  `s()`/`resolveTokens` stamp `ctxColor` on the resolved object when the
 *  component passed a `color` ctx — that is svelai's `data-color` bridge:
 *  the value crosses as the `color` custom prop so `color-*` refs in the
 *  subtree resolve through it natively. The channel is owned by this path —
 *  we only remove the prop when we set it. */
export function applyNativeStyle(el: GElement, style: Record<string, unknown> | null) {
	// Native envelope (nkit `s()`/`recipe()` output): raw StyleProps fragments
	// + an optional recipe binding. The mapping/resolution runs in Rust — the
	// wire carries the props payload and variant names via dedicated ops.
	const env = style as { __native?: boolean; __ctx?: unknown } | null;
	if (env?.__native === true) {
		el._nativeEnv = env;
		const ctxColor = env.__ctx;
		if (ctxColor != null) {
			el._ctxColorOwned = true;
			el.setCustomProp('color', ctxColor);
		} else if (el._ctxColorOwned) {
			el._ctxColorOwned = false;
			if (el._attrColor != null) el.setCustomProp('color', el._attrColor);
			else el.removeCustomProp('color');
		}
		if (el._nativeStyle) {
			el._nativeStyle = null;
			if (el.nativeId) el.style.push();
		}
		if (el.nativeId) emitNativeEnv(el);
		return;
	}
	if (el._nativeEnv) {
		el._nativeEnv = null;
		if (el.nativeId) emitNativeEnv(el); // clears both native layers
	}
	const ctxColor = style?.ctxColor;
	if (ctxColor != null) {
		el._ctxColorOwned = true;
		el.setCustomProp('color', ctxColor);
	} else if (el._ctxColorOwned) {
		el._ctxColorOwned = false;
		if (el._attrColor != null) el.setCustomProp('color', el._attrColor);
		else el.removeCustomProp('color');
	}
	const { ctxColor: _drop, ...rest } = (style ?? {}) as Record<string, unknown>;
	el._nativeStyle = style == null ? null : rest;
	if (el.nativeId) el.style.push();
}

/** Emit the retained style-layer ops for an element's native envelope. The
 *  Rust side keeps the slots — re-emission is idempotent, and `null` clears
 *  a layer the previous payload occupied. */
function emitNativeEnv(el: GElement) {
	const env = el._nativeEnv as {
		__frags?: unknown[];
		__recipe?: { name: string; variants: Record<string, unknown>; extra: unknown } | null;
	} | null;
	const recipe = env?.__recipe ?? null;
	emit('setRecipe', el.nativeId, recipe?.name ?? null, recipe?.variants ?? null, recipe?.extra ?? null);
	emit('setStyleProps', el.nativeId, env?.__frags?.length ? env.__frags : null);
}

function gpuixTag(tag: string) {
	return GPUIX_TAGS.has(tag) || CUSTOM_TAG.test(tag) ? tag : 'div';
}
function gpuixEvent(dom: string) {
	return DOM_TO_GPUIX_EVENT[dom] ?? dom;
}
export function domEvent(gpuix: string) {
	return GPUIX_TO_DOM_EVENT[gpuix] ?? gpuix;
}

/** Event types Svelte delegated onto document/target roots. */
const delegatedTypes = new Set<string>();

/** (nativeId → eventTypes) already sent — avoids duplicate setEventListener
 *  ops. Keyed by nativeId so dematerialize is O(1) per node instead of
 *  scanning every registered event. */
const registeredEvents = new Map<number, Set<string>>();

function emitListener(el: GElement, domType: string) {
	if (!el.nativeId) return;
	let set = registeredEvents.get(el.nativeId);
	if (!set) registeredEvents.set(el.nativeId, (set = new Set()));
	if (set.has(domType)) return;
	set.add(domType);
	emit('setEventListener', el.nativeId, gpuixEvent(domType), true);
}

// ── press targets (`data-window-drag` no-drag) ───────────────────────
// `element.events` can't say "this element owns the press": delegated
// types are backfilled onto every element so native dispatch fires under
// the cursor. The truth lives elsewhere — tags with implicit activation,
// interactive roles, direct listeners (el.listeners), and delegated
// handlers, which Svelte stores on `el[Symbol('events')]` without going
// through listeners at all. `pressTarget` marks the union for native:
// a press on one of these is consumed before a windowDrag ancestor can
// arm a drag or double-click the titlebar.
//
// The mark is a lifecycle, not a one-shot: refreshPressTarget() re-runs
// the predicate at every mutation that can flip it (listener add/remove,
// role/contenteditable/type/href attrs, delegated backfill, lazily at
// dispatch) and converges the emitted prop — set when newly-true,
// retracted via removeCustomProp (null) when newly-false. `_customProps`
// doubles as the emitted-state record, so repeat calls are cheap no-ops.
const PRESS_TARGET_EVENTS = new Set([
	'click', 'auxclick', 'contextmenu', 'dblclick', 'mousedown', 'mouseup',
	'pointerdown', 'pointerup', 'touchstart', 'touchend',
]);
const PRESS_TARGET_ROLES = new Set([
	'button', 'link', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
	'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'menuitem',
	'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'gridcell',
	'columnheader', 'menu', 'scrollbar',
]);
function delegatedHandlers(el: GElement): Record<string, unknown> | undefined {
	// probe per call — dual svelte copies / HMR can mint a fresh
	// Symbol('events'), so a module-cached symbol could read the wrong slot
	const sym = Object.getOwnPropertySymbols(el).find((s) => s.description === 'events');
	return sym ? (el as unknown as Record<symbol, Record<string, unknown>>)[sym] : undefined;
}
function isPressTarget(el: GElement): boolean {
	for (const [t, s] of el.listeners ?? []) if (s.size && PRESS_TARGET_EVENTS.has(t)) return true;
	const delegated = delegatedHandlers(el);
	// `delegated(name, el, undefined)` leaves enumerable undefined keys —
	// require a live handler, not just the slot
	if (delegated) for (const t in delegated) if (delegated[t] != null && PRESS_TARGET_EVENTS.has(t)) return true;
	// activation tags whose implicit role is absent or non-interactive
	if (el.tagName === 'SUMMARY' || el.tagName === 'LABEL') return true;
	const role = el.attributes.get('role') ?? implicitRole(el);
	if (role && PRESS_TARGET_ROLES.has(role)) return true;
	// contenteditable="false" is non-editable — presence alone isn't enough
	const ce = el.attributes.get('contenteditable');
	return ce !== undefined && ce !== 'false';
}
/** mount() registers handle_event_propagation for every delegated type on
 *  the target (and document) — a host's listener list can't prove it owns
 *  the press, so roots/body/documentElement never mark themselves. */
const isDelegationHost = (el: GElement) =>
	el.__isMountRoot === true || el === doc.body || el === doc.documentElement;
/** Pointer types materialize emits for :hover/:active rule holders. */
const STATE_RULE_TYPES = new Set(['mouseover', 'mouseout', 'mousedown', 'mouseup']);
/** Focus/key/change types materialize emits for text inputs (FocusHandle feed). */
const INPUT_FEED_TYPES = new Set(['focus', 'blur', 'keydown', 'keyup', 'input', 'change']);
/** Anything still claiming this element's native feed for `domType` —
 *  removeEventListener consults it before retracting: root-delegated types
 *  (backfilled onto every element so dispatch fires under the cursor),
 *  handlers stamped on el[eventsSymbol], surviving DOM aliases sharing the
 *  gpuix name (focusin→focus), and the implicit feeds above. */
function listenerFeedClaimed(el: GElement, domType: string): boolean {
	if (delegatedTypes.has(domType)) return true;
	if (delegatedHandlers(el)?.[domType] != null) return true;
	const gx = gpuixEvent(domType);
	if (el.listeners) for (const [t, s] of el.listeners) if (s.size && gpuixEvent(t) === gx) return true;
	if (el._hasStateRule && STATE_RULE_TYPES.has(domType)) return true;
	const tag = el.tagName;
	if ((tag === 'INPUT' || tag === 'TEXTAREA') && INPUT_FEED_TYPES.has(domType)) return true;
	if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio') && domType === 'click') return true;
	return false;
}
function refreshPressTarget(el: GElement) {
	// inputs/x-* customs guard presses natively via default_prevented —
	// the prop is dead op noise on them. (Toggle inputs materialize as a
	// div, which does read it.)
	const tag = el.tagName.toLowerCase();
	const nativeTag = tag === 'input' && (el.type === 'checkbox' || el.type === 'radio') ? 'div' : gpuixTag(tag);
	const want =
		nativeTag !== 'input' && nativeTag !== 'textarea' && !CUSTOM_TAG.test(nativeTag) &&
		!isDelegationHost(el) && isPressTarget(el);
	if (want) el.setCustomProp('pressTarget', true);
	else el.removeCustomProp('pressTarget');
}

// focus/key events only reach focusable elements natively — fanning them out
// to every div just creates a FocusHandle per element and pollutes tab order
const FOCUS_KEY_TYPES = new Set(['keydown', 'keyup', 'keypress', 'focus', 'blur', 'focusin', 'focusout']);
const isFocusable = (el: GElement) =>
	el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
	el.attributes?.has('tabindex') || el.attributes?.has('contenteditable');

/** The delegated type set lives natively (`setDelegatedEvents`) — dispatch
 *  attaches for every element at build, so no per-element listener op is ever
 *  emitted for a delegated type. Focus-scoped types (key/focus) are excluded:
 *  they keep their element marks because `needs_focus`/focus subscriptions
 *  read element.events. */
function emitDelegatedEvents() {
	emit(
		'setDelegatedEvents',
		[...delegatedTypes].filter((t) => !FOCUS_KEY_TYPES.has(t)).map(gpuixEvent),
	);
}

/** Svelte registers delegated listeners *after* the tree materializes —
 *  re-run what the registration changes on the existing tree. Non-focus types
 *  dispatch via the native delegated set (no per-element feed to backfill);
 *  focus/key types keep their element-scoped feed on focusables; press types
 *  re-run pressTarget for `el[eventsSymbol]` handlers stamped since. */
function backfillDelegated(type: string) {
	const pressType = PRESS_TARGET_EVENTS.has(type);
	const focusType = FOCUS_KEY_TYPES.has(type);
	if (!focusType && !pressType) return;
	const visit = (n: GNode) => {
		if (n.nodeType === 1) {
			const el = n as GElement;
			if (focusType && isFocusable(el)) emitListener(el, type);
			if (pressType) refreshPressTarget(el);
		}
		n.childNodes.forEach(visit);
	};
	visit(doc.documentElement);
	// secondary-window subtrees hang off `doc` beside documentElement —
	// a delegated type first used by a window-mounted component must reach them
	for (const root of windowRoots.values()) visit(root);
}

export class GNode {
	nodeType = 0;
	childNodes: GNode[] = [];
	parentNode: GNode | null = null;
	ownerDocument: GDocument | null = null;
	nativeId = 0;
	listeners: Map<string, Set<GEventListener>> | null = null;
	private _data = '';
	get data() {
		return this._data;
	}
	set data(v: string) {
		// DOM coerces — Svelte hands raw numbers here (`{count}` text nodes)
		// and a non-string would poison the whole native batch.
		this._data = String(v);
		if (this.nodeType !== 3) return;
		// inside an svg subtree the node stays inert — the host re-serializes
		if (svgHost(this)) { markSvgDirty(this); return; }
		if (this.nativeId) {
			emit('setText', this.nativeId, v);
			queueMutation({ type: 'characterData', target: this, addedNodes: [], removedNodes: [] });
		} else if (/\S/.test(v) && this.isConnected && this.parentNode?.nativeId) {
			// whitespace-only text materializes lazily — insert at next anchor
			materialize(this);
			if (this.nativeId) {
				const before = this.nextSibling ? nativeBeforeId(this.parentNode, this.nextSibling) : 0;
				if (before) emit('insertBefore', this.parentNode.nativeId, this.nativeId, before);
				else emit('appendChild', this.parentNode.nativeId, this.nativeId);
			}
		}
	}

	get firstChild(): GNode | null {
		return this.childNodes[0] ?? null;
	}
	get lastChild(): GNode | null {
		return this.childNodes[this.childNodes.length - 1] ?? null;
	}
	get nextSibling(): GNode | null {
		const p = this.parentNode;
		if (!p) return null;
		return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null;
	}
	get previousSibling(): GNode | null {
		const p = this.parentNode;
		if (!p) return null;
		return p.childNodes[p.childNodes.indexOf(this) - 1] ?? null;
	}
	get parentElement(): GElement | null {
		return this.parentNode?.nodeType === 1 ? (this.parentNode as GElement) : null;
	}
	get isConnected(): boolean {
		let n: GNode | null = this;
		while (n) {
			if (n.nodeType === 9) return true;
			n = n.parentNode;
		}
		return false;
	}
	get textContent(): string {
		if (this.nodeType === 3 || this.nodeType === 8) return this.data;
		return this.childNodes.map((c) => c.textContent).join('');
	}
	set textContent(v: string) {
		if ((this as { tagName?: string }).tagName === 'STYLE') parseStyleSheet(v);
		if (this.nodeType === 3 || this.nodeType === 8) {
			this.data = v;
			return;
		}
		for (const c of [...this.childNodes]) this.removeChild(c);
		if (v) this.appendChild(doc.createTextNode(v));
	}
	get nodeValue(): string | null {
		return this.nodeType === 3 || this.nodeType === 8 ? this.data : null;
	}
	set nodeValue(v: string | null) {
		// DOM: no-op on elements/documents
		if (this.nodeType === 3 || this.nodeType === 8) this.data = v ?? '';
	}

	appendChild<T extends GNode>(child: T): T {
		this.insertBefore(child, null);
		return child;
	}
	insertBefore<T extends GNode>(child: T, ref: GNode | null): T {
		if (child === ref) return child; // DOM no-op
		if (child.nodeType === 11) {
			for (const c of [...child.childNodes]) this.insertBefore(c, ref);
			return child;
		}
		// reparent: a materialized child keeps its native element (and its
		// state — scroll, focus, hover); a moveBefore op moves it natively.
		// Detach without dematerializing.
		const keepNative = !!child.nativeId && this.isConnected && !!this.nativeId;
		const oldParent = child.parentNode;
		if (oldParent) {
			const oi = oldParent.childNodes.indexOf(child);
			if (oi !== -1) oldParent.childNodes.splice(oi, 1);
			child.parentNode = null;
			queueMutation({ type: 'childList', target: oldParent, addedNodes: [], removedNodes: [child] });
			markSvgDirty(oldParent);
			if (!keepNative) dematerialize(child);
		}
		const idx = ref ? this.childNodes.indexOf(ref) : -1;
		if (ref && idx === -1) throw new Error('insertBefore: ref not a child');
		if (idx === -1) this.childNodes.push(child);
		else this.childNodes.splice(idx, 0, child);
		child.parentNode = this;
		child.ownerDocument = this.nodeType === 9 ? (this as unknown as GDocument) : this.ownerDocument;
		queueMutation({ type: 'childList', target: this, addedNodes: [child], removedNodes: [] });
		if (svgHost(this)) {
			// svg subtree — children stay DOM-inert; the host's `source` prop
			// carries the whole document, so the mutation just re-serializes.
			if (child.nativeId) dematerialize(child);
			markSvgDirty(this);
		} else if (this.isConnected && this.nativeId) {
			if (!keepNative) materialize(child);
			if (child.nativeId) {
				const before = ref ? nativeBeforeId(this, ref) : 0;
				if (keepNative && oldParent) {
					// The child kept its native id through the detach — this is
					// a reparent or same-parent reorder, not a fresh insert.
					// moveBefore relocates the live subtree (state, listeners,
					// focus) instead of destroy+recreate; null anchor = end.
					emit('moveBefore', this.nativeId, child.nativeId, before || null);
				} else if (before) emit('insertBefore', this.nativeId, child.nativeId, before);
				else emit('appendChild', this.nativeId, child.nativeId);
			}
		} else if (child.nativeId && oldParent) {
			dematerialize(child); // new parent can't host — no orphan natives
		}
		return child;
	}
	removeChild<T extends GNode>(child: T): T {
		const idx = this.childNodes.indexOf(child);
		if (idx === -1) throw new Error('removeChild: not a child');
		this.childNodes.splice(idx, 1);
		child.parentNode = null;
		queueMutation({ type: 'childList', target: this, addedNodes: [], removedNodes: [child] });
		markSvgDirty(this);
		dematerialize(child);
		return child;
	}
	replaceChild<T extends GNode>(next: GNode, child: T): T {
		this.insertBefore(next, child);
		this.removeChild(child);
		return child;
	}
	before(...nodes: (GNode | string)[]) {
		if (!this.parentNode) return;
		const d = this.ownerDocument ?? doc;
		for (const n of nodes) this.parentNode.insertBefore(typeof n === 'string' ? d.createTextNode(n) : n, this);
	}
	after(...nodes: (GNode | string)[]) {
		if (!this.parentNode) return;
		const d = this.ownerDocument ?? doc;
		const ref = this.nextSibling;
		for (const n of nodes) this.parentNode.insertBefore(typeof n === 'string' ? d.createTextNode(n) : n, ref);
	}
	append(...nodes: (GNode | string)[]) {
		for (const n of nodes) {
			this.appendChild(typeof n === 'string' ? doc.createTextNode(n) : n);
		}
	}
	prepend(...nodes: (GNode | string)[]) {
		const ref = this.firstChild;
		for (const n of nodes) {
			this.insertBefore(typeof n === 'string' ? doc.createTextNode(n) : n, ref);
		}
	}
	remove() {
		this.parentNode?.removeChild(this);
	}
	contains(other: GNode): boolean {
		for (let n: GNode | null = other; n; n = n.parentNode) if (n === this) return true;
		return false;
	}
	/** DOCUMENT_POSITION bitmask — enough for bind_group ordering (4 = other follows). */
	compareDocumentPosition(other: GNode): number {
		if (other === this) return 0;
		if (this.contains(other)) return 8 | 2; // CONTAINED_BY | PRECEDING… actually other is inside this → 10
		if (other.contains(this)) return 16 | 4; // CONTAINS | FOLLOWING → 20
		const order = new Map<GNode, number>();
		let i = 0;
		const walk = (n: GNode) => {
			order.set(n, i++);
			n.childNodes.forEach(walk);
		};
		walk(this.getRootNode());
		return (order.get(this) ?? 0) < (order.get(other) ?? 0) ? 4 : 2;
	}
	getRootNode(): GNode {
		let n: GNode = this;
		while (n.parentNode) n = n.parentNode;
		return n;
	}
	cloneNode(deep: boolean): GNode {
		const c = this.cloneShallow();
		if (deep) for (const ch of this.childNodes) c.appendChild(ch.cloneNode(true));
		return c;
	}
	cloneShallow(): GNode {
		const c = new GNode();
		c.nodeType = this.nodeType;
		c.data = this.data;
		return c;
	}
	addEventListener(type: string, fn: EventListener) {
		(this.listeners ??= new Map()).get(type) ?? this.listeners!.set(type, new Set());
		this.listeners!.get(type)!.add(fn as unknown as GEventListener);
		if (this.nodeType === 1) {
			emitListener(this as unknown as GElement, type);
			refreshPressTarget(this as unknown as GElement);
		}
	}
	removeEventListener(type: string, fn: EventListener) {
		const set = this.listeners?.get(type);
		if (!set?.delete(fn as unknown as GEventListener)) return;
		// drop the emptied slot — a bare key still reads as "has listeners
		// of this type" to isPressTarget and the feed check below
		if (set.size === 0) {
			this.listeners!.delete(type);
			// last listener of this type removed → tell native to stop sending
			// it — a stale listener keeps the subtree non-memoizable and keeps
			// firing TSFN callbacks for events nobody handles. Registration
			// shipped the *gpuix* name (mousedown→mouseDown…) — emit that.
			if (
				this.nativeId &&
				(this.nodeType !== 1 || !listenerFeedClaimed(this as unknown as GElement, type))
			) {
				emit('setEventListener', this.nativeId, gpuixEvent(type), false);
				registeredEvents.get(this.nativeId)?.delete(type);
			}
		}
		if (this.nodeType === 1) refreshPressTarget(this as unknown as GElement);
	}
	dispatchEvent(event: GEvent | GEventBase): boolean {
		// GEventBase is structurally a GEvent at runtime — the interface's
		// index signature and non-null target are declaration-side only.
		const ev = event as GEvent;
		if (!ev.target) (ev as { target: GNode }).target = this;
		for (let n: GNode | null = this; n && !ev.cancelBubble; n = n.parentNode) {
			ev.currentTarget = n;
			n.listeners?.get(ev.type)?.forEach((fn) => {
				if (!ev._stopped) fn.call(n, ev);
			});
			if (n.nodeType === 9 || (ev.bubbles === false && n !== this)) break;
		}
		ev.currentTarget = undefined;
		return !ev.defaultPrevented;
	}
}

export class GText extends GNode {
	override nodeType = 3;
	constructor(data = '') {
		super();
		this.data = data;
	}
	override cloneShallow() {
		const c = new GText(this.data);
		c.ownerDocument = this.ownerDocument;
		return c as GNode;
	}
}

export class GComment extends GNode {
	override nodeType = 8;
	constructor(data = '') {
		super();
		this.data = data;
	}
	override cloneShallow() {
		const c = new GComment(this.data);
		c.ownerDocument = this.ownerDocument;
		return c as GNode;
	}
}

export class GFragment extends GNode {
	override nodeType = 11;
	override cloneShallow() {
		const c = new GFragment();
		c.ownerDocument = this.ownerDocument;
		return c as GNode;
	}
}

export class GStyle {
	props = new Map<string, string>();
	node: GElement;
	constructor(node: GElement) {
		this.node = node;
		return new Proxy(this, {
			set(t, k, v) {
				if (k === 'cssText') {
					t.cssText = v;
					return true;
				}
				if (typeof k === 'string' && !k.startsWith('_') && !(k in t)) {
					// CSSOM: assigning ''/null/undefined removes the declaration
					// (browsers ignore invalid values outright — we must not let
					// the literal strings 'undefined'/'null' reach the renderer).
					if (v === '' || v === null || v === undefined) t.props.delete(k);
					else t.props.set(k, String(v));
					t.push();
					return true;
				}
				(t as any)[k] = v;
				return true;
			},
			get(t, k) {
				if (k in t) return (t as any)[k];
				// CSSStyleDeclaration reads unset properties as '' — svelte
				// captures el.style.overflow and restores it verbatim; ''
				// round-trips through the setter as a removal.
				return t.props.get(k as string) ?? '';
			},
		});
	}
	get cssText(): string {
		return [...this.props].map(([k, v]) => `${camelToKebab(k)}: ${v}`).join('; ');
	}
	set cssText(v: string) {
		this.props.clear();
		for (const decl of v.split(';')) {
			const i = decl.indexOf(':');
			if (i === -1) continue;
			const raw = decl.slice(0, i).trim();
			const key = raw.startsWith('--') ? raw : kebabToCamel(raw);
			const val = decl.slice(i + 1).trim();
			if (key && val) this.props.set(key, val);
		}
		this.push();
	}
	setProperty(k: string, v: string) {
		this.props.set(k.startsWith('--') ? k : kebabToCamel(k), v);
		this.push();
	}
	getPropertyValue(k: string) {
		return this.props.get(k.startsWith('--') ? k : kebabToCamel(k)) ?? '';
	}
	removeProperty(k: string) {
		this.props.delete(k.startsWith('--') ? k : kebabToCamel(k));
		this.push();
	}
	push() {
		if (this.node.nativeId) {
			emit('setStyle', this.node.nativeId, nativeStyleFor(this.node));
		}
	}
}

function kebabToCamel(s: string) {
	return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
function camelToKebab(s: string) {
	return s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}
/** gpuix's dimension parser accepts numbers, numeric strings, `N%` and
 *  `auto` — nothing else. One bad value rejects the whole batch, so every
 *  dimension-looking value is converted or the prop is dropped. */
const DIM = /^(-?[\d.]+)([a-z%]*)$/;
function toDimension(v: string): number | string | null {
	if (v === 'auto') return 'auto';
	const m = DIM.exec(v);
	if (!m?.[1]) return null;
	const f = parseFloat(m[1]);
	const u = m[2];
	if (!u || u === 'px') return f;
	if (u === '%') return `${f}%`;
	if (u === 'rem' || u === 'em') return f * 16;
	// viewport units resolve against the native window, not the parent —
	// 100svh means viewport height even when ancestors are content-sized
	if (/v[hw]$/.test(u)) {
		const base = u.endsWith('h') ? viewport.h : viewport.w;
		return base ? (f / 100) * base : `${f}%`;
	}
	return null; // ch/ex/lh/fr/cq* — no equivalent
}

let viewport = { w: 0, h: 0 };
/** Sync the native window size so vh/vw units resolve to real px. */
export function setViewport(w: number, h: number) {
	viewport = { w, h };
	const g = globalThis as any;
	if (g.window) {
		g.window.innerWidth = w;
		g.window.innerHeight = h;
	}
}
// native polls getWindowSize each frame → resize keeps innerWidth/vh honest
nativeBridge.setWindowSizeSink(setViewport);

/** minimal calc() evaluator — single-unit arithmetic only (px-family or %). */
function evalCalc(expr: string): number | string | null {
	const inner = expr.trim().replace(/^calc\(|\)$/g, '');
	const toks = inner.match(/-?[\d.]+[a-z%]*|[()+\-*/]/g);
	if (!toks) return null;
	let pos = 0;
	const peek = () => toks[pos];
	type Val = { n: number; unit: string };
	const term = (): Val | null => {
		let v = factor();
		while (peek() === '*' || peek() === '/') {
			const op = toks[pos++];
			const r = factor();
			if (!v || !r) return null;
			if (r.unit && v.unit && r.unit !== v.unit) return null;
			const unit = v.unit || r.unit;
			v = { n: op === '*' ? v.n * r.n : v.n / r.n, unit };
		}
		return v;
	};
	const factor = (): Val | null => {
		if (peek() === '(') {
			pos++;
			const v = expr_();
			if (peek() !== ')') return null;
			pos++;
			return v;
		}
		const t = toks[pos++];
		if (t == null) return null;
		const m = DIM.exec(t);
		if (!m?.[1]) return null;
		const f = parseFloat(m[1]);
		const u = m[2];
		if (!u || u === 'px') return { n: f, unit: 'px' };
		if (u === 'rem' || u === 'em') return { n: f * 16, unit: 'px' };
		if (u === '%' || /^(s|l|d)?v[hw]$/.test(u)) return { n: f, unit: '%' };
		return null;
	};
	const expr_ = (): Val | null => {
		let v = term();
		while (peek() === '+' || peek() === '-') {
			const op = toks[pos++];
			const r = term();
			if (!v || !r || v.unit !== r.unit) return null;
			v = { n: op === '+' ? v.n + r.n : v.n - r.n, unit: v.unit };
		}
		return v;
	};
	const v = expr_();
	if (!v || pos !== toks.length) return null;
	return v.unit === '%' ? `${v.n}%` : v.n;
}

/** values we know the native style parser will reject outright */
const UNSAFE_VALUE = /\b(var|calc\([^)]*[a-z%]+\s*[-+]\s*|gradient|conic|url|clamp|min|max|mix|attr|env|color-mix)\s*\(|oklch\s+from/;

/** css 1–4-value box shorthands → per-direction props (top,right,bottom,left) */
const BOX_SHORTHAND: Record<string, string[]> = {
	padding: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
	margin: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'],
	inset: ['top', 'right', 'bottom', 'left'],
	borderWidth: ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'],
	borderRadius: ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'],
};

/** props whose native type is a bare f64 — `%`/`auto`/keywords must be dropped,
 *  not passed through (a wrong type rejects the whole batch). */
const NUMBER_PROP = new Set([
	'fontSize', 'lineHeight', 'opacity', 'flexGrow', 'flexShrink', 'flexBasis',
	'gap', 'rowGap', 'columnGap', 'padding', 'paddingTop', 'paddingRight',
	'paddingBottom', 'paddingLeft', 'margin', 'marginTop', 'marginRight',
	'marginBottom', 'marginLeft', 'top', 'right', 'bottom', 'left',
	'borderWidth', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth',
	'borderLeftWidth', 'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius',
	'borderBottomRightRadius', 'borderBottomLeftRadius', 'lineClamp',
	'gridTemplateColumns', 'gridTemplateRows', 'zIndex',
]);
/** props accepting a DimensionValue (number | numeric | `N%` | `auto`) */
const DIM_PROP = new Set([
	'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
]);
/** css logical props → physical props gpuix understands */
const LOGICAL_PROP: Record<string, string[]> = {
	insetBlock: ['top', 'bottom'],
	insetBlockStart: ['top'],
	insetBlockEnd: ['bottom'],
	insetInline: ['left', 'right'],
	insetInlineStart: ['left'],
	insetInlineEnd: ['right'],
	paddingBlock: ['paddingTop', 'paddingBottom'],
	paddingInline: ['paddingLeft', 'paddingRight'],
	marginBlock: ['marginTop', 'marginBottom'],
	marginInline: ['marginLeft', 'marginRight'],
	borderBlockWidth: ['borderTopWidth', 'borderBottomWidth'],
	borderInlineWidth: ['borderLeftWidth', 'borderRightWidth'],
	borderBlockColor: ['borderTopColor', 'borderBottomColor'],
	borderInlineColor: ['borderLeftColor', 'borderRightColor'],
	borderStartStartRadius: ['borderTopLeftRadius'],
	borderStartEndRadius: ['borderTopRightRadius'],
	borderEndStartRadius: ['borderBottomLeftRadius'],
	borderEndEndRadius: ['borderBottomRightRadius'],
};

function toNumber(v: string | undefined): number | null {
	if (v === undefined) return null;
	const d = /^calc\(/.test(v) ? evalCalc(v) : toDimension(v);
	return typeof d === 'number' ? d : null;
}

/** whitespace split that keeps functional values whole — `calc(0.25rem * 2)`
 *  is one component, `10px 16px` is two. */
function splitCssComponents(v: string): string[] {
	const parts: string[] = [];
	let depth = 0, cur = '';
	for (const ch of v) {
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		if (/\s/.test(ch) && depth === 0) {
			if (cur) parts.push(cur);
			cur = '';
		} else cur += ch;
	}
	if (cur) parts.push(cur);
	return parts;
}

function styleObject(props: Map<string, string>) {
	const out: Record<string, unknown> = {};
	// element-scoped custom props (--card-spacing on .cn-card, etc.) resolve
	// against the element's own prop map; globals were already baked by theme.ts
	const localVar = (v: string, depth = 0): string =>
		depth > 4
			? v
			: v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (m, k, fb) => {
					const own = props.get(k);
					if (own != null) return localVar(own, depth + 1);
					return fb ?? m;
				});
	for (const [k, v0] of props) {
		if (k.startsWith('--')) continue; // custom props exist only as var() sources
		const v = localVar(String(v0).trim());
		const box = BOX_SHORTHAND[k];
		if (box) {
			// paren-aware split: calc()/var() internals keep their spaces
			const parts = splitCssComponents(v);
			if (parts.length >= 1 && parts.length <= 4) {
				const vals = [
					parts[0],
					parts[1] ?? parts[0],
					parts[2] ?? parts[0],
					parts[3] ?? parts[1] ?? parts[0],
				].map(toNumber);
				if (vals.every((x) => x !== null)) {
					box.forEach((key, i) => (out[key] = vals[i]));
				}
			}
			continue;
		}
		if (k === 'gap') {
			const [a, b] = splitCssComponents(v);
			const r = toNumber(a);
			const c = toNumber(b ?? a);
			if (r !== null) out.rowGap = r;
			if (c !== null) out.columnGap = c;
			continue;
		}
		if (k === 'flex') {
			// flex: <grow> [<shrink> [<basis>]] | none | auto | initial
			const p = splitCssComponents(v);
			if (p[0] === 'none') { out.flexGrow = 0; out.flexShrink = 0; }
			else if (p[0] === 'auto') { out.flexGrow = 1; out.flexShrink = 1; }
			else {
				const g = parseFloat(p[0] ?? '');
				if (!Number.isNaN(g)) {
					out.flexGrow = g;
					out.flexShrink = p[1] != null ? parseFloat(p[1]) || 1 : 1;
					if (p[2] != null) {
						const b = toNumber(p[2]);
						if (b !== null) out.flexBasis = b;
					}
				}
			}
			continue;
		}
		if (k === 'overflow' || k === 'overflowX' || k === 'overflowY') {
			// gpuix's scrollable literal is "scroll"; css "auto" means the same
			const map = (s: string | undefined) => (s === 'auto' ? 'scroll' : s);
			if (k === 'overflow') {
				const [x, y] = splitCssComponents(v);
				out.overflowX = map(x);
				out.overflowY = map(y ?? x);
			} else {
				out[k] = map(v);
			}
			continue;
		}
		if (k === 'border') {
			const m = /^(\S+)\s+(?:solid|dashed|dotted|double)\s*(.*)$/.exec(v);
			if (m) {
				const w = toNumber(m[1]);
				if (w !== null) out.borderWidth = w;
				if (m[2]) out.borderColor = m[2];
			}
			continue;
		}
		if (k === 'gridTemplateColumns' || k === 'gridTemplateRows') {
			// repeat(N, ...) → N ; bare number → N ; anything else → drop
			const rep = /^repeat\(\s*(\d+)/.exec(v)?.[1];
			const n = rep !== undefined ? +rep : toNumber(v);
			if (n !== null && n > 0) out[k] = n;
			continue;
		}
		if (k === 'boxShadow') {
			// comma-separated layers (rgba() has commas → split paren-aware);
			// gpuix paints one — take the first layer that isn't transparent
			let depth = 0, cur = '';
			const layers: string[] = [];
			for (const ch of v) {
				if (ch === '(') depth++;
				else if (ch === ')') depth--;
				if (ch === ',' && depth === 0) { layers.push(cur); cur = ''; }
				else cur += ch;
			}
			layers.push(cur);
			for (const layer of layers) {
				const m = /^\s*(inset\s+)?(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?(?:\s+([\d.]+)(?:px)?)?(?:\s+(-?[\d.]+)(?:px)?)?\s+(.+?)\s*$/.exec(layer);
				const color = m?.[6];
				if (m && m[2] !== undefined && m[3] !== undefined && color !== undefined && !/#0{4}|#0000|transparent/i.test(color)) {
					out.boxShadow = {
						inset: !!m[1], offsetX: +m[2], offsetY: +m[3],
						blurRadius: +(m[4] ?? 0), spreadRadius: +(m[5] ?? 0), color,
					};
					break;
				}
			}
			continue;
		}
		if (k === 'fontFamily') {
			// 'Inter', ui-sans-serif, system-ui → first usable family name
			const first = v.split(',')[0]?.trim().replace(/^["']|["']$/g, '');
			if (first) out[k] = first;
			continue;
		}
		if (k === 'letterSpacing' || k === 'wordSpacing') {
			const n = toNumber(v);
			if (n !== null) out[k] = n;
			continue;
		}
		const logical = LOGICAL_PROP[k];
		if (logical) {
			// logical props take 1–2 values: all | start,end
			const [a, b] = splitCssComponents(v);
			const ends = [a, b ?? a];
			logical.forEach((key, i) => {
				const n = toNumber(ends[Math.min(i, ends.length - 1)]);
				if (n !== null) out[key] = n;
			});
			continue;
		}
		if (NUMBER_PROP.has(k)) {
			const n = toNumber(v);
			if (n !== null) out[k] = n;
			continue;
		}
		if (DIM_PROP.has(k)) {
			const d = /^calc\(/.test(v) ? evalCalc(v) : toDimension(v);
			if (d !== null) out[k] = d;
			else if (/^(fit-content|min-content|max-content|stretch)$/.test(v)) out[k] = 'auto';
			continue;
		}
		// css-wide keywords rely on the cascade — nothing to inherit from
		if (/^(inherit|initial|unset|revert|revert-layer)$/.test(v)) continue;
		if (UNSAFE_VALUE.test(v)) continue; // can't represent → drop the prop
		out[k] = v; // colors, enums, font stacks — the parser is lenient here
	}
	// css unitless line-height is a font-size multiplier; gpuix wants px
	if (typeof out.lineHeight === 'number' && out.lineHeight > 0 && out.lineHeight < 8) {
		out.lineHeight = Math.round(out.lineHeight * (out.fontSize as number || 16) * 100) / 100;
	}
	return out;
}

/** tags whose children are phrasing content — browsers lay these out inline. */
const INLINE_FLOW = new Set(
	'p,h1,h2,h3,h4,h5,h6,span,code,em,strong,a,li,tr,blockquote,td,th,small,label,b,i,u,s,mark,kbd,cite,q,abbr,sub,sup,del,ins,button,figcaption,summary,legend'.split(
		',',
	),
);
/**
 * gpuix has no inline layout — every container is a flex box. For text-level
 * elements the closest approximation is a wrapping row: text runs and inline
 * chips then flow left-to-right instead of stacking as full-width lines.
 */
/** text props inherit down the tree in real CSS — our flat model has no
 * cascade, so resolve them by walking ancestors at push time. */
const INHERITABLE = [
	'color', 'fontSize', 'fontFamily', 'fontWeight', 'lineHeight',
	'textAlign', 'fontStyle', 'letterSpacing', 'whiteSpace',
];
/** field → StyleProps vocabulary keys, in lookup order. The token value
 *  crosses as-is — it resolves against the *child's* theme chain natively,
 *  which is what a ctx `color-*` ref wants. */
const INHERITABLE_RAW: Record<string, string[]> = {
	color: ['fg', 'color'],
	fontSize: ['text', 'fontSize'],
	fontFamily: ['font', 'fontFamily'],
	fontWeight: ['fontW', 'fontWeight'],
	lineHeight: ['lineHeight'],
	textAlign: ['align', 'textAlign'],
	fontStyle: ['fontStyle', 'italic'],
	letterSpacing: ['tracking', 'letterSpacing'],
	whiteSpace: ['whitespace', 'whiteSpace'],
};
/** Read an inheritable field out of a parent's raw-props envelope — last
 *  fragment wins; a `@desc` member is already field-shaped. */
function inheritableFromEnv(env: { __frags?: unknown[] } | null, field: string): unknown {
	const keys = INHERITABLE_RAW[field];
	if (!env?.__frags || !keys) return undefined;
	for (let i = env.__frags.length - 1; i >= 0; i--) {
		const frag = env.__frags[i] as Record<string, any>;
		if (frag == null || typeof frag !== 'object') continue;
		const desc = frag['@desc'] as Record<string, unknown> | undefined;
		if (desc?.[field] !== undefined) return desc[field];
		for (const k of keys) {
			let v = frag[k];
			if (v === undefined) continue;
			if (k === 'italic') v = v === true ? 'italic' : 'normal';
			return v;
		}
	}
	return undefined;
}
function nativeStyleFor(el: GElement) {
	const props = el.mergedStyleProps();
	// svg root: `width`/`height` are presentation attributes — they size the
	// element box at lowest cascade priority (style/class props win).
	if (el.tagName === 'SVG') {
		for (const k of ['width', 'height'] as const) {
			if (props.has(k)) continue;
			const v = el.attributes.get(k);
			if (v) props.set(k, v);
		}
	}
	const out = styleObject(props);
	// kit lane: pre-resolved native props (incl. hover/active sub-styles) win
	// over css-derived values and skip the string->native conversion entirely
	if (el._nativeStyle) Object.assign(out, el._nativeStyle);
	for (const k of INHERITABLE) {
		if (out[k] !== undefined && out[k] !== 'inherit') continue;
		for (let p = el.parentNode; p; p = p.parentNode) {
			if (p.nodeType !== 1) continue;
			const pe = p as GElement;
			const nv = pe._nativeStyle?.[k] ?? inheritableFromEnv(pe._nativeEnv, k);
			if (nv !== undefined && nv !== 'inherit') {
				out[k] = nv;
				break;
			}
			const pv = pe.mergedStyleProps().get(k);
			if (pv !== undefined && pv !== 'inherit') {
				const conv = styleObject(new Map([[k, pv]]));
				if (conv[k] !== undefined) {
					out[k] = conv[k];
					break;
				}
			}
		}
	}
	const d = out.display;
	if (out.flexDirection || d === 'none' || d === 'contents' || d === 'grid') return out;
	if (INLINE_FLOW.has(el.tagName.toLowerCase()) || d === 'inline' || d === 'inline-block') {
		out.display = 'flex';
		out.flexDirection = 'row';
		out.flexWrap = 'wrap';
	}
	return out;
}

// ── MutationObserver-lite ─────────────────────────────────────────────

type MutationRecord = {
	type: 'childList' | 'attributes' | 'characterData';
	target: GNode;
	addedNodes: GNode[];
	removedNodes: GNode[];
	attributeName?: string;
	oldValue?: string | null;
};

// DOM-lib shapes the ESNext lib doesn't provide — Bun supplies the runtime
// globals; these declare the types locally so the module stays DOM-free.
interface MutationObserverInit {
	childList?: boolean;
	subtree?: boolean;
	attributes?: boolean;
	characterData?: boolean;
	attributeFilter?: string[];
	attributeOldValue?: boolean;
	characterDataOldValue?: boolean;
}
type FrameRequestCallback = (time: number) => void;
declare function requestAnimationFrame(cb: FrameRequestCallback): number;
interface Animation {
	playState: 'idle' | 'running' | 'paused' | 'finished';
	currentTime: number;
	playbackRate: number;
	finished: Promise<Animation>;
	onfinish: (() => void) | null;
	play(): void;
	pause(): void;
	cancel(): void;
	finish(): void;
	persist(): void;
}

const observers: { cb: (r: MutationRecord[]) => void; target: GNode; opts: MutationObserverInit }[] = [];
let mutationQueue: MutationRecord[] = [];
let mutationFlushScheduled = false;

function queueMutation(rec: MutationRecord) {
	mutationQueue.push(rec);
	if (!mutationFlushScheduled) {
		mutationFlushScheduled = true;
		setTimeout(() => {
			mutationFlushScheduled = false;
			const records = mutationQueue;
			mutationQueue = [];
			for (const o of observers) {
				const matched = records.filter((r) => {
					if (!o.opts.subtree && r.target !== o.target) return false;
					if (!isDescendantOrSelf(r.target, o.target)) return false;
					if (r.type === 'childList' && o.opts.childList === false) return false;
					if (r.type === 'attributes' && !o.opts.attributes) return false;
					if (r.type === 'characterData' && !o.opts.characterData) return false;
					return true;
				});
				if (matched.length) o.cb(matched);
			}
		}, 0);
	}
}

function isDescendantOrSelf(n: GNode, root: GNode): boolean {
	for (let p: GNode | null = n; p; p = p.parentNode) if (p === root) return true;
	return false;
}

class GMutationObserver {
	cb: (records: MutationRecord[]) => void;
	opts: MutationObserverInit = { childList: true, subtree: false, attributes: false, characterData: false };
	target: GNode | null = null;
	constructor(cb: (records: MutationRecord[]) => void) {
		this.cb = cb;
	}
	observe(target: GNode, opts: MutationObserverInit = {}) {
		this.target = target;
		this.opts = { childList: true, subtree: false, attributes: false, characterData: false, ...opts };
		observers.push(this as unknown as (typeof observers)[0]);
	}
	disconnect() {
		const i = observers.indexOf(this as unknown as (typeof observers)[0]);
		if (i >= 0) observers.splice(i, 1);
	}
	takeRecords() {
		return [];
	}
}

// ── ResizeObserver-lite (polls bounds from the native automation tree) ──

class GResizeObserver {
	cb: (entries: { target: GElement }[]) => void;
	observed = new Set<GElement>();
	timer: ReturnType<typeof setInterval> | null = null;
	last = new Map<GElement, string>();
	constructor(cb: (entries: { target: GElement }[]) => void) {
		this.cb = cb;
	}
	observe(el: GElement) {
		this.observed.add(el);
		if (!this.timer) {
			this.timer = setInterval(() => {
				for (const el of this.observed) {
					const b = el.getBoundingClientRect();
					const key = `${b.width}x${b.height}`;
					if (this.last.get(el) !== key) {
						this.last.set(el, key);
						this.cb([{ target: el }]);
					}
				}
			}, 100);
		}
	}
	unobserve(el: GElement) {
		this.observed.delete(el);
	}
	disconnect() {
		this.observed.clear();
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}

export class GElement extends GNode {
	override nodeType = 1;
	tagName: string;
	/** Authored tag case — tagName is DOM-uppercased, but svg markup
	 *  serializes with the original spelling (`linearGradient`, `clipPath`…). */
	_localTag: string;
	namespaceURI = HTML_NS;
	attributes: Map<string, string>;
	style: GStyle;
	_className = '';
	/** Last class string shipped to the native peer — a fresh native element
	 *  starts blank, so the first non-empty class always emits. */
	_sentClass = '';
	/** style props derived from scoped-CSS class rules — merged under inline props */
	_classProps = new Map<string, string>();
	/** Declared CSS `animation:` lowered onto animate() — reconciled whenever
	 *  classes or sheets change; the sig guards against re-spawning per class
	 *  write. */
	_cssAnim: { cancel(): void } | null = null;
	_cssAnimSig = '';
	/** Running element.animate() handles — cancel all on dematerialize. */
	_liveAnims?: Set<{ cancel(): void }>;
	/** kit lane: resolved native StyleDesc — wins over css-derived props */
	_nativeStyle: Record<string, unknown> | null = null;
	/** kit lane native envelope — raw StyleProps fragments + recipe binding,
	 *  shipped via setStyleProps/setRecipe; Rust owns mapping + resolution. */
	_nativeEnv: { __frags?: unknown[]; __ctx?: unknown } | null = null;
	/** applyNativeStyle set the `color` custom prop — it owns removing it. */
	_ctxColorOwned = false;
	/** `data-color` attr's value — dormant while the env lane owns `color`,
	 *  restored on release. */
	private _attrColor: string | undefined;
	/** interaction state for :hover/:focus/:active class rules */
	_hovered = false;
	_focused = false;
	_active = false;
	/** true when this element can match a :hover/:focus/:active class rule —
	 *  gates the pointer-event listener emission that kills memoization */
	_hasStateRule = false;
	/** Multi-window marker set by createWindowRoot — materializeRoot emits it
	 *  as setRoot's trailing arg; undefined → the primary window (0). */
	__windowId?: number;
	/** Mount-target marker set by materializeRoot — hosts Svelte's delegated
	 *  handle_event_propagation listeners; pressTarget must not mark it. */
	__isMountRoot?: boolean;
	constructor(tag: string) {
		super();
		this.tagName = tag.toUpperCase();
		this._localTag = tag;
		this.attributes = new GAttrs(this);
		this.style = new GStyle(this);
	}
	get nodeName() {
		return this.tagName;
	}
	get className() {
		return this._className;
	}
	set className(v: string) {
		this._className = v ?? '';
		this.attributes.set('class', this._className); this._rawAttrs?.delete('class');
		this.pushClass();
		applyClassStyles(this);
	}
	/** Ship the effective class string to the native stylesheet engine —
	 *  deduped against what the element's native peer last received, so a
	 *  no-change write doesn't re-run selector matching per flush. Every class
	 *  mutation funnels here: className, classList (via the setter),
	 *  setAttribute('class'), removeAttribute('class'), and materialize. */
	pushClass() {
		if (this.nativeId && this._sentClass !== this._className) {
			this._sentClass = this._className;
			emit('setClass', this.nativeId, this._className);
		}
	}
	get dataset(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [k, v] of this.attributes) {
			if (!k.startsWith('data-')) continue;
			const key = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
			out[key] = v;
		}
		return out;
	}
	get classList() {
		const el = this;
		const set = () => new Set(el._className.split(/\s+/).filter(Boolean));
		const commit = (s: Set<string>) => {
			el.className = [...s].join(' '); // through the setter: attrs + class styles
		};
		return {
			add: (...cs: string[]) => {
				const s = set();
				cs.forEach((c) => s.add(c));
				commit(s);
			},
			remove: (...cs: string[]) => {
				const s = set();
				cs.forEach((c) => s.delete(c));
				commit(s);
			},
			contains: (c: string) => set().has(c),
			toggle: (c: string, force?: boolean) => {
				const s = set();
				const want = force ?? !s.has(c);
				if (want === s.has(c)) return want;
				if (want) s.add(c);
				else s.delete(c);
				commit(s);
				return want;
			},
			replace: (a: string, b: string) => {
				const s = set();
				if (!s.has(a)) return false;
				s.delete(a);
				s.add(b);
				commit(s);
				return true;
			},
			get value() {
				return el._className;
			},
			get length() {
				return set().size;
			},
		};
	}
	get innerHTML(): string {
		return this.childNodes.map(serializeNode).join('');
	}
	set innerHTML(html: string) {
		const target = this.tagName === 'TEMPLATE' ? this.content : this;
		for (const c of [...target.childNodes]) target.removeChild(c);
		for (const n of parseHTML(html, this.ownerDocument ?? doc)) target.appendChild(n);
	}
	get outerHTML(): string {
		return serializeNode(this);
	}
	get content(): GFragment {
		let f = (this as any)._content;
		if (!f) {
			f = new GFragment();
			f.ownerDocument = this.ownerDocument;
			(this as any)._content = f;
		}
		return f;
	}
	/** Structured native props (anchored position, motion, theme objects…) —
	 *  attributes stringify, so non-string props go through this channel. */
	_customProps: Map<string, unknown> | null = null;
	/** Non-string attribute values (theme={…} decls) — the attributes map is
	 *  string-typed by DOM semantics; the custom-prop lane needs the object. */
	_rawAttrs: Map<string, unknown> | null = null;
	/** nkit style lane via spread — `<div {...card.style}>` lands here as a
	 *  property set (svelte's setter walk picks the setter for non-string
	 *  values); a `null` retraction arrives through removeAttribute. Routes
	 *  into applyNativeStyle — the same lane `use:applyStyle` drives, so the
	 *  two forms compose freely. */
	get styleProps(): Record<string, unknown> | null {
		return (this._nativeEnv ?? this._nativeStyle) as Record<string, unknown> | null;
	}
	set styleProps(v: unknown) {
		applyNativeStyle(this, v as Record<string, unknown> | null);
	}
	setCustomProp(k: string, v: unknown) {
		const props = (this._customProps ??= new Map());
		// identical re-emits still mark the element dirty natively — a `color`
		// or `theme` prop re-send would re-resolve the whole subtree per flush.
		if (props.get(k) === v) return;
		props.set(k, v);
		if (this.nativeId) emit('setCustomProp', this.nativeId, k, v);
	}
	removeCustomProp(k: string) {
		if (!this._customProps?.delete(k)) return;
		if (this.nativeId) emit('setCustomProp', this.nativeId, k, null);
	}
	setAttribute(k: string, v: string) {
		// `styleProps` is a property channel, not an attribute — hand-written
		// setAttribute calls route the same way the spread prop does. Objects
		// and the callable envelope attach; a string isn't a style → clears.
		if (k === 'styleProps') { this.styleProps = typeof v === 'object' || typeof v === 'function' ? v : null; return; }
		const old = this.attributes.get(k) ?? null;
		this.attributes.set(k, String(v));
		// Non-string attrs (theme={…} decl objects…) keep their raw value for
		// the custom-prop lane — the attributes map is string-typed by DOM
		// semantics, the native prop needs the object.
		if (v !== null && typeof v === 'object') (this._rawAttrs ??= new Map()).set(k, v);
		else this._rawAttrs?.delete(k);
		queueMutation({ type: 'attributes', target: this, addedNodes: [], removedNodes: [], attributeName: k, oldValue: old });
		if (k === 'class') this.className = typeof v === 'string' ? v : String(v ?? '');
		else if (k === 'style') {
			// object form: a native envelope routes the props lane; a plain
			// object is DOM style-object semantics (style={{color:'red'}})
			if (v !== null && typeof v === 'object') {
				if ((v as { __native?: boolean }).__native === true) this.styleProps = v;
				else for (const sk in v) (this.style as unknown as Record<string, unknown>)[sk] = (v as Record<string, unknown>)[sk];
			} else this.style.cssText = v;
		}
		else applyClassStyles(this); // [data-*]/[aria-*] rule conditions may flip
		// press-target inputs: role swaps, type/href flip implicit roles
		if (k === 'role' || k === 'contenteditable' || k === 'type' || k === 'href') refreshPressTarget(this);
		// `data-color`/`theme` are ctx-cascade props — they ride the
		// custom-prop ledger (dedup + replay + the env-lane ownership
		// handshake), not a raw emit. Ledger writes record pre-materialize
		// too; the replay covers them.
		const nk = nativeAttrName(k);
		if (k === 'data-color') {
			this._attrColor = v == null ? undefined : String(v);
			if (!this._ctxColorOwned) {
				if (this._attrColor === undefined) this.removeCustomProp(nk);
				else this.setCustomProp(nk, this._attrColor);
			}
			return;
		}
		if (nk === 'theme') {
			this.setCustomProp(nk, this._rawAttrs?.get(k) ?? nativeAttrValue(k, v));
			return;
		}
		if (!this.nativeId) return;
		if (k !== 'class' && k !== 'style') {
			emit('setCustomProp', this.nativeId, nk, this._rawAttrs?.get(k) ?? nativeAttrValue(k, v));
			if ((k === 'type' || k === 'href') && !this.attributes.has('role')) {
				const role = implicitRole(this);
				if (role) emit('setCustomProp', this.nativeId, 'role', role);
			}
		}
	}
	getAttribute(k: string) {
		return this.attributes.get(k) ?? null;
	}
	hasAttribute(k: string) {
		return this.attributes.has(k);
	}
	removeAttribute(k: string) {
		// svelte retracts a spread `styleProps` through removeAttribute — the
		// setter's `null` clears both native layers like applyStyle's destroy.
		if (k === 'styleProps') { this.styleProps = null; return; }
		const old = this.attributes.get(k) ?? null;
		this.attributes.delete(k);
		this._rawAttrs?.delete(k);
		queueMutation({ type: 'attributes', target: this, addedNodes: [], removedNodes: [], attributeName: k, oldValue: old });
		if (k === 'class') {
			this._className = '';
			this.pushClass();
			applyClassStyles(this);
		} else if (k === 'style') {
			this.style.props.clear();
			this.style.push();
		} else {
			applyClassStyles(this);
		}
		if (k === 'role' || k === 'contenteditable' || k === 'type' || k === 'href') refreshPressTarget(this);
		const nk = nativeAttrName(k);
		if (k === 'data-color') {
			this._attrColor = undefined;
			if (!this._ctxColorOwned) this.removeCustomProp(nk);
			return;
		}
		if (this._customProps?.has(nk)) {
			// ledger-owned keys (theme, color…) retract through it — the raw
			// null-emit would clear the lane while the ledger still replays
			// the value on rematerialize.
			this.removeCustomProp(nk);
			return;
		}
		if (this.nativeId) {
			// class/style aren't custom props — setAttribute already skips them
			// here ('class' has its own setClass op; 'style' pushed via setStyle).
			// The wire name is the *native* name — a raw `tabindex` removal would
			// leave `tabIndex` set forever.
			if (k !== 'class' && k !== 'style') {
				emit('setCustomProp', this.nativeId, nk, null);
			}
			if (k === 'role') {
				const role = implicitRole(this);
				if (role) emit('setCustomProp', this.nativeId, 'role', role);
			}
		}
	}
	getAttributeNames() {
		return [...this.attributes.keys()];
	}
	get id() {
		return this.attributes.get('id') ?? '';
	}
	set id(v: string) {
		this.attributes.set('id', v); this._rawAttrs?.delete('id');
	}
	get type() {
		return this.attributes.get('type') ?? '';
	}
	set type(v: string) {
		this.attributes.set('type', String(v)); this._rawAttrs?.delete('type');
	}
	get value(): string {
		// DOM fallbacks: select.value = selected option; option/textarea fall back to text
		if (this.tagName === 'SELECT') {
			const sel = this.selectedOptions[0] ?? this.options[0];
			return sel ? sel.value : '';
		}
		if ((this.tagName === 'OPTION' || this.tagName === 'TEXTAREA') && !this.attributes.has('value')) {
			return this.textContent;
		}
		return this.attributes.get('value') ?? '';
	}
	set value(v: string) {
		if (this.tagName === 'SELECT') {
			for (const o of this.options) o.selected = o.value === String(v);
		}
		this.attributes.set('value', String(v)); this._rawAttrs?.delete('value');
		if (this.nativeId) emit('setCustomProp', this.nativeId, 'value', String(v));
	}
	get options(): GElement[] {
		return this.querySelectorAll('option');
	}
	get selectedIndex(): number {
		return this.options.findIndex((o) => o.selected);
	}
	set selectedIndex(i: number) {
		this.options.forEach((o, x) => (o.selected = x === i));
	}
	get selectedOptions(): GElement[] {
		return this.options.filter((o) => o.selected);
	}
	get innerText(): string {
		return this.textContent;
	}
	set innerText(v: string) {
		this.textContent = v;
	}
	get defaultValue() {
		return this.attributes.get('value') ?? '';
	}
	set defaultValue(v: string) {
		this.attributes.set('value', String(v)); this._rawAttrs?.delete('value');
	}
	get checked() {
		return this.attributes.has('checked');
	}
	set checked(v: boolean) {
		if (v) this.attributes.set('checked', '');
		else this.attributes.delete('checked'); this._rawAttrs?.delete('checked');
		if (this.nativeId) emit('setCustomProp', this.nativeId, 'checked', Boolean(v));
	}
	get defaultChecked() {
		return this.attributes.has('checked');
	}
	set defaultChecked(v: boolean) {
		if (v) this.attributes.set('checked', '');
		else this.attributes.delete('checked'); this._rawAttrs?.delete('checked');
	}
	get name() {
		return this.attributes.get('name') ?? '';
	}
	set name(v: string) {
		this.attributes.set('name', String(v)); this._rawAttrs?.delete('name');
	}
	get method() {
		return this.attributes.get('method') ?? '';
	}
	set method(v: string) {
		this.attributes.set('method', String(v)); this._rawAttrs?.delete('method');
	}
	get action() {
		return this.attributes.get('action') ?? '';
	}
	set action(v: string) {
		this.attributes.set('action', String(v)); this._rawAttrs?.delete('action');
	}
	get href() {
		return this.attributes.get('href') ?? '';
	}
	set href(v: string) {
		this.attributes.set('href', String(v)); this._rawAttrs?.delete('href');
	}
	get formmethod() {
		return this.attributes.get('formmethod') ?? '';
	}
	set formmethod(v: string) {
		this.attributes.set('formmethod', String(v)); this._rawAttrs?.delete('formmethod');
	}
	get formaction() {
		return this.attributes.get('formaction') ?? '';
	}
	set formaction(v: string) {
		this.attributes.set('formaction', String(v)); this._rawAttrs?.delete('formaction');
	}
	get enctype() {
		return this.attributes.get('enctype') ?? '';
	}
	set enctype(v: string) {
		this.attributes.set('enctype', String(v)); this._rawAttrs?.delete('enctype');
	}
	get placeholder() {
		return this.attributes.get('placeholder') ?? '';
	}
	set placeholder(v: string) {
		this.attributes.set('placeholder', String(v)); this._rawAttrs?.delete('placeholder');
	}
	get target() {
		return this.attributes.get('target') ?? '';
	}
	set target(v: string) {
		this.attributes.set('target', String(v)); this._rawAttrs?.delete('target');
	}
	get disabled() {
		return this.attributes.has('disabled');
	}
	set disabled(v: boolean) {
		if (v) this.attributes.set('disabled', '');
		else this.attributes.delete('disabled'); this._rawAttrs?.delete('disabled');
	}
	get selected() {
		return this.attributes.has('selected');
	}
	set selected(v: boolean) {
		if (v) this.attributes.set('selected', '');
		else this.attributes.delete('selected'); this._rawAttrs?.delete('selected');
	}
	get multiple() {
		return this.attributes.has('multiple');
	}
	set multiple(v: boolean) {
		if (v) this.attributes.set('multiple', '');
		else this.attributes.delete('multiple'); this._rawAttrs?.delete('multiple');
	}
	get readOnly() {
		return this.attributes.has('readonly');
	}
	set readOnly(v: boolean) {
		if (v) this.attributes.set('readonly', '');
		else this.attributes.delete('readonly'); this._rawAttrs?.delete('readonly');
	}
	selectionStart = 0;
	selectionEnd = 0;
	get clientWidth() {
		return this._bounds()?.width ?? 0;
	}
	get clientHeight() {
		return this._bounds()?.height ?? 0;
	}
	get offsetWidth() {
		return this.clientWidth;
	}
	get offsetHeight() {
		return this.clientHeight;
	}
	_bounds() {
		if (!this.nativeId) return null;
		// Forced synchronous layout: recorded bounds update at paint, but
		// transition constructors (slide/crossfade/flip) measure between the
		// DOM mutation and the next frame — a no-op unless a batch is pending.
		measureBounds();
		return nativeBounds(this.nativeId);
	}
	/** class-derived props merged under inline props (inline wins). */
	/** Live animation effect layers — WAAPI stacking: each animate() call
	 *  owns a prop→value frame; the effective inline style is author props
	 *  overlaid by live frames in creation order (later animations win per
	 *  prop). cancel() drops the layer → underlying values resurface.
	 *  `style.x`/`cssText` read only the author layer, matching browsers
	 *  (animation effects never appear in the inline declaration). */
	animFrames = new Map<number, Map<string, string>>();
	mergedStyleProps(): Map<string, string> {
		const m = new Map(this._classProps);
		for (const [k, v] of this.style.props) m.set(k, v);
		for (const f of this.animFrames.values()) for (const [k, v] of f) m.set(k, v);
		return m;
	}
	getBoundingClientRect() {
		const b = this._bounds();
		if (!b) return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
		return { ...b, top: b.y, left: b.x, right: b.x + b.width, bottom: b.y + b.height };
	}
	_scrollX = 0;
	_scrollY = 0;
	get scrollTop() {
		if (this.nativeId) {
			const o = scrollOffset(this.nativeId);
			if (o) this._scrollY = o[1];
		}
		return this._scrollY;
	}
	set scrollTop(v: number) {
		this._scrollY = v;
		if (this.nativeId) deferCall((r) => r.scrollTo?.(this.nativeId, this._scrollX, v));
	}
	get scrollLeft() {
		if (this.nativeId) {
			const o = scrollOffset(this.nativeId);
			if (o) this._scrollX = o[0];
		}
		return this._scrollX;
	}
	set scrollLeft(v: number) {
		this._scrollX = v;
		if (this.nativeId) deferCall((r) => r.scrollTo?.(this.nativeId, v, this._scrollY));
	}
	scrollTo(x: number | { left?: number; top?: number }, y?: number) {
		const left = typeof x === 'object' ? (x.left ?? this._scrollX) : x;
		const top = typeof x === 'object' ? (x.top ?? this._scrollY) : (y ?? 0);
		this._scrollX = left;
		this._scrollY = top;
		if (this.nativeId) deferCall((r) => r.scrollTo?.(this.nativeId, left, top));
	}
	scrollIntoView() {
		// best-effort: gpuix scrollToItem applies to virtual-list parents
		const parent = this.parentNode;
		if (parent?.nativeId && parent instanceof GElement && parent.tagName === 'VIRTUAL-LIST') {
			const idx = parent.childNodes.indexOf(this);
			// childNodes is only the materialized window — scrollToItem wants
			// the logical item index: the list's declared windowStart plus the
			// offset inside the window.
			const windowStart = Number(parent._customProps?.get('windowStart') ?? 0) || 0;
			if (idx >= 0) deferCall((r) => r.scrollToItem?.(parent.nativeId, windowStart + idx, 0));
		}
	}
	click() {
		// same path as a native click — includes activation behavior + preventDefault
		dispatchNative(this, 'click', {});
	}
	/** form submission — dispatch a cancelable `submit` with a submitter ref.
	 *  No arg → the implicit submitter (first submit button in tree order). */
	requestSubmit(submitter?: GElement) {
		if (this.tagName !== 'FORM') return;
		if (!submitter) {
			const isSubmit = (el: GElement) => {
				const type = el.getAttribute?.('type') ?? 'submit';
				return (el.tagName === 'BUTTON' && type === 'submit') || (el.tagName === 'INPUT' && (type === 'submit' || type === 'image'));
			};
			for (const el of walkElements(this)) {
				if (isSubmit(el)) {
					submitter = el;
					break;
				}
			}
		}
		dispatchType(this, 'submit', {}, { submitter });
	}
	/** form reset — restore initial values (browser reset semantics: the
	 *  `value`/`checked` attributes are the defaults). */
	reset() {
		for (const el of walkElements(this)) {
			if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
				el.value = el.attributes.get('value') ?? '';
				if (el.type === 'checkbox' || el.type === 'radio') el.checked = el.attributes.has('checked');
			} else if (el.tagName === 'SELECT') {
				el.value = '';
			}
		}
	}
	setAttributeNS(_ns: string, k: string, v: string) {
		this.setAttribute(k, v);
	}
	override cloneShallow() {
		const c = new GElement(this._localTag);
		c.namespaceURI = this.namespaceURI;
		c.ownerDocument = this.ownerDocument;
		for (const [k, v] of this.attributes) c.attributes.set(k, v);
		for (const [k, v] of this.style.props) c.style.props.set(k, v);
		if (this._className) c.className = this._className; // via setter: attrs + class styles
		// The native lanes ride side-maps — without them a clone replays
		// "[object Object]" attrs and loses its styling/props entirely.
		if (this._rawAttrs) c._rawAttrs = new Map(this._rawAttrs);
		if (this._customProps) c._customProps = new Map(this._customProps);
		c._nativeEnv = this._nativeEnv;
		c._nativeStyle = this._nativeStyle ? { ...this._nativeStyle } : null;
		c._ctxColorOwned = this._ctxColorOwned;
		c._attrColor = this._attrColor;
		return c as GNode;
	}
	focus() {
		// FocusHandle is created during render — focus can only apply after a frame
		deferAfterRender((r) => {
			if (this.nativeId) {
				r.focusElement(this.nativeId);
				doc.activeElement = this;
			}
		});
	}
	blur() {
		if (doc.activeElement === this) doc.activeElement = null;
		if (this.nativeId) deferCall((r) => (r as { blur?: () => void }).blur?.());
	}
	querySelector(sel: string): GElement | null {
		const match = compileSelector(sel);
		for (const el of walkElements(this)) if (match(el)) return el;
		return null;
	}
	querySelectorAll(sel: string): GElement[] {
		const match = compileSelector(sel);
		return [...walkElements(this)].filter(match);
	}
	matches(sel: string): boolean {
		return compileSelector(sel)(this);
	}
	closest(sel: string): GElement | null {
		const match = compileSelector(sel);
		for (let n: GElement | null = this; n; n = n.parentElement) if (match(n)) return n;
		return null;
	}
	/**
	 * WAAPI-lite: interpolate numeric style props per frame → each frame pushes
	 * a setStyle op → real native animation, driven by rAF.
	 * Supports `iterations` (incl. Infinity) and `direction: 'alternate'`.
	 */
	animate(keyframes: Record<string, unknown>[], opts: { duration?: number; delay?: number; fill?: string; iterations?: number; direction?: string; easing?: string | ((t: number) => number) } = {}) {
		const duration = opts.duration ?? 0;
		const delay = opts.delay ?? 0;
		const iterations = opts.iterations ?? 1;
		const dir = opts.direction ?? 'normal';
		const reverse = dir === 'reverse';
		const easing =
			typeof opts.easing === 'function'
				? opts.easing
				: (CSS_EASINGS[opts.easing ?? 'linear'] ?? ((t: number) => t));
		let start = performance.now() + delay;
		// Keep per-keyframe offsets — svelte's transition driver bakes its
		// easing into ~1-per-16ms keyframes, so interpolating piecewise across
		// ALL of them reproduces the eased curve (first→last would flatten it).
		const frames = keyframes.map((kf, i) => {
			const { offset, easing: _e, ...props } = kf as Record<string, unknown>;
			const o = typeof offset === 'number' ? offset : keyframes.length > 1 ? i / (keyframes.length - 1) : 0;
			return { offset: o, props: props as Record<string, string> };
		});
		const last = frames[frames.length - 1]?.props ?? {};
		let done = false;
		let heldTime = 0;
		let finishedResolve: () => void;
		let finishedReject: (e: unknown) => void;
		const finished = new Promise<void>((res, rej) => {
			finishedResolve = res;
			finishedReject = rej;
		});
		// WAAPI rejects `finished` with AbortError on cancel — most callers
		// never await it (svelte drives onfinish), so pre-attach a handler to
		// keep the rejection from surfacing as unhandled.
		finished.catch(() => {});
		// This animation's effect lives in its own layer (animFrames) —
		// never in the author `style.props`. Key order = creation order =
		// WAAPI stacking order: a later animation overrides an earlier one
		// per prop while both run; removing the layer on cancel/finish
		// resurfaces whatever was underneath with no restore bookkeeping.
		const animKey = allocId();
		const frame = new Map<string, string>();
		this.animFrames.set(animKey, frame);
		const apply = (props: Record<string, string>) => {
			for (const [k, v] of Object.entries(props)) frame.set(k, String(v));
			this.style.push();
			// No flush here: applyBatch ends in a synchronous draw that emits
			// a "frame" event — a step-level flush closes a
			// render→frame→step→apply→render loop at task speed (~10kHz)
			// which starves the event loop for any perpetual animation.
			// Steps ride emit's setTimeout hop so every cycle crosses a
			// macrotask boundary.
		};
		// Numeric slots carry their unit so the skeleton is pure literals:
		// `translateX(0)`/`translateX(-160px)` share `translateX(<n>)` and
		// tween — CSS treats a bare 0 as unit-agnostic, so the 0 side adopts
		// the counterpart's unit. Genuinely different units (px↔s, deg↔rad)
		// or different shapes stay discrete, like WAAPI's incompatible values.
		const NUM_UNIT = /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?[a-z%]*/gi;
		const SLOT = '\0';
		const tokenize = (s: string) => {
			const slots: { num: number; unit: string }[] = [];
			const skeleton = s.replace(NUM_UNIT, (m) => {
				const numLen = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(m)![0].length;
				slots.push({ num: parseFloat(m.slice(0, numLen)), unit: m.slice(numLen) });
				return SLOT;
			});
			return { skeleton, slots };
		};
		// Keyframe + underlying values are fixed strings for this animation's
		// life — skeleton/slots/parts are pure functions of the string, so
		// memoize them instead of running two regex replaces per prop per
		// frame (≈8 anims × 2 props × 120fps of pure churn).
		const parsed = new Map<string, { skeleton: string; slots: { num: number; unit: string }[]; parts: string[] }>();
		const tokenizeCached = (s: string) => {
			let p = parsed.get(s);
			if (!p) {
				const t = tokenize(s);
				p = { skeleton: t.skeleton, slots: t.slots, parts: t.skeleton.split(SLOT) };
				parsed.set(s, p);
			}
			return p;
		};
		const interp = (a: string, b: string, t: number) => {
			const pa = parseFloat(a), pb = parseFloat(b);
			if (!isNaN(pa) && !isNaN(pb)) {
				const unit = String(b).replace(/^[-\d.]+/, ''); // preserve the target's unit (%, px…)
				return String(pa + (pb - pa) * t) + unit;
			}
			// `none`/`auto`/'' opposite a function list (transforms) means
			// identity — expand to the other side's shape so 'none'→'rotate(360deg)'
			// tweens through rotate(0deg): scale-family idents are 1, others 0,
			// each slot keeping its own unit.
			const blank = (v: string) => v === '' || v === 'none' || v === 'auto';
			const isFnList = (v: string) => v.includes('(') && v.trimEnd().endsWith(')');
			const identArgs = (fn: string, args: string) =>
				fn === 'matrix'
					? '1,0,0,1,0,0'
					: args.replace(NUM_UNIT, (m) => (fn.startsWith('scale') ? '1' : '0') + m.replace(/^[-\d.eE+]+/, ''));
			const identityOf = (s: string) =>
				s.replace(/([a-zA-Z]+)\(([^)]*)\)/g, (_m, fn, args) => `${fn}(${identArgs(fn, args)})`);
			const an = blank(a), bn = blank(b);
			if (an !== bn && isFnList(an ? b : a)) {
				if (an) a = identityOf(b);
				else b = identityOf(a);
			}
			const A = tokenizeCached(a), B = tokenizeCached(b);
			if (A.skeleton !== B.skeleton || A.slots.length === 0) return t < 1 ? a : b;
			const parts = A.parts;
			let out = '';
			for (let i = 0; i < A.slots.length; i++) {
				const sa = A.slots[i]!, sb = B.slots[i]!;
				let unit = sa.unit;
				if (sa.unit !== sb.unit) {
					if (sa.num === 0 && sa.unit === '') unit = sb.unit;
					else if (sb.num === 0 && sb.unit === '') unit = sa.unit;
					else return t < 1 ? a : b;
				}
				out += parts[i]! + String(sa.num + (sb.num - sa.num) * t) + unit;
			}
			return out + parts[A.slots.length]!;
		};
		// WAAPI fills a missing keyframe endpoint from the element's underlying
		// (computed) value — `animate([{transform:'rotate(360deg)'}])` tweens
		// from the current transform, and `@keyframes x { to {...} }` needs the
		// same. Capture before this animation's own first apply so the layer
		// can't feed back into itself.
		const under = new Map<string, string>();
		for (const f of frames) {
			for (const k of Object.keys(f.props)) {
				if (!under.has(k)) {
					under.set(k, String((getComputedStyle(this as unknown as Element) as unknown as Record<string, unknown>)[k] ?? ''));
				}
			}
		}
		// Sample the keyframe segment containing progress t — offsets let
		// non-uniform authors (WAAPI-style) land correctly too.
		const sample = (t: number) => {
			if (frames.length === 0) return;
			const first = frames[0];
			if (first.offset > 0 && (frames.length === 1 || t < first.offset)) {
				// the run-up to the first declared offset interpolates from the
				// underlying value — a lone `to` keyframe tweens 0→1 this way
				const local = t / first.offset;
				const out: Record<string, string> = {};
				for (const k of Object.keys(first.props)) {
					out[k] = interp(under.get(k) ?? '', first.props[k]!, Math.min(1, local));
				}
				apply(out);
				return;
			}
			if (t >= frames[frames.length - 1].offset) {
				apply(last);
				return;
			}
			let i = 0;
			while (i < frames.length - 2 && frames[i + 1].offset <= t) i++;
			const a = frames[i], b = frames[i + 1];
			const span = b.offset - a.offset;
			const local = span > 0 ? (t - a.offset) / span : 0;
			const out: Record<string, string> = {};
			const keys = new Set([...Object.keys(a.props), ...Object.keys(b.props)]);
			for (const k of keys) {
				const av = a.props[k] ?? under.get(k) ?? '';
				const bv = b.props[k] ?? under.get(k) ?? '';
				out[k] = interp(av, bv, local);
			}
			apply(out);
		};
		// Normalized progress at `elapsed` ms into the active phase —
		// iteration wrap and direction applied. Pin, step, and seek all
		// sample through this so every entry point agrees on the pose.
		// Fractional `iterations` ends mid-iteration (1.5 → t=0.5 of the
		// last pass), not at a pole.
		const tAt = (elapsed: number) => {
			const iter = duration === 0 ? iterations : elapsed / duration;
			if (iter >= iterations) {
				const frac = iterations % 1;
				const li = frac === 0 ? iterations - 1 : Math.floor(iterations);
				const tEnd = frac === 0 ? 1 : frac;
				const lastReversed =
					reverse ||
					(dir === 'alternate' && li % 2 === 1) ||
					(dir === 'alternate-reverse' && li % 2 === 0);
				return lastReversed ? 1 - tEnd : tEnd;
			}
			const whole = Math.floor(iter);
			let t = iter - whole;
			if (reverse || (dir === 'alternate' && whole % 2 === 1) || (dir === 'alternate-reverse' && whole % 2 === 0))
				t = 1 - t;
			return t;
		};
		// Pin the first frame synchronously. Svelte's delay-dummy
		// (`animate(kf, {duration: delay, fill: 'forwards'})`) relies on the
		// t=0 styles applying the moment animate() is called — waiting for
		// the first rAF lets a flush paint the natural end-state → intro
		// flash. The pose is the one `tAt` computes for the current local
		// time — `direction: 'reverse'` starts on the LAST frame and a
		// negative delay starts mid-curve, not at frames[0]. (Only when the
		// animation is already in/entering its active phase: delay:0 or a
		// backwards-filling fill mode.)
		if (frames.length && (delay <= 0 || opts.fill === 'backwards' || opts.fill === 'both')) {
			sample(easing(tAt(Math.max(0, -delay))));
			// The pin presents in this task — it is what the eye sees during a
			// reversal interrupt, and it coalesces the toggle's structural ops
			// into the same draw. Bounded: once per animate() call (transitions
			// are event-driven; animate:flip calls animate() inside the rAF
			// loop but still only once per reorder, not per frame), so this
			// can't sustain the render→frame→step cycle a step-level flush
			// would close.
			nativeBridge.flush();
		}
		const anim = {
			finished,
			onfinish: null as null | (() => void),
			get currentTime() {
				// Live while running — svelte's counterpart.t() reads this at
				// interrupt time; a stored value is up to a frame stale, which
				// pins the reversed transition behind the true position.
				return done || anim.playState === 'paused' ? heldTime : Math.max(0, performance.now() - start);
			},
			set currentTime(v: number) {
				// WAAPI seek: running anims rebase the clock so the next step
				// lands on v; paused anims repaint the held frame now; a
				// finished/cancelled anim just reports the write back.
				heldTime = v;
				if (anim.playState === 'paused') sample(easing(tAt(v)));
				else if (!done) start = performance.now() - v;
			},
			// 'running' from birth — svelte's transition driver gates its
			// `tick` loop on playState==='running' and the loop task is
			// queued before animate() returns, so 'idle' here deletes the
			// task before the first frame (tick-only transitions never ran).
			playState: 'running' as string,
			cancel: () => {
				done = true;
				anim.playState = 'idle';
				this._liveAnims?.delete(anim);
				// Drop the effect layer — underlying values (author props
				// and any still-running animation below us) resurface. Runs
				// for finished anims too: svelte cancels the delay-dummy
				// after its finish, inside onfinish — the fill must come off.
				this.animFrames.delete(animKey);
				this.style.push();
				const err = new Error('Animation cancelled');
				err.name = 'AbortError';
				finishedReject(err);
			},
			finish: () => {
				if (done) return; // already cancelled — a queued settle must not resurrect styles
				done = true;
				anim.playState = 'finished';
				this._liveAnims?.delete(anim);
				heldTime = duration * iterations;
				// fill:forwards keeps the last frame in the layer; any other
				// fill mode (including the default 'none') drops the effect
				// when the active phase ends.
				if (opts.fill === 'forwards' || opts.fill === 'both') apply(last);
				else this.animFrames.delete(animKey);
				this.style.push();
				finishedResolve();
				anim.onfinish?.();
			},
			pause: () => {
				if (done || anim.playState === 'paused') return;
				anim.playState = 'paused';
				// Store through the setter's heldTime write; skip its paused
				// seek-resample — the pose is already the last stepped frame.
				heldTime = Math.max(0, performance.now() - start);
			},
			play: () => {
				if (anim.playState !== 'paused') return;
				// Resume from the held time — paused seeks move it, so this is
				// `now - heldTime`, not a blind shift by the paused span.
				start = performance.now() - heldTime;
				anim.playState = 'running';
				requestAnimationFrame(step);
			},
			persist: () => {},
			playbackRate: 1,
		};
		// Live handles on the element — dematerialize cancels them all, so an
		// iterations:Infinity chain can't outlive its subtree and keep waking
		// the window to paint a dead element.
		(this._liveAnims ??= new Set()).add(anim);
		if (duration === 0 && delay <= 0) {
			// Svelte's delay-dummy arrives as duration:0 — settling on a
			// microtask instead of a rAF tick keeps the real animation's
			// start on this frame instead of ~16ms late. finish() applies
			// the last frame and fires onfinish after animate() has
			// returned, so the caller's handler is attached in time.
			queueMicrotask(() => anim.finish());
			return anim as unknown as Animation;
		}
		const step = () => {
			if (done || anim.playState === 'paused') return;
			const elapsed = Math.max(0, performance.now() - start);
			if (elapsed <= 0) {
				requestAnimationFrame(step);
				return;
			}
			anim.playState = 'running';
			// heldTime directly — the setter would rebase `start` (a seek),
			// which is a no-op here plus sub-ms drift per step.
			heldTime = elapsed;
			const iter = duration === 0 ? iterations : elapsed / duration;
			sample(easing(tAt(elapsed)));
			if (iter < iterations) requestAnimationFrame(step);
			else {
				done = true;
				anim.playState = 'finished';
				this._liveAnims?.delete(anim);
				// same fill contract as finish(): non-persistent fills drop
				// the effect layer when the active phase ends
				if (opts.fill !== 'forwards' && opts.fill !== 'both') {
					this.animFrames.delete(animKey);
					this.style.push();
				}
				finishedResolve();
				anim.onfinish?.();
			}
		};
		requestAnimationFrame(step);
		return anim as unknown as Animation;
	}
	getAnimations() {
		// Svelte's flip fix() reads this to detect a conflicting running
		// animation — returning the live set makes that guard real.
		return [...(this._liveAnims ?? [])] as unknown as Animation[];
	}
}

// ── selectors + serialization ────────────────────────────────────────

/** Minimal selector support: `#id`, `tag`, `.cls`, `tag.cls.cls2`, `[attr]`/`[attr="v"]`,
 *  plus the pseudos Svelte's select internals need (`:checked`, `:not([attr])`, `:disabled`). */
function compileSelector(sel: string): (el: GElement) => boolean {
	if (sel.startsWith('#')) {
		const id = sel.slice(1);
		return (el) => el.attributes.get('id') === id;
	}
	const notAttrs = [...sel.matchAll(/:not\(\[([\w-]+)\]\)/g)].flatMap((m) =>
		m[1] === undefined ? [] : [m[1]],
	);
	const wantChecked = /:checked/.test(sel);
	const wantDisabled = /:disabled/.test(sel);
	const attrs: [string, string?][] = [...sel.matchAll(/\[([\w-]+)(?:=["']([^"']*)["'])?\]/g)].flatMap(
		(m) => (m[1] === undefined ? [] : [[m[1], m[2]]]),
	);
	const base = sel
		.replace(/\[[^\]]*\]/g, '')
		.replace(/:not\([^)]*\)/g, '')
		.replace(/:(checked|disabled)/g, '');
	const [tag, ...cls] = base.split('.');
	return (el) =>
		(!tag || el.tagName.toLowerCase() === tag.toLowerCase()) &&
		cls.every((c) => c && el._className.split(/\s+/).includes(c)) &&
		attrs.every(([k, v]) => (v === undefined ? el.attributes.has(k) : el.attributes.get(k) === v)) &&
		notAttrs.every((k) => !el.attributes.has(k)) &&
		(!wantChecked || el.checked) &&
		(!wantDisabled || el.disabled);
}

function* walkElements(n: GNode): Generator<GElement> {
	for (const c of n.childNodes) {
		if (c.nodeType === 1) {
			yield c as GElement;
			yield* walkElements(c);
		}
	}
}

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;');

function serializeNode(n: GNode): string {
	if (n.nodeType === 3) return escapeText(n.data);
	if (n.nodeType === 8) return `<!--${n.data}-->`;
	if (n.nodeType === 1) {
		const el = n as GElement;
		const tag = el.tagName.toLowerCase();
		const attrs = [...el.attributes]
			.map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`))
			.join('');
		if (VOID_TAGS.has(tag)) return `<${tag}${attrs}>`;
		return `<${tag}${attrs}>${el.childNodes.map(serializeNode).join('')}</${tag}>`;
	}
	return n.childNodes.map(serializeNode).join(''); // fragments
}

// ── svg subtrees ────────────────────────────────────────────────────────
// `<svg>` is a leaf renderer natively — gpui::svg paints a whole document,
// not a DOM subtree. Children of an svg element never materialize; instead
// the subtree serializes into the element's `source` prop on every
// mutation, so authored markup `<svg><path d={d}/></svg>` works verbatim
// and stays reactive.

/** Outermost svg ancestor-or-self — a `<svg>` nested inside is just markup. */
function svgHost(n: GNode): GElement | null {
	let host: GElement | null = null;
	for (let p: GNode | null = n; p; p = p.parentNode) {
		if (p.nodeType === 1 && (p as GElement).tagName === 'SVG') host = p as GElement;
	}
	return host;
}

/** On the root these attrs style the native element box — everything else
 *  (viewBox, fill, width…) belongs in the serialized document. Inner nodes
 *  serialize every attribute verbatim. */
const SVG_ROOT_ATTR_SKIP = /^(?:class|style|id|src|source|role|tabindex|aria-|data-|on)/i;

function serializeSvg(root: GElement): string {
	const ser = (n: GNode): string => {
		if (n.nodeType === 3) return escapeText(n.data);
		if (n.nodeType !== 1) return n.childNodes.map(ser).join(''); // fragments unwrap, comments drop
		const el = n as GElement;
		let s = `<${el._localTag}`;
		if (el === root && !el.attributes.has('xmlns')) s += ' xmlns="http://www.w3.org/2000/svg"';
		for (const [k, v] of el.attributes) {
			if (el === root && SVG_ROOT_ATTR_SKIP.test(k)) continue;
			// XML — bare attrs (`<path fill>`) are malformed; empty → k=""
			s += ` ${k}="${escapeAttr(v)}"`;
		}
		s += '>';
		for (const c of el.childNodes) s += ser(c);
		return `${s}</${el._localTag}>`;
	};
	return ser(root);
}

/** Re-serialize the enclosing svg document into `source`. setCustomProp
 *  dedupes identical markup; the ledger replays at materialize time, so
 *  marking also works while the element is still detached. */
function markSvgDirty(n: GNode) {
	const host = svgHost(n);
	if (!host) return;
	if (host.childNodes.length) host.setCustomProp('source', serializeSvg(host));
	else host.removeCustomProp('source');
}

/** Attributes map with an svg dirty hook — every write path funnels through
 *  here (setAttribute, the className/id setters, parseHTML's attr loop), so
 *  markup-side mutations re-serialize without touching each setter. */
class GAttrs extends Map<string, string> {
	constructor(private el: GElement) {
		super();
	}
	private dirty() {
		markSvgDirty(this.el);
		// the el's own attrs feed its box too (svg width/height presentation
		// attrs) — a push re-runs nativeStyleFor; inert subtrees have no peer.
		if (svgHost(this.el) === this.el) this.el.style.push();
	}
	override set(k: string, v: string): this {
		super.set(k, v);
		this.dirty();
		return this;
	}
	override delete(k: string): boolean {
		const r = super.delete(k);
		if (r) this.dirty();
		return r;
	}
}

export class GDocument extends GNode {
	override nodeType = 9;
	documentElement = new GElement('html');
	head = new GElement('head');
	body = new GElement('body');
	activeElement: GElement | null = null;
	baseURI = 'app://local';
	contentType = 'text/html';
	defaultView: unknown = null;
	constructor() {
		super();
		this.ownerDocument = this;
		this.documentElement.ownerDocument = this;
		this.head.ownerDocument = this;
		this.body.ownerDocument = this;
		this.documentElement.appendChild(this.head);
		this.documentElement.appendChild(this.body);
		this.appendChild(this.documentElement);
	}
	createElement(tag: string) {
		const el = new GElement(tag);
		el.ownerDocument = this;
		return el;
	}
	createElementNS(ns: string, tag: string) {
		const el = this.createElement(tag);
		el.namespaceURI = ns;
		return el;
	}
	createTextNode(data: string) {
		const t = new GText(data);
		t.ownerDocument = this;
		return t;
	}
	createComment(data: string) {
		const c = new GComment(data);
		c.ownerDocument = this;
		return c;
	}
	createDocumentFragment() {
		const f = new GFragment();
		f.ownerDocument = this;
		return f;
	}
	importNode<T extends GNode>(node: T, deep: boolean): T {
		const c = node.cloneNode(deep) as T;
		const own = (n: GNode) => {
			n.ownerDocument = this;
			n.childNodes.forEach(own);
		};
		own(c);
		return c;
	}
	// delegation root: Svelte registers handle_event_propagation here
	override addEventListener(type: string, fn: EventListener) {
		super.addEventListener(type, fn);
		if (!delegatedTypes.has(type)) {
			delegatedTypes.add(type);
			if (!FOCUS_KEY_TYPES.has(type)) emitDelegatedEvents();
			backfillDelegated(type);
		}
		// document-level key listeners want window-level key delivery
		if (type === 'keydown' || type === 'keyup' || type === 'keypress') {
			deferCall((r) => r.setWindowKeyEvents?.(true, true, WINDOW_EVENT_ID));
		}
	}
	querySelector(sel: string): GElement | null {
		const match = compileSelector(sel);
		if (match(this.documentElement)) return this.documentElement;
		for (const el of walkElements(this.documentElement)) if (match(el)) return el;
		return null;
	}
	querySelectorAll(sel: string): GElement[] {
		const match = compileSelector(sel);
		const found = [...walkElements(this.documentElement)].filter(match);
		if (match(this.documentElement)) found.unshift(this.documentElement);
		return found;
	}
}

// ── native materialization ────────────────────────────────────────────

function materialize(node: GNode) {
	if (node.nativeId || node.nodeType === 8) return;
	if (node.nodeType === 11) {
		for (const c of node.childNodes) materialize(c);
		return;
	}
	if (node.nodeType === 3) {
		// whitespace-only text is invisible in real DOM flow (anonymous boxes
		// collapse in flex/block containers) — without this every indentation
		// newline becomes a ~26px box. Materializes lazily if data gains text.
		if (!/\S/.test(node.data)) return;
		const id = allocId();
		node.nativeId = id;
		bindNative(id, node);
		emit('createElement', id, 'text');
		emit('setText', id, node.data);
		return;
	}
	const id = allocId();
	node.nativeId = id;
	bindNative(id, node);
	const el = node as GElement;
	const tag = el.tagName.toLowerCase();
	// checkbox/radio aren't text inputs natively — render as a clickable box
	const isToggle = tag === 'input' && (el.type === 'checkbox' || el.type === 'radio');
	const nativeTag = isToggle ? 'div' : gpuixTag(tag);
	emit('createElement', id, nativeTag);
	if (isToggle) {
		// empty divs collapse to 0×0 and can't be hit-tested — give the toggle a box
		for (const [k, v] of Object.entries({
			width: '18px',
			height: '18px',
			borderRadius: '4px',
			backgroundColor: '#4b5563',
		})) {
			if (!el.style.props.has(k)) el.style.props.set(k, v);
		}
		emitListener(el, 'click');
	}
	// ship the class list ahead of any style ops — the native stylesheet
	// layer sits under inline setStyle. The attributes loop below also runs
	// `el.className = v`; pushClass dedupes so it still emits exactly once.
	el.pushClass();
	// class rules may have been parsed while this element was detached —
	// recompute at materialize time so late-inserted nodes aren't left unstyled
	applyClassStyles(el);
	const merged = el.mergedStyleProps();
	if (merged.size || el._nativeStyle) emit('setStyle', id, nativeStyleFor(el));
	if (el._nativeEnv) emitNativeEnv(el);
	emitElementProps(el, id, hasStateRules);
	// svg children stay DOM-inert — `source` (already in the custom-prop
	// ledger via markSvgDirty) carries the serialized document instead.
	if (tag === 'svg') markSvgDirty(el);
	else for (const c of node.childNodes) {
		materialize(c);
		if (c.nativeId) emit('appendChild', id, c.nativeId);
	}
}

/**
 * The attrs/props/listeners a materialized element ships natively —
 * `customProps` (tabIndex, aria-*, role), delegated + direct listeners,
 * state-rule pointer events, input focus listeners. Shared between the
 * child `materialize` path and `materializeRoot` — a root that skipped
 * this would lose every attribute set before mounting (its `nativeId`
 * didn't exist yet for the direct emit).
 */
function emitElementProps(el: GElement, id: number, hasStateRules: boolean) {
	const tag = el.tagName.toLowerCase();
	for (const [k, v] of el.attributes) {
		if (k === 'style') {
			el.style.cssText = v;
		} else if (k === 'class') {
			el.className = v;
		} else if (el._customProps?.has(nativeAttrName(k))) {
			// ledger-owned keys (theme, data-color→color…) replay through
			// _customProps below — a raw attr emit would double-write and
			// can stomp the env-owned lane's value.
			continue;
		} else {
			emit('setCustomProp', id, nativeAttrName(k), el._rawAttrs?.get(k) ?? nativeAttrValue(k, v));
		}
	}
	if (el._customProps) for (const [k, v] of el._customProps) emit('setCustomProp', id, k, v);
	if (!el.attributes.has('role')) {
		const role = implicitRole(el);
		if (role) {
			emit('setCustomProp', id, 'role', role);
			if (role === 'heading' && el.tagName[1]) emit('setCustomProp', id, 'aria-level', parseInt(el.tagName[1], 10));
		}
	}
	// Non-focus delegated types dispatch via the native set — only focus/key
	// feeds still need a per-element mark, and only on focusables.
	for (const t of delegatedTypes) {
		if (!FOCUS_KEY_TYPES.has(t) || !isFocusable(el)) continue;
		emitListener(el, t);
	}
	if (el.listeners) {
		for (const t of el.listeners.keys()) emitListener(el, t);
	}
	refreshPressTarget(el);
	// :hover/:active styling needs pointer events — but only on elements that
	// can actually match a state rule (a blanket emit makes EVERY element
	// non-memoizable → full rebuild per frame)
	if (el._hasStateRule) {
		for (const t of ['mouseover', 'mouseout', 'mousedown', 'mouseup']) emitListener(el, t);
	}
	// text inputs need a FocusHandle — gpuix creates one only when focus/key listeners exist
	if (tag === 'input' || tag === 'textarea') {
		for (const t of ['focus', 'blur', 'keydown', 'keyup', 'input', 'change']) {
			emitListener(el, t);
		}
	}
}

/** Materialize the mount target itself and register it as the native root. */
export function materializeRoot(el: GElement) {
	if (el.nativeId) return;
	// flag before emitElementProps: mount() will stamp every delegated type's
	// handle_event_propagation here — that alone must not make it a pressTarget
	el.__isMountRoot = true;
	const id = allocId();
	el.nativeId = id;
	bindNative(id, el);
	emit('createElement', id, 'div');
	el.pushClass(); // the root's own class attr reaches native too
	applyClassStyles(el);
	emit('setStyle', id, {
		display: 'flex',
		flexDirection: 'column',
		flexGrow: 1,
		...nativeStyleFor(el),
	});
	if (el._nativeEnv) emitNativeEnv(el);
	// The root's own attrs/props/listeners — `setAttribute` before mount had
	// no `nativeId` to emit against, so this replay is the only path they get.
	emitElementProps(el, id, hasStateRules);
	// multi-window: a root flagged via createWindowRoot binds the subtree to
	// that window's view — `['setRoot', id, w]`; unflagged → window 0. Every
	// root is tracked so `closed {windowId}` can dematerialize the subtree —
	// an untracked primary root would orphan its whole tree on window close.
	const ownerWindow = el.__windowId ?? 0;
	if (el.__windowId === undefined) emit('setRoot', id);
	else emit('setRoot', id, el.__windowId);
	windowRoots.set(ownerWindow, el);
	for (const c of el.childNodes) {
		materialize(c);
		if (c.nativeId) emit('appendChild', id, c.nativeId);
	}
}

// ── multi-window mount roots ────────────────────────────────────────
// One gdom document hosts every window's subtree — element ids stay
// globally unique and mutations apply to the shared native tree; only the
// root's setRoot routes. A window root hangs directly off `doc` (sibling of
// documentElement, not inside it) so isConnected, event bubbling to the
// document's delegated listeners, and ownerDocument behave exactly like the
// primary mount target.

/** Live secondary-window roots: windowId → the flagged mount element. */
const windowRoots = new Map<number, GElement>();

/**
 * Mount target for a secondary window. Materializes immediately (the
 * `windows.create` op already opened the native window), emitting
 * `['setRoot', id, windowId]` so the native side binds the subtree root to
 * that window's view:
 *
 *   const { windowId } = await windows.create({ title: 'Settings' });
 *   mount(Settings, { target: createWindowRoot(windowId), props: { windowId } });
 */
export function createWindowRoot(windowId: number): GElement {
	const el = new GElement('div');
	el.__windowId = windowId;
	// Attach under `doc` — connected without joining documentElement's tree.
	doc.appendChild(el);
	materializeRoot(el);
	windowRoots.set(windowId, el);
	return el;
}

/**
 * `closed {windowId}` teardown — the native side already dropped its
 * roots[w] binding; the JS subtree is destroyed through the normal
 * removeChild → dematerialize path (destroyElement on the root cascades
 * natively; applyBatch's destroyed ids → unbindNative as usual).
 */
export function destroyWindowRoot(windowId: number): void {
	const root = windowRoots.get(windowId);
	if (!root) return;
	windowRoots.delete(windowId);
	if (root.parentNode) root.parentNode.removeChild(root); // normal destroy path
	else dematerialize(root);
}

/** Clear native ids + registry entries for a detached subtree.
 *  Only the subtree root emits destroyElement — native destroy cascades
 *  (applyBatch returns all destroyed ids, consumed in flush()). */
function dematerialize(node: GNode, emitDestroy = true) {
	if (doc.activeElement === node) doc.activeElement = null; // no stale focus ref
	if (node.nodeType === 1) {
		// Detaching restarts declared CSS animations on remount (browser
		// behavior) — kill the handle now so the sig can't suppress it.
		const el = node as GElement;
		el._cssAnim?.cancel();
		el._cssAnim = null;
		el._cssAnimSig = '';
		// Imperative element.animate()s die with the subtree too — an
		// iterations:Infinity chain would re-queue rAF forever otherwise,
		// emitting requestFrame for an element that no longer paints.
		for (const anim of [...(el._liveAnims ?? [])]) anim.cancel();
		el._liveAnims?.clear();
	}
	if (node.nativeId) {
		if (emitDestroy) emit('destroyElement', node.nativeId);
		registeredEvents.delete(node.nativeId);
		unbindNative(node.nativeId);
		node.nativeId = 0;
		// the native peer is gone — a rematerialize must re-ship the class
		if (node.nodeType === 1) (node as GElement)._sentClass = '';
	}
	for (const c of node.childNodes) dematerialize(c, false);
}

/** First materialized native id among ref's following siblings (or ref). */
function nativeBeforeId(parent: GNode, ref: GNode): number {
	for (let n: GNode | null = ref; n; n = n.nextSibling) {
		if (n.nativeId) return n.nativeId;
	}
	return 0;
}

// ── events from the native side ───────────────────────────────────────

export interface GEvent {
	type: string;
	target: GNode;
	currentTarget?: GNode | GDocument;
	defaultPrevented: boolean;
	cancelBubble: boolean;
	_stopped: boolean;
	preventDefault(): void;
	stopPropagation(): void;
	stopImmediatePropagation(): void;
	composedPath(): GNode[];
	[k: string]: unknown;
}

/** Listener signature inside the fake DOM — dispatch hands out GEvents,
 *  not DOM Events. `addEventListener` keeps the DOM-shaped `EventListener`
 *  parameter for caller compatibility and casts into the store. */
export type GEventListener = (event: GEvent) => void;

/** DOM drag/drop types backed by the native OS file-drop events. */
const FILE_DRAG_TYPES = new Set(['drop', 'dragenter', 'dragover', 'dragleave']);

/** basename for dataTransfer.files[].name — tolerate either separator. */
const pathBaseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/**
 * Synthetic DataTransfer for native file drops. `files` entries are frozen
 * {name, path} records — deliberately NOT DOM File objects: gdom can't read
 * the bytes, and a fake File would lie about size/type/stream(). `paths` is
 * absent on fileDragLeave (position only) → empty transfer. The object itself
 * stays unfrozen so `dataTransfer.dropEffect = …` writes in handlers don't
 * throw under strict mode — they're inert (nothing honors them natively).
 */
function makeDataTransfer(paths: unknown) {
	const list = Array.isArray(paths) ? (paths as string[]) : [];
	const files = list.map((p) => Object.freeze({ name: pathBaseName(p), path: p }));
	return {
		types: ['Files'],
		files,
		dropEffect: 'copy',
		effectAllowed: 'all',
		getData: (type: string) => (type === 'text/uri-list' ? list.join('\n') : ''),
	};
}

export function makeEvent(domType: string, target: GNode, payload: Record<string, unknown>): GEvent {
	const path: GNode[] = [];
	for (let n: GNode | null = target; n; n = n.parentNode) path.push(n);
	const mods = (payload.modifiers ?? {}) as Record<string, unknown>;
	const ev: GEvent = {
		...payload,
		type: domType,
		target,
		currentTarget: undefined,
		defaultPrevented: false,
		cancelBubble: false,
		_stopped: false,
		bubbles: !NO_BUBBLE.has(domType),
		composed: true,
		eventPhase: 0,
		timeStamp: performance.now(),
		isTrusted: true,
		clientX: payload.x,
		clientY: payload.y,
		shiftKey: !!mods.shift,
		ctrlKey: !!mods.ctrl,
		altKey: !!mods.alt,
		metaKey: !!(mods.cmd ?? mods.meta),
		repeat: !!payload.isHeld,
		detail: payload.clickCount,
		preventDefault() {
			this.defaultPrevented = true;
		},
		stopPropagation() {
			this.cancelBubble = true;
		},
		stopImmediatePropagation() {
			this.cancelBubble = true;
			this._stopped = true;
		},
		composedPath: () => path,
	};
	if (FILE_DRAG_TYPES.has(domType)) ev.dataTransfer = makeDataTransfer(payload.paths);
	return ev;
}

/** Dispatch a native event: target listeners, then delegated roots (document order). */
export function dispatchNative(target: GNode, domType: string, payload: Record<string, unknown>) {
	// input change events carry the new value — apply before dispatch so e.target.value reads it
	if (
		(domType === 'change' || domType === 'input') &&
		typeof payload.value === 'string' &&
		target instanceof GElement &&
		(target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
	) {
		target.attributes.set('value', payload.value);
		target._rawAttrs?.delete('value');
	}
	// interaction-state tracking for :hover/:active/:focus class rules —
	// native pointer/focus events are authoritative (same as the browser)
	if (target instanceof GElement) {
		const t = target as GElement;
		const before = [t._hovered, t._focused, t._active];
		if (domType === 'mouseover') t._hovered = true;
		else if (domType === 'mouseout') t._hovered = false;
		else if (domType === 'mousedown') { t._active = true; activeElements.add(t); }
		else if (domType === 'mouseup') {
			t._active = false;
			// clear _active on ALL tracked elements — mouseup lands on the hit
			// element, which may differ from the mousedown target (button released
			// outside → :active would stick forever on the original element)
			for (const el of activeElements) { el._active = false; applyClassStyles(el); }
			activeElements.clear();
		}
		else if (domType === 'focus') t._focused = true;
		else if (domType === 'blur') t._focused = false;
		if (before[0] !== t._hovered || before[1] !== t._focused || before[2] !== t._active) {
			applyClassStyles(t);
		}
	}
	const types = NATIVE_FANOUT[domType] ?? [domType];
	let ev: GEvent | undefined;
	for (const t of types) ev = dispatchType(target, t, payload);
	// activeElement follows native focus/blur (native is authoritative)
	if (domType === 'focus' && target instanceof GElement) doc.activeElement = target;
	if (domType === 'blur' && doc.activeElement === target) doc.activeElement = null;
	// activation behavior: <a href> navigation (kit router) unless prevented
	if (domType === 'click' && !ev?.defaultPrevented) {
		let a: GElement | null = target instanceof GElement ? target : null;
		for (; a && a.tagName !== 'A'; a = a.parentNode as GElement | null);
		const href = a?.getAttribute?.('href');
		if (href && !/^[a-z]+:/i.test(href)) {
			(globalThis as { __kitGoto?: (href: string) => void }).__kitGoto?.(href);
		}
	}
	// activation behavior: submit button inside a form → requestSubmit
	if (domType === 'click' && !ev?.defaultPrevented && target instanceof GElement) {
		let el: GElement | null = target;
		for (; el; el = el.parentNode as GElement | null) {
			const tag = el.tagName;
			const type = el.getAttribute?.('type') ?? 'submit';
			if ((tag === 'BUTTON' && type === 'submit') || (tag === 'INPUT' && (type === 'submit' || type === 'image'))) {
				let f: GElement | null = el.parentNode as GElement | null;
				for (; f && f.tagName !== 'FORM'; f = f.parentNode as GElement | null);
				f?.requestSubmit(el);
				break;
			}
		}
	}
	// activation behavior: clicking a checkbox/radio toggles checked → input + change
	if (
		domType === 'click' &&
		target instanceof GElement &&
		target.tagName === 'INPUT' &&
		!ev?.defaultPrevented
	) {
		if (target.type === 'checkbox') {
			target.checked = !target.checked;
			for (const t of ['input', 'change']) dispatchType(target, t, payload);
		} else if (target.type === 'radio' && !target.checked) {
			target.checked = true;
			// radios with the same name in the same form/document uncheck
			const root = target.getRootNode() as unknown as GDocument;
			for (const other of root.querySelectorAll?.(`input[type="radio"][name="${target.name}"]`) ?? []) {
				if (other !== target) other.checked = false;
			}
			for (const t of ['input', 'change']) dispatchType(target, t, payload);
		}
	}
}

// gpuix reports a pointer event once per element in the hit chain
// (deepest → ancestors). The DOM dispatches one gesture once at the deepest
// target and lets it bubble — so ancestor echoes of the same gesture are
// collapsed here: same type+coords, target a strict ancestor of the last one.
const POINTER_GESTURE = new Set(['click', 'mousedown', 'mouseup', 'auxclick', 'contextmenu', 'mousemove']);
let lastGesture: { type: string; x?: number; y?: number; node: GNode } | null = null;

/** Entry point for a raw native EventPayload — resolves the node or window sentinel. */
// ── requestAnimationFrame — native vsync cadence ─────────────────────
// rAF callbacks tick on the native `frame` event: emitted once per
// painted frame, so the cadence follows the display (bounded by the
// host's event pump — the emit.js loop polls the runloop at ~16ms) and
// an occluded window stops painting → stops ticking on its own.
// `requestFrame` wakes the window; the watchdog covers surfaces that
// never paint (test renderer between flushes, mirror backend, unbound
// bridge) so animations still complete — throttled — instead of
// stalling forever. Ticks run post-paint (mutations land next frame —
// a browser's rAF is pre-paint) and the timestamp is drain time,
// identical for every callback in the tick.
let rafQueue = new Map<number, FrameRequestCallback>();
let rafNextId = 1;
let rafWatchdog: ReturnType<typeof setTimeout> | null = null;
let rafTicking = false;
let lastTickWindow = -1;
let lastTickAt = 0;
// Old dylibs lack `requestFrame` — an unknown op fails the whole batch
// at decode, co-batched mutations included. Probe once; until proven,
// and on failure, the watchdog drops to the 16ms lane (the pre-vsync
// behavior) instead of poisoning every animation batch.
let frameOpsOk: boolean | null = null;
// The 250ms watchdog lane exists for one case: a frame-emitting renderer
// that stopped painting (occluded window). Backends that never emit frame
// events (the JS mirror, unbound bridges) must not wait 250ms for a tick
// that can only come from the watchdog — they stay on the 16ms lane, the
// pre-vsync behavior. Gate on an actual frame having arrived, not just
// the op being accepted (a mirror accepts and no-ops it).
let framesSeen = false;
// Realm generation: a vite reload orphans this module's machinery while
// the renderer + its event feed (rebound to the new realm) live on — a
// stale realm's watchdog or adopted callbacks must die with the realm.
// The host object persists across reloads (emit.js `??=`s the same one);
// claiming a generation at module eval kills the previous realm before
// its pending watchdog can tick once more.
const rafHost = ((globalThis as { __svelteNativeHost?: { rafGen?: number } }).__svelteNativeHost ??= {});
const rafGen = (rafHost.rafGen = (rafHost.rafGen ?? 0) + 1);
const rafAlive = () => rafHost.rafGen === rafGen;

function requestFrameTick() {
	if (!rafAlive() || rafWatchdog) return; // one request covers the whole queue
	if (frameOpsOk === null) {
		// One-shot capability probe — the decode failure lands before any
		// mutation, so a lone probe batch is side-effect free.
		frameOpsOk = false;
		deferCall((r) => {
			try {
				(r as { applyBatch?: (j: string) => unknown }).applyBatch?.('[["requestFrame"]]');
				frameOpsOk = true;
				// whatever queued during the probe gets its native wake now
				if (rafQueue.size) emit('requestFrame');
			} catch {
				/* old binding — the 16ms lane is the permanent fallback */
			}
		});
	}
	if (frameOpsOk) emit('requestFrame');
	rafWatchdog = setTimeout(
		() => {
			rafWatchdog = null;
			if (rafAlive() && rafQueue.size) tickRaf();
		},
		frameOpsOk && framesSeen ? 250 : 16,
	);
}

function tickRaf() {
	if (rafWatchdog) {
		clearTimeout(rafWatchdog);
		rafWatchdog = null;
	}
	if (!rafQueue.size) return;
	// Swap the queue first: callbacks registered during the drain run on
	// the NEXT frame, matching browser semantics.
	const cbs = rafQueue;
	rafQueue = new Map();
	const now = performance.now();
	lastTickAt = now;
	rafTicking = true;
	try {
		for (const cb of cbs.values()) {
			try {
				cb(now);
			} catch (e) {
				// report-and-continue — a throwing callback must not take
				// its same-frame siblings (or the event drain) down with it
				console.error('[gpuix] rAF callback error:', e);
			}
		}
	} finally {
		rafTicking = false;
		if (rafQueue.size) requestFrameTick();
	}
}

export function dispatchPayload(payload: { elementId: number; eventType: string; value?: string }) {
	// Every dispatch is already a clean macrotask (the TSFN callback — Rust
	// is never on the stack), so ops queued by rAF steps and listeners can
	// applyBatch in the SAME turn instead of waiting out a setTimeout hop —
	// the ~6ms hop lands animated styles a vsync late and locks the rAF
	// cycle onto every other frame at 120Hz. emit()'s deferred flush stays
	// as the fallback for contexts without this guarantee.
	try {
		dispatchPayloadInner(payload);
	} finally {
		nativeBridge.flush();
	}
}

function dispatchPayloadInner(payload: { elementId: number; eventType: string; value?: string }) {
	const rec = payload as unknown as Record<string, unknown>;
	if (payload.elementId === PLATFORM_EVENT_ID) {
		platformSink?.(payload.eventType, rec.data);
		for (const fn of platformEventListeners) {
			try {
				fn(payload.eventType, rec.data);
			} catch {
				/* listener-local, same isolation as the bus */
			}
		}
		return;
	}
	if (payload.elementId === WINDOW_EVENT_ID) {
		if (payload.eventType === 'frame') {
			// A native frame painted — tick the rAF queue. Not a DOM event.
			framesSeen = true;
			// Recorded bounds are fresh again — unless a batch still waits
			// to apply, in which case this frame predates it.
			boundsFreshAfterFrame();
			// Two windows can render on one display cycle: their frame
			// events arrive ~simultaneously and draining on each would run
			// rAF at N× the vsync rate. A sub-4ms event from a DIFFERENT
			// window than the last tick is the same cycle (a real new
			// frame is ≥4.16ms out at ≤240Hz; same-window renders always
			// tick). A nested event mid-drain drops — the swap already
			// deferred its callbacks to the next frame.
			const wid = (payload as { windowId?: number }).windowId ?? -1;
			if (!rafTicking && (wid === lastTickWindow || performance.now() - lastTickAt >= 4)) {
				lastTickWindow = wid;
				tickRaf();
			}
			return;
		}
		// window-level event → dispatch on document listeners
		dispatchType(doc as unknown as GNode, domEvent(payload.eventType), rec);
		return;
	}
	const node = nodeForNativeId(payload.elementId) as GNode | undefined;
	if (node) {
		const domType = domEvent(payload.eventType);
		if (POINTER_GESTURE.has(domType)) {
			const g = lastGesture;
			const echo =
				g && g.type === domType && g.x === rec.x && g.y === rec.y &&
				node !== g.node && node.contains(g.node);
			lastGesture = { type: domType, x: rec.x as number, y: rec.y as number, node };
			if (echo) return;
		} else {
			lastGesture = null;
		}
		dispatchNative(node, domType, rec);
		// gpuix reports clickCount on click — a second click is a dblclick
		if (domType === 'click' && (rec.clickCount as number) >= 2) dispatchNative(node, 'dblclick', rec);
	}
}

function dispatchType(
	target: GNode,
	domType: string,
	payload: Record<string, unknown>,
	extra?: Record<string, unknown>,
): GEvent {
	const event = makeEvent(domType, target, payload);
	if (extra) Object.assign(event, extra);
	// element-level listeners ($.event / addEventListener on the node)
	for (let n: GNode | null = target; n && !event.cancelBubble; n = n.parentNode) {
		event.currentTarget = n;
		n.listeners?.get(domType)?.forEach((fn) => {
			if (!event._stopped) fn.call(n, event);
		});
		if (n.nodeType === 9 || NO_BUBBLE.has(domType)) break;
	}
	event.currentTarget = undefined;
	// Svelte stamps delegated handlers post-mount via raw el[eventsSymbol]
	// writes we can't intercept — an element that just dispatched a press
	// type through one self-marks here. (The first press may already have
	// propagated natively; the mark lands for subsequent ones.)
	if (PRESS_TARGET_EVENTS.has(domType)) {
		for (const n of event.composedPath()) {
			if (n.nodeType !== 1) continue;
			const el = n as GElement;
			if (!el._customProps?.has('pressTarget') && delegatedHandlers(el)?.[domType] != null) {
				refreshPressTarget(el);
			}
		}
	}
	return event;
}

// ── tiny HTML parser for template innerHTML ───────────────────────────

const HTML_ENTITIES: Record<string, string> = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
};

function decodeEntities(s: string): string {
	return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, e) => {
		if (e[0] === '#') {
			const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : m;
		}
		return HTML_ENTITIES[e] ?? m;
	});
}

/** Tag-end scan that respects quoted attribute values (`title="a>b"`). */
function findTagEnd(html: string, i: number): number {
	let q: string | null = null;
	for (let j = i + 1; j < html.length; j++) {
		const c = html[j];
		if (q) {
			if (c === q) q = null;
		} else if (c === '"' || c === "'") q = c;
		else if (c === '>') return j;
	}
	return -1;
}

/** Raw-text elements: contents are text up to the matching close tag. */
const RAWTEXT_TAGS = new Set(['style', 'script', 'textarea', 'title']);

function parseHTML(html: string, doc: GDocument): GNode[] {
	const out: GNode[] = [];
	const stack: GNode[] = [];
	const push = (n: GNode) => {
		const top = stack[stack.length - 1];
		if (top) top.appendChild(n);
		else out.push(n);
	};
	let i = 0;
	while (i < html.length) {
		if (html[i] === '<') {
			if (html.startsWith('<!--', i)) {
				const end = html.indexOf('-->', i + 4);
				if (end === -1) {
					push(doc.createComment(html.slice(i + 4)));
					break;
				}
				push(doc.createComment(html.slice(i + 4, end)));
				i = end + 3;
			} else if (html.startsWith('<!>', i)) {
				push(doc.createComment(''));
				i += 3;
			} else if (html.startsWith('</', i)) {
				const end = html.indexOf('>', i + 2);
				if (end === -1) {
					push(doc.createTextNode(decodeEntities(html.slice(i))));
					break;
				}
				stack.pop();
				i = end + 1;
			} else {
				const end = findTagEnd(html, i);
				if (end === -1) {
					push(doc.createTextNode(decodeEntities(html.slice(i))));
					break;
				}
				const header = html.slice(i + 1, end);
				const selfClose = header.endsWith('/');
				const body = selfClose ? header.slice(0, -1) : header;
				const openTag = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(body)?.[1];
				if (!openTag) {
					// '<' not starting a tag — literal text
					push(doc.createTextNode('<'));
					i++;
					continue;
				}
				const el = doc.createElement(openTag);
				const attrRe = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
				attrRe.lastIndex = openTag.length;
				let a: RegExpExecArray | null;
				while ((a = attrRe.exec(body))) {
					if (a[0] === '') break;
					const key = a[1];
					if (key === undefined) continue;
					if (a[2] !== undefined || a[3] !== undefined || a[4] !== undefined) {
						el.attributes.set(key, decodeEntities(a[2] ?? a[3] ?? a[4] ?? ''));
					} else {
						el.attributes.set(key, '');
					}
				}
				if (el.attributes.has('style')) el.style.cssText = el.attributes.get('style')!;
				if (el.attributes.has('class')) el.className = el.attributes.get('class')!;
				push(el);
				const tag = el.tagName.toLowerCase();
				if (!selfClose && RAWTEXT_TAGS.has(tag)) {
					const close = html.toLowerCase().indexOf(`</${tag}`, end + 1);
					const rawEnd = close === -1 ? html.length : close;
					const raw = html.slice(end + 1, rawEnd);
					if (raw) {
						// style/script raw; textarea/title decode entities
						const text = tag === 'style' || tag === 'script' ? raw : decodeEntities(raw);
						el.appendChild(doc.createTextNode(text));
					}
					i = close === -1 ? html.length : findTagEnd(html, close) + 1;
				} else {
					if (!selfClose && !VOID_TAGS.has(tag)) stack.push(el);
					i = end + 1;
				}
			}
		} else {
			const next = html.indexOf('<', i);
			const text = html.slice(i, next === -1 ? html.length : next);
			if (text) push(doc.createTextNode(decodeEntities(text)));
			i = next === -1 ? html.length : next;
		}
	}
	return out;
}

// ── globals ───────────────────────────────────────────────────────────

export const doc = new GDocument();

/** Synthetic event class for dispatchEvent — real Event fields, settable target. */
class GEventBase {
	type: string;
	target: GNode | null = null;
	currentTarget: GNode | GDocument | undefined;
	defaultPrevented = false;
	cancelBubble = false;
	_stopped = false;
	bubbles: boolean;
	composed: boolean;
	eventPhase = 0;
	timeStamp = performance.now();
	isTrusted = false;
	constructor(type: string, opts: { bubbles?: boolean; composed?: boolean } = {}) {
		this.type = type;
		this.bubbles = !!opts.bubbles;
		this.composed = !!opts.composed;
	}
	preventDefault() {
		this.defaultPrevented = true;
	}
	stopPropagation() {
		this.cancelBubble = true;
	}
	stopImmediatePropagation() {
		this.cancelBubble = true;
		this._stopped = true;
	}
	composedPath() {
		return this.target ? [this.target] : [];
	}
	initEvent(t: string) {
		this.type = t;
	}
}
class GCustomEvent extends GEventBase {
	detail: unknown;
	constructor(type: string, opts: { bubbles?: boolean; composed?: boolean; detail?: unknown } = {}) {
		super(type, opts);
		this.detail = opts.detail;
	}
}

export function installGlobals() {
	const g = globalThis as Record<string, unknown>;
	const matchMedia = (q: string) => ({
		matches: false,
		media: q,
		onchange: null,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
		dispatchEvent: () => false,
	});
	g.document = doc;
	g.Node = GNode;
	g.Element = GElement;
	g.HTMLMediaElement = class HTMLMediaElement {};
	g.Text = GText;
	g.Comment = GComment;
	g.DocumentFragment = GFragment;
	g.HTMLElement = GElement;
	g.SVGElement = GElement;
	g.navigator = {
		userAgent: 'gpuix',
		onLine: true,
		clipboard: { writeText: async () => {}, readText: async () => '' },
	};
	// Declared-but-undefined: svelte's `!customElements` guard then takes the
	// plain-element path for hyphenated tags instead of a ReferenceError.
	g.customElements = undefined;
	g.Event = GEventBase;
	g.CustomEvent = GCustomEvent;
	g.matchMedia = matchMedia;
	g.window = {
		document: doc,
		navigator: g.navigator,
		scrollX: 0,
		scrollY: 0,
		devicePixelRatio: 2,
		innerWidth: 800,
		innerHeight: 600,
		requestAnimationFrame: (cb: FrameRequestCallback) => {
			if (!rafAlive()) return -1; // stale realm — never ticked
			const id = rafNextId++;
			rafQueue.set(id, cb);
			requestFrameTick();
			return id;
		},
		cancelAnimationFrame: (id: number) => {
			rafQueue.delete(id);
		},
		addEventListener: doc.addEventListener.bind(doc),
		removeEventListener: doc.removeEventListener.bind(doc),
		dispatchEvent: doc.dispatchEvent.bind(doc),
		scrollTo: () => {},
		matchMedia,
		getComputedStyle: null as unknown, // set below
		trustedTypes: undefined,
		Event: GEventBase,
		CustomEvent: GCustomEvent,
	};
	// bind:scrollY and friends call bare-global addEventListener/scrollTo
	g.addEventListener = doc.addEventListener.bind(doc);
	g.removeEventListener = doc.removeEventListener.bind(doc);
	g.scrollTo = () => {};
	g.self = g.window;
	g.requestAnimationFrame = (g.window as { requestAnimationFrame: unknown }).requestAnimationFrame;
	g.cancelAnimationFrame = (g.window as { cancelAnimationFrame: unknown }).cancelAnimationFrame;
	g.getComputedStyle = (el: GElement) => {
		// Svelte's transition fns (slide/fade/fly/flip) seed their keyframes
		// from computed style — opacity ''→0 would render the whole transition
		// invisible, height ''→NaN omits the dimension entirely, transformOrigin
		// ''→NaN kills flip's deltas. Defaults match the browser's initial
		// values; declared props (class layer + inline) override; painted
		// bounds win for width/height (the real used size — what a browser's
		// computed style returns).
		const props: Record<string, string> = {
			display: 'block',
			position: 'static',
			opacity: '1',
			width: '0px',
			height: '0px',
			zoom: '1',
			transform: 'none',
		};
		// Bounds read first — measureBounds flushes any pending ops, so the
		// native query below sees the freshest style_raw.
		const b = el?.getBoundingClientRect?.();
		// Single source: the renderer's own resolved layer map (sheet cascade
		// + setStyle payload + recipe + style-props + theme tokens). Reading
		// it back keeps computed style identical to what paints — the JS
		// mirror only serves elements without a native peer (detached /
		// pre-materialize), where Rust can't match them anyway.
		const native = el?.nativeId ? nativeBridge.computedStyle(el.nativeId) : null;
		if (native) {
			for (const [k, v] of Object.entries(native)) {
				if (COMPUTED_STATE_BUCKET.has(k)) continue;
				writeComputed(props, k, v);
			}
		} else if (el) {
			computedClassProps(el).forEach((v, k) => (props[k] = v));
		}
		// In-flight writes overlay: mergedStyleProps is author-raw (var()/
		// calc()/shorthands), so normalize through styleObject — the same
		// function that built the wire payload — instead of overlaying raw
		// strings that would clobber Rust's resolved values.
		const pending = el?.mergedStyleProps?.();
		if (pending?.size) {
			for (const [k, v] of Object.entries(styleObject(pending))) writeComputed(props, k, v);
		}
		// State buckets merge last — paint applies them over the whole merged
		// style (inline and animation frames included).
		if (native && el) {
			const bucket = (k: string, on: boolean) => {
				const v = native[k];
				if (on && v && typeof v === 'object')
					for (const [bk, bv] of Object.entries(v)) writeComputed(props, bk, bv);
			};
			bucket('hover', el._hovered);
			bucket('active', el._active);
			bucket('focus', el._focused);
			bucket('focusVisible', el._focused);
			bucket('focusWithin', stateMatches(el, 'focusWithin'));
		}
		if (b && (b.width || b.height)) {
			props.width = `${b.width}px`;
			props.height = `${b.height}px`;
		}
		// `border: 1px solid red` → `borderWidth` so the shorthand expansion
		// below can reach borderTopWidth & co (slide animates them).
		if (props.border !== undefined && props.borderWidth === undefined) {
			const w = splitCssComponents(props.border).find((tok) => /px$|thin|medium|thick/.test(tok) || DIM.test(tok));
			if (w !== undefined) props.borderWidth = w;
		}
		// A real computed style resolves box shorthands to longhands —
		// slide reads paddingTop/marginTop/borderTopWidth directly and a
		// shorthand-only props map feeds it '' → NaN → the property is
		// silently dropped from its keyframes (the box never fully
		// collapses). Author longhands win over shorthand expansion.
		for (const [short, longs] of Object.entries(BOX_SHORTHAND)) {
			const raw = props[short];
			if (raw === undefined) continue;
			const parts = splitCssComponents(raw);
			const box = [parts[0], parts[1] ?? parts[0], parts[2] ?? parts[0], parts[3] ?? parts[1] ?? parts[0]];
			longs.forEach((k, i) => {
				if (props[k] === undefined) props[k] = box[i]!;
			});
		}
		// transform-origin resolves to a px pair against the element's own
		// box (browser computed value): keywords → %, % → px, single value
		// → x with y at center. flip parseFloats each component then divides
		// by clientWidth/Height, so '50% 50%' must land as '<w/2>px <h/2>px'.
		{
			const bw = parseFloat(props.width) || 0;
			const bh = parseFloat(props.height) || 0;
			const raw = props.transformOrigin;
			const KW: Record<string, number> = { left: 0, top: 0, center: 50, right: 100, bottom: 100 };
			const toPx = (tok: string | undefined, base: number): number => {
				if (tok === undefined) return base / 2;
				const kw = KW[tok];
				if (kw !== undefined) return (kw / 100) * base;
				const p = parseFloat(tok);
				if (Number.isNaN(p)) return base / 2;
				return tok.endsWith('%') ? (p / 100) * base : p;
			};
			if (raw === undefined) {
				props.transformOrigin = `${bw / 2}px ${bh / 2}px`;
			} else {
				const parts = raw.trim().split(/\s+/);
				props.transformOrigin = `${toPx(parts[0], bw)}px ${toPx(parts[1], bh)}px`;
			}
		}
		return new Proxy(props, {
			get: (t, p) =>
				p === 'getPropertyValue'
					? (k: string) => t[k] ?? t[kebabToCamel(k)] ?? ''
					: typeof p === 'string'
						? (t[p] ?? t[camelToKebab(p)] ?? '')
						: undefined,
		});
	};
	(g.window as Record<string, unknown>).getComputedStyle = g.getComputedStyle;
	g.MutationObserver = GMutationObserver;
	g.ResizeObserver = GResizeObserver;
	// Bun ships a real FormData — extend it so `new FormData(formEl)` collects
	// inputs from the fake tree; bare construction/append/read is native Bun.
	const NativeFormData = g.FormData as typeof FormData | undefined;
	class GFormData extends (NativeFormData ?? class {}) {
		// the base is union-typed (FormData | fallback) — append is always the
		// real FormData.append at runtime; declare restores the type here.
		declare append: FormData['append'];
		constructor(form?: GElement, submitter?: GElement) {
			super();
			if (form?.nodeType === 1) {
				const walk = (n: GNode) => {
					for (const c of n.childNodes) {
						if (c.nodeType === 1) {
							const el = c as GElement;
							// browsers skip disabled controls entirely
							if (el.attributes?.has('disabled')) {
								walk(c);
								continue;
							}
							if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') && el.name) {
								const type = el.getAttribute?.('type') ?? '';
								if (type === 'checkbox' || type === 'radio') {
									if (el.checked) this.append(el.name, el.value || 'on');
								} else if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset') {
									// buttons only contribute when they're the submitter
								} else if (el.tagName === 'SELECT' && el.attributes.has('multiple')) {
									for (const o of walkElements(el)) {
										if (o.tagName === 'OPTION' && (o.selected || o.attributes.has('selected')))
											this.append(el.name, o.value ?? o.textContent);
									}
								} else {
									this.append(el.name, el.value);
								}
							}
							walk(c);
						}
					}
				};
				walk(form);
			}
			// the activated submitter's name/value is part of the submission
			if (submitter?.name && !submitter.attributes?.has('disabled')) {
				this.append(submitter.name, submitter.value ?? '');
			}
		}
	}
	g.FormData = GFormData as unknown as typeof FormData;
	doc.defaultView = g.window;
}
