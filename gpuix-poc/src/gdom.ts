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
import { allocId, bindNative, deferAfterRender, deferCall, emit, nativeBounds, nodeForNativeId, scrollOffset, unbindNative } from './native';
import * as nativeBridge from './native';

const HTML_NS = 'http://www.w3.org/1999/xhtml';

/** HTML attribute → native prop name (gpuix wants camelCase). */
const NATIVE_ATTR: Record<string, string> = {
	tabindex: 'tabIndex', autofocus: 'autoFocus', readonly: 'readOnly', maxlength: 'maxLength',
};
const nativeAttrName = (k: string) => NATIVE_ATTR[k.toLowerCase()] ?? k;
const nativeAttrValue = (k: string, v: string) => {
	const n = NATIVE_ATTR[k.toLowerCase()];
	if (n === 'autoFocus') return v !== 'false';
	if (n === 'tabIndex' || n === 'maxLength') { const f = parseInt(v, 10); return Number.isFinite(f) ? f : v; }
	return v;
};
/** Sentinel elementId for window-level key events delivered via setWindowKeyEvents. */
export const WINDOW_EVENT_ID = 0x7fffff01;

const GPUIX_TAGS = new Set([
	'div', 'text', 'img', 'svg', 'canvas', 'input', 'textarea',
	'anchored', 'code', 'diff', 'markdown', 'virtual-list',
]);
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
	// overlay + native-element events
	mousedownoutside: 'mouseDownOutside', auxclick: 'auxClick',
	contextmenu: 'contextMenu', visiblerange: 'visibleRange',
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
};
// One native event can map to several DOM dispatches (browser semantics):
// gpuix 'change' per-edit = DOM input+change; focus/blur = focus+focusin etc.
const NATIVE_FANOUT: Record<string, string[]> = {
	change: ['input', 'change'],
	focus: ['focus', 'focusin'],
	blur: ['blur', 'focusout'],
	mouseover: ['mouseover', 'mouseenter'],
	mouseout: ['mouseout', 'mouseleave'],
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
		const selectors = m[1].trim();
		if (selectors.startsWith('@')) continue;
		const props = new Map<string, string>();
		for (const decl of m[2].split(';')) {
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
			const st = /:(hover|focus-visible|focus|active)$/.exec(unesc);
			const state = st ? (st[1] === 'focus-visible' ? 'focus' : st[1]) : undefined;
			const s2 = state ? s0.slice(0, s0.lastIndexOf(':')) : s0;
			if (!state && unesc.includes(':')) continue; // other pseudos still dropped
			const parts = s2.split(/[\s>+~]+/).filter(Boolean);
			// descendant/child selectors need ancestor evaluation we don't do —
			// applying only the last compound would match far too much
			// (e.g. `.x > button{display:none}` would hide EVERY button)
			if (parts.length !== 1) continue;
			const compound = parts[0];
			if (!compound) continue;
			const required = [...compound.matchAll(/\.((?:\\.|[^\s.>+~:[\]])+)/g)].map((x) =>
				x[1].replace(/\\(.)/g, '$1'), // tailwind escapes: .w-\(--x\) → w-(--x)
			);
			const attrs: [string, string | true][] = [
				...compound.matchAll(/\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/g),
			].map((x) => [x[1], x[2] === undefined || x[2] === '' ? true : x[2]]);
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
			if (hasStateRules && el.nativeId) {
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
	for (const r of ordered) {
		if (!r.state || !match(r)) continue;
		if (r.state === 'hover' && !el._hovered) continue;
		if (r.state === 'focus' && !el._focused) continue;
		if (r.state === 'active' && !el._active) continue;
		for (const [k, v] of r.props) el._classProps.set(k, v);
	}
	if (el.nativeId) el.style.push();
}

/** kit lane: install/replace a resolved native StyleDesc — bypasses the CSS
 *  engine entirely; merged into every subsequent style push. */
export function applyNativeStyle(el: GElement, style: Record<string, unknown> | null) {
	el._nativeStyle = style;
	if (el.nativeId) el.style.push();
}

function gpuixTag(tag: string) {
	return GPUIX_TAGS.has(tag) ? tag : 'div';
}
function gpuixEvent(dom: string) {
	return DOM_TO_GPUIX_EVENT[dom] ?? dom;
}
export function domEvent(gpuix: string) {
	return GPUIX_TO_DOM_EVENT[gpuix] ?? gpuix;
}

/** Event types Svelte delegated onto document/target roots. */
const delegatedTypes = new Set<string>();

/** (nativeId, eventType) pairs already sent — avoids duplicate setEventListener ops. */
const registeredEvents = new Set<string>();

function emitListener(el: GElement, domType: string) {
	const key = `${el.nativeId}:${domType}`;
	if (el.nativeId && !registeredEvents.has(key)) {
		registeredEvents.add(key);
		emit('setEventListener', el.nativeId, gpuixEvent(domType), true);
	}
}

// focus/key events only reach focusable elements natively — fanning them out
// to every div just creates a FocusHandle per element and pollutes tab order
const FOCUS_KEY_TYPES = new Set(['keydown', 'keyup', 'keypress', 'focus', 'blur', 'focusin', 'focusout']);
const isFocusable = (el: GElement) =>
	el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
	el.attributes?.has('tabindex') || el.attributes?.has('contenteditable');

/** Svelte registers delegated listeners *after* the tree materializes — backfill. */
function backfillDelegated(type: string) {
	const visit = (n: GNode) => {
		if (n.nodeType === 1 && (!FOCUS_KEY_TYPES.has(type) || isFocusable(n as GElement))) emitListener(n as GElement, type);
		n.childNodes.forEach(visit);
	};
	visit(doc.documentElement);
}

export class GNode {
	nodeType = 0;
	childNodes: GNode[] = [];
	parentNode: GNode | null = null;
	ownerDocument: GDocument | null = null;
	nativeId = 0;
	listeners: Map<string, Set<EventListener>> | null = null;
	private _data = '';
	get data() {
		return this._data;
	}
	set data(v: string) {
		this._data = v;
		if (this.nodeType !== 3) return;
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
		// state — scroll, focus, hover); insertBefore/appendChild moves it
		// natively. Detach without dematerializing.
		const keepNative = !!child.nativeId && this.isConnected && !!this.nativeId;
		const oldParent = child.parentNode;
		if (oldParent) {
			const oi = oldParent.childNodes.indexOf(child);
			if (oi !== -1) oldParent.childNodes.splice(oi, 1);
			child.parentNode = null;
			queueMutation({ type: 'childList', target: oldParent, addedNodes: [], removedNodes: [child] });
			if (!keepNative) dematerialize(child);
		}
		const idx = ref ? this.childNodes.indexOf(ref) : -1;
		if (ref && idx === -1) throw new Error('insertBefore: ref not a child');
		if (idx === -1) this.childNodes.push(child);
		else this.childNodes.splice(idx, 0, child);
		child.parentNode = this;
		child.ownerDocument = this.nodeType === 9 ? (this as unknown as GDocument) : this.ownerDocument;
		queueMutation({ type: 'childList', target: this, addedNodes: [child], removedNodes: [] });
		if (this.isConnected && this.nativeId) {
			if (!keepNative) materialize(child);
			if (child.nativeId) {
				const before = ref ? nativeBeforeId(this, ref) : 0;
				if (before) emit('insertBefore', this.nativeId, child.nativeId, before);
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
		this.listeners!.get(type)!.add(fn);
		if (this.nodeType === 1) emitListener(this as unknown as GElement, type);
	}
	removeEventListener(type: string, fn: EventListener) {
		this.listeners?.get(type)?.delete(fn);
	}
	dispatchEvent(event: GEvent): boolean {
		if (!event.target) (event as { target: GNode }).target = this;
		for (let n: GNode | null = this; n && !event.cancelBubble; n = n.parentNode) {
			event.currentTarget = n;
			n.listeners?.get(event.type)?.forEach((fn) => {
				if (!event._stopped) fn.call(n, event);
			});
			if (n.nodeType === 9 || (event.bubbles === false && n !== this)) break;
		}
		event.currentTarget = undefined;
		return !event.defaultPrevented;
	}
}

export class GText extends GNode {
	nodeType = 3;
	constructor(data = '') {
		super();
		this.data = data;
	}
	cloneShallow() {
		const c = new GText(this.data);
		c.ownerDocument = this.ownerDocument;
		return c as GNode;
	}
}

export class GComment extends GNode {
	nodeType = 8;
	constructor(data = '') {
		super();
		this.data = data;
	}
	cloneShallow() {
		const c = new GComment(this.data);
		c.ownerDocument = this.ownerDocument;
		return c as GNode;
	}
}

export class GFragment extends GNode {
	nodeType = 11;
	cloneShallow() {
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
					t.props.set(k, String(v));
					t.push();
					return true;
				}
				(t as any)[k] = v;
				return true;
			},
			get(t, k) {
				if (k in t) return (t as any)[k];
				return t.props.get(k as string);
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
	if (!m) return null;
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
		if (!m) return null;
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

function toNumber(v: string): number | null {
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
				const g = parseFloat(p[0]);
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
			const rep = /^repeat\(\s*(\d+)/.exec(v);
			const n = rep ? +rep[1] : toNumber(v);
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
				if (m && !/#0{4}|#0000|transparent/i.test(m[6])) {
					out.boxShadow = {
						inset: !!m[1], offsetX: +m[2], offsetY: +m[3],
						blurRadius: +(m[4] ?? 0), spreadRadius: +(m[5] ?? 0), color: m[6],
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
function nativeStyleFor(el: GElement) {
	const props = el.mergedStyleProps();
	const out = styleObject(props);
	// kit lane: pre-resolved native props (incl. hover/active sub-styles) win
	// over css-derived values and skip the string->native conversion entirely
	if (el._nativeStyle) Object.assign(out, el._nativeStyle);
	for (const k of INHERITABLE) {
		if (out[k] !== undefined && out[k] !== 'inherit') continue;
		for (let p = el.parentNode; p; p = p.parentNode) {
			if (p.nodeType !== 1) continue;
			const pe = p as GElement;
			const nv = pe._nativeStyle?.[k];
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
	constructor(cb: (entries: { target: GElement }) => void) {
		this.cb = cb as (entries: { target: GElement }[]) => void;
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
	nodeType = 1;
	tagName: string;
	namespaceURI = HTML_NS;
	attributes = new Map<string, string>();
	style: GStyle;
	private _className = '';
	/** style props derived from scoped-CSS class rules — merged under inline props */
	_classProps = new Map<string, string>();
	/** kit lane: resolved native StyleDesc — wins over css-derived props */
	_nativeStyle: Record<string, unknown> | null = null;
	/** interaction state for :hover/:focus/:active class rules */
	_hovered = false;
	_focused = false;
	_active = false;
	constructor(tag: string) {
		super();
		this.tagName = tag.toUpperCase();
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
		this.attributes.set('class', this._className);
		applyClassStyles(this);
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
	setCustomProp(k: string, v: unknown) {
		(this._customProps ??= new Map()).set(k, v);
		if (this.nativeId) emit('setCustomProp', this.nativeId, k, v);
	}
	removeCustomProp(k: string) {
		this._customProps?.delete(k);
		if (this.nativeId) emit('setCustomProp', this.nativeId, k, null);
	}
	setAttribute(k: string, v: string) {
		const old = this.attributes.get(k) ?? null;
		this.attributes.set(k, String(v));
		queueMutation({ type: 'attributes', target: this, addedNodes: [], removedNodes: [], attributeName: k, oldValue: old });
		if (k === 'class') this.className = v;
		else if (k === 'style') this.style.cssText = v;
		else applyClassStyles(this); // [data-*]/[aria-*] rule conditions may flip
		if (!this.nativeId) return;
		if (k !== 'class' && k !== 'style') {
			emit('setCustomProp', this.nativeId, nativeAttrName(k), nativeAttrValue(k, v));
		}
	}
	getAttribute(k: string) {
		return this.attributes.get(k) ?? null;
	}
	hasAttribute(k: string) {
		return this.attributes.has(k);
	}
	removeAttribute(k: string) {
		this.attributes.delete(k);
		if (k === 'class') {
			this._className = '';
			applyClassStyles(this);
		} else if (k === 'style') {
			this.style.props.clear();
			this.style.push();
		} else {
			applyClassStyles(this);
		}
		if (this.nativeId) emit('setCustomProp', this.nativeId, k, null);
	}
	getAttributeNames() {
		return [...this.attributes.keys()];
	}
	get id() {
		return this.attributes.get('id') ?? '';
	}
	set id(v: string) {
		this.attributes.set('id', v);
	}
	get type() {
		return this.attributes.get('type') ?? '';
	}
	set type(v: string) {
		this.attributes.set('type', String(v));
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
		this.attributes.set('value', String(v));
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
		this.attributes.set('value', String(v));
	}
	get checked() {
		return this.attributes.has('checked');
	}
	set checked(v: boolean) {
		if (v) this.attributes.set('checked', '');
		else this.attributes.delete('checked');
		if (this.nativeId) emit('setCustomProp', this.nativeId, 'checked', Boolean(v));
	}
	get defaultChecked() {
		return this.attributes.has('checked');
	}
	set defaultChecked(v: boolean) {
		if (v) this.attributes.set('checked', '');
		else this.attributes.delete('checked');
	}
	get name() {
		return this.attributes.get('name') ?? '';
	}
	set name(v: string) {
		this.attributes.set('name', String(v));
	}
	get method() {
		return this.attributes.get('method') ?? '';
	}
	set method(v: string) {
		this.attributes.set('method', String(v));
	}
	get action() {
		return this.attributes.get('action') ?? '';
	}
	set action(v: string) {
		this.attributes.set('action', String(v));
	}
	get href() {
		return this.attributes.get('href') ?? '';
	}
	set href(v: string) {
		this.attributes.set('href', String(v));
	}
	get formmethod() {
		return this.attributes.get('formmethod') ?? '';
	}
	set formmethod(v: string) {
		this.attributes.set('formmethod', String(v));
	}
	get formaction() {
		return this.attributes.get('formaction') ?? '';
	}
	set formaction(v: string) {
		this.attributes.set('formaction', String(v));
	}
	get enctype() {
		return this.attributes.get('enctype') ?? '';
	}
	set enctype(v: string) {
		this.attributes.set('enctype', String(v));
	}
	get placeholder() {
		return this.attributes.get('placeholder') ?? '';
	}
	set placeholder(v: string) {
		this.attributes.set('placeholder', String(v));
	}
	get target() {
		return this.attributes.get('target') ?? '';
	}
	set target(v: string) {
		this.attributes.set('target', String(v));
	}
	get disabled() {
		return this.attributes.has('disabled');
	}
	set disabled(v: boolean) {
		if (v) this.attributes.set('disabled', '');
		else this.attributes.delete('disabled');
	}
	get selected() {
		return this.attributes.has('selected');
	}
	set selected(v: boolean) {
		if (v) this.attributes.set('selected', '');
		else this.attributes.delete('selected');
	}
	get multiple() {
		return this.attributes.has('multiple');
	}
	set multiple(v: boolean) {
		if (v) this.attributes.set('multiple', '');
		else this.attributes.delete('multiple');
	}
	get readOnly() {
		return this.attributes.has('readonly');
	}
	set readOnly(v: boolean) {
		if (v) this.attributes.set('readonly', '');
		else this.attributes.delete('readonly');
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
		return nativeBounds(this.nativeId);
	}
	/** class-derived props merged under inline props (inline wins). */
	mergedStyleProps(): Map<string, string> {
		const m = new Map(this._classProps);
		for (const [k, v] of this.style.props) m.set(k, v);
		return m;
	}
	override getBoundingClientRect() {
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
			if (idx >= 0) deferCall((r) => r.scrollToItem?.(parent.nativeId, idx, 0));
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
	cloneShallow() {
		const c = new GElement(this.tagName);
		c.ownerDocument = this.ownerDocument;
		for (const [k, v] of this.attributes) c.attributes.set(k, v);
		for (const [k, v] of this.style.props) c.style.props.set(k, v);
		if (this._className) c.className = this._className; // via setter: attrs + class styles
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
	animate(keyframes: Record<string, unknown>[], opts: { duration?: number; delay?: number; fill?: string; iterations?: number; direction?: string } = {}) {
		const duration = opts.duration ?? 0;
		const delay = opts.delay ?? 0;
		const iterations = opts.iterations ?? 1;
		const alternate = opts.direction === 'alternate';
		const start = performance.now() + delay;
		const frames = keyframes.map((kf) => {
			const { offset, easing, ...props } = kf as Record<string, unknown>;
			return props as Record<string, string>;
		});
		const first = frames[0] ?? {};
		const last = frames[frames.length - 1] ?? {};
		let done = false;
		let finishedResolve: () => void;
		const finished = new Promise<void>((res) => (finishedResolve = res));
		const apply = (props: Record<string, string>) => {
			for (const [k, v] of Object.entries(props)) this.style.props.set(k, String(v));
			this.style.push();
		};
		const interp = (a: string, b: string, t: number) => {
			const pa = parseFloat(a), pb = parseFloat(b);
			if (isNaN(pa) || isNaN(pb)) return t < 1 ? a : b;
			const unit = String(b).replace(/^[-\d.]+/, ''); // preserve the target's unit (%, px…)
			return String(pa + (pb - pa) * t) + unit;
		};
		const anim = {
			finished,
			onfinish: null as null | (() => void),
			currentTime: 0,
			playState: 'idle' as string,
			cancel: () => {
				done = true;
				anim.playState = 'idle';
				finishedResolve();
			},
			finish: () => {
				done = true;
				anim.playState = 'finished';
				apply(last);
				finishedResolve();
				anim.onfinish?.();
			},
			pause: () => {
				anim.playState = 'paused';
			},
			play: () => {
				anim.playState = 'running';
			},
			persist: () => {},
			playbackRate: 1,
		};
		const step = () => {
			if (done) return;
			const elapsed = Math.max(0, performance.now() - start);
			if (elapsed <= 0) {
				requestAnimationFrame(step);
				return;
			}
			anim.playState = 'running';
			anim.currentTime = elapsed;
			const iter = duration === 0 ? iterations : elapsed / duration;
			let t: number;
			if (iter >= iterations) {
				// final position: normal ends at 1; alternate ends 0 on even counts
				t = alternate && iterations % 2 === 0 ? 0 : 1;
			} else {
				const whole = Math.floor(iter);
				t = iter - whole;
				if (alternate && whole % 2 === 1) t = 1 - t;
			}
			const frame: Record<string, string> = {};
			for (const k of Object.keys(last)) {
				frame[k] = interp(String(first[k] ?? last[k]), String(last[k]), t);
			}
			apply(frame);
			if (iter < iterations) requestAnimationFrame(step);
			else {
				done = true;
				anim.playState = 'finished';
				finishedResolve();
				anim.onfinish?.();
			}
		};
		requestAnimationFrame(step);
		return anim as unknown as Animation;
	}
	getAnimations() {
		return [];
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
	const notAttrs = [...sel.matchAll(/:not\(\[([\w-]+)\]\)/g)].map((m) => m[1]);
	const wantChecked = /:checked/.test(sel);
	const wantDisabled = /:disabled/.test(sel);
	const attrs: [string, string?][] = [...sel.matchAll(/\[([\w-]+)(?:=["']([^"']*)["'])?\]/g)].map(
		(m) => [m[1], m[2]],
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

export class GDocument extends GNode {
	nodeType = 9;
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
	createElementNS(_ns: string, tag: string) {
		return this.createElement(tag);
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
	// class rules may have been parsed while this element was detached —
	// recompute at materialize time so late-inserted nodes aren't left unstyled
	applyClassStyles(el);
	const merged = el.mergedStyleProps();
	if (merged.size || el._nativeStyle) emit('setStyle', id, nativeStyleFor(el));
	for (const [k, v] of el.attributes) {
		if (k === 'style') {
			el.style.cssText = v;
		} else if (k === 'class') {
			el.className = v;
		} else {
			emit('setCustomProp', id, nativeAttrName(k), nativeAttrValue(k, v));
		}
	}
	if (el._customProps) for (const [k, v] of el._customProps) emit('setCustomProp', id, k, v);
	for (const t of delegatedTypes) {
		if (FOCUS_KEY_TYPES.has(t) && !isFocusable(el)) continue;
		emitListener(el, t);
	}
	if (el.listeners) {
		for (const t of el.listeners.keys()) emitListener(el, t);
	}
	// :hover/:active styling needs pointer events even when no JS listener exists
	if (hasStateRules) {
		for (const t of ['mouseover', 'mouseout', 'mousedown', 'mouseup']) emitListener(el, t);
	}
	// text inputs need a FocusHandle — gpuix creates one only when focus/key listeners exist
	if (tag === 'input' || tag === 'textarea') {
		for (const t of ['focus', 'blur', 'keydown', 'keyup', 'input', 'change']) {
			emitListener(el, t);
		}
	}
	for (const c of node.childNodes) {
		materialize(c);
		if (c.nativeId) emit('appendChild', id, c.nativeId);
	}
}

/** Materialize the mount target itself and register it as the native root. */
export function materializeRoot(el: GElement) {
	if (el.nativeId) return;
	const id = allocId();
	el.nativeId = id;
	bindNative(id, el);
	emit('createElement', id, 'div');
	emit('setStyle', id, { display: 'flex', flexDirection: 'column', flexGrow: 1 });
	emit('setRoot', id);
	for (const c of el.childNodes) {
		materialize(c);
		if (c.nativeId) emit('appendChild', id, c.nativeId);
	}
}

/** Clear native ids + registry entries for a detached subtree.
 *  Only the subtree root emits destroyElement — native destroy cascades
 *  (applyBatch returns all destroyed ids, consumed in flush()). */
function dematerialize(node: GNode, emitDestroy = true) {
	if (doc.activeElement === node) doc.activeElement = null; // no stale focus ref
	if (node.nativeId) {
		if (emitDestroy) emit('destroyElement', node.nativeId);
		for (const k of registeredEvents) if (k.startsWith(node.nativeId + ':')) registeredEvents.delete(k);
		unbindNative(node.nativeId);
		node.nativeId = 0;
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

export function makeEvent(domType: string, target: GNode, payload: Record<string, unknown>): GEvent {
	const path: GNode[] = [];
	for (let n: GNode | null = target; n; n = n.parentNode) path.push(n);
	const mods = (payload.modifiers ?? {}) as Record<string, unknown>;
	return {
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
	}
	// interaction-state tracking for :hover/:active/:focus class rules —
	// native pointer/focus events are authoritative (same as the browser)
	if (target instanceof GElement) {
		const t = target as GElement;
		const before = [t._hovered, t._focused, t._active];
		if (domType === 'mouseover') t._hovered = true;
		else if (domType === 'mouseout') t._hovered = false;
		else if (domType === 'mousedown') t._active = true;
		else if (domType === 'mouseup') t._active = false;
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
			(globalThis as Record<string, unknown>).__kitGoto?.(href);
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
export function dispatchPayload(payload: { elementId: number; eventType: string; value?: string }) {
	const rec = payload as unknown as Record<string, unknown>;
	if (payload.elementId === WINDOW_EVENT_ID) {
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
	const push = (n: GNode) => (stack.length ? stack[stack.length - 1].appendChild(n) : out.push(n));
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
				const m = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(body);
				if (!m) {
					// '<' not starting a tag — literal text
					push(doc.createTextNode('<'));
					i++;
					continue;
				}
				const el = doc.createElement(m[1]);
				const attrRe = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
				attrRe.lastIndex = m[0].length;
				let a: RegExpExecArray | null;
				while ((a = attrRe.exec(body))) {
					if (a[0] === '') break;
					if (a[2] !== undefined || a[3] !== undefined || a[4] !== undefined) {
						el.attributes.set(a[1], decodeEntities(a[2] ?? a[3] ?? a[4] ?? ''));
					} else {
						el.attributes.set(a[1], '');
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
		requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
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
		const props: Record<string, string> = { position: 'static', width: '0px', height: '0px' };
		el?.style?.props.forEach((v, k) => (props[k] = v));
		return new Proxy(props, {
			get: (t, p) =>
				typeof p === 'string'
					? (t[p] ?? t[camelToKebab(p)] ?? '')
					: p === 'getPropertyValue'
						? (k: string) => t[k] ?? t[kebabToCamel(k)] ?? ''
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
