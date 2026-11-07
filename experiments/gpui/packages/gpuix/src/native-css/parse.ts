/**
 * Compile-time half of the CSS → native-styling pipeline.
 *
 * Parses a `<style>` block into structured `NativeStyleRule`s that the Rust
 * style engine matches and resolves at runtime. JS only normalizes and
 * forwards payloads — Rust owns resolution — so `decls` is passed through as
 * verbatim CSS declaration text (no camelCase, no value interpretation).
 *
 * Supported selector surface: compounds (`.a.b`, `div.x`, `#id`, `*`),
 * attribute selectors (`[a]`, `[a=b]`, `[a~=b]`, `[a|=b]`, `[a^=b]`, `[a$=b]`,
 * `[a*=b]`), `:not(compound)` (and `:not(c1, c2)` — the list flattens to one
 * `not` comp per entry), the four combinators (` `, `>`, `+`, `~`), and the
 * five interactive state pseudo-classes. Anything richer — pseudo-elements,
 * other pseudo-classes, combinators inside `:not()`, at-rules — is dropped
 * with a warning. A `state` comp may only appear in the RIGHTMOST compound:
 * ancestor-state rules (`.a:hover .b`) cannot route into this element's
 * buckets, so they drop.
 */

import { transform, Features } from 'lightningcss';
import type {
	Location2,
	Rule,
	Selector,
	SelectorComponent,
	StyleRule,
	StyleSheet,
} from 'lightningcss';
import { nativeAttrName, nativeAttrValue } from '../native-attr.ts';

export type SelComp =
	| { k: 'tag'; v: string } // element type selector: div, span… matches native element_type
	| { k: 'class'; v: string } // .foo — matches a token of the element's `class` attr
	| { k: 'id'; v: string } // #bar — matches the element's `id` attr
	| { k: 'universal' } // *
	| { k: 'state'; v: 'hover' | 'active' | 'focus' | 'focusWithin' | 'focusVisible' }
	| { k: 'comb'; v: ' ' | '>' | '+' | '~' } // separates two compounds; ancestor/sibling context
	| { k: 'attr'; v: string; op?: AttrOp; x?: unknown } // [name], [name op value] — v is the NATIVE prop name
	| { k: 'not'; sel: SelComp[] }; // :not(compound) — inner holds one compound, no comb/state/not

export type AttrOp = '=' | '~=' | '|=' | '^=' | '$=' | '*=';

export interface NativeStyleRule {
	sel: SelComp[]; // compound selector — ALL comps match the SAME element
	decls: string; // raw CSS declarations text, e.g. "color:#fff; padding:4px" — passed verbatim to Rust
	spec: [number, number, number]; // CSS specificity [ids, classes+pseudos, types]
	order: number; // source order index across the whole parse
}

/** Declared-CSS-animation contract — lowered onto element.animate() by gdom
 *  (the CSS→WAAPI lowering browsers perform). These never cross the native
 *  wire: JS orchestrates animation timing, as it does for every animation. */
export interface CssKeyframesDef {
	name: string;
	frames: { offset: number; props: Record<string, string> }[];
}
export interface CssAnimationSpec {
	name: string;
	duration: number; // ms
	delay: number; // ms
	iterations: number | 'infinite'; // 'infinite' survives JSON (Infinity → null)
	direction: string; // normal | reverse | alternate | alternate-reverse
	easing: string; // CSS timing-function keyword
	fill: string; // none | forwards | backwards | both
}
export interface CssAnimationRule {
	classes: string[]; // required class tokens — compound-class selectors only
	tag?: string;
	spec: CssAnimationSpec;
	spec3: [number, number, number]; // selector specificity — cascade tie-break
	order: number; // source order within the sheet
}

export interface ParseResult {
	rules: NativeStyleRule[];
	warnings: string[];
	keyframes: CssKeyframesDef[];
	animations: CssAnimationRule[];
}

type StateKind = 'hover' | 'active' | 'focus' | 'focusWithin' | 'focusVisible';

const STATE_PSEUDOS: Record<string, StateKind> = {
	hover: 'hover',
	active: 'active',
	focus: 'focus',
	'focus-within': 'focusWithin',
	'focus-visible': 'focusVisible',
};

/** Hard cap on selector expansion when `&` meets a multi-selector parent. */
const MAX_EXPANDED_SELECTORS = 128;

interface MappedSelector {
	comps: SelComp[];
	spec: [number, number, number];
}

export function parseStylesheet(css: string): ParseResult {
	const rules: NativeStyleRule[] = [];
	const warnings: string[] = [];
	let order = 0;

	let sheet: StyleSheet | undefined;
	try {
		const res = transform({
			filename: 'style.css',
			code: new TextEncoder().encode(css),
			// Parse (and nominally expand) nesting; `:global()` needs cssModules
			// mode to parse as a selector rather than an unknown pseudo-class.
			// Both only affect the (discarded) output code — the visitor sees
			// the parsed AST with original names.
			include: Features.Nesting,
			cssModules: true,
			errorRecovery: true,
			visitor: {
				StyleSheet(s) {
					sheet = s as StyleSheet;
				},
			},
		});
		for (const w of res.warnings ?? []) {
			// NB: warning loc.line is 1-based (rule loc.line is 0-based).
			warnings.push(`lightningcss: ${w.message} (line ${w.loc.line})`);
		}
	} catch (e) {
		warnings.push(`parse error: ${e instanceof Error ? e.message : String(e)}`);
		return { rules, warnings, keyframes: [], animations: [] };
	}
	if (!sheet) {
		warnings.push('parse error: no stylesheet produced');
		return { rules, warnings, keyframes: [], animations: [] };
	}

	// --- source-position helpers -------------------------------------------------

	const lineStarts: number[] = [0];
	for (let i = 0; i < css.length; i++) {
		if (css.charCodeAt(i) === 10) lineStarts.push(i + 1);
	}
	/** Location2 → UTF-16 offset. `line` is 0-based, `column` 1-based. */
	const offsetOf = (loc: Location2): number => {
		const start = lineStarts[loc.line];
		return start === undefined ? css.length : start + loc.column - 1;
	};

	const skipString = (i: number): number => {
		const q = css.charCodeAt(i);
		i++;
		while (i < css.length) {
			const c = css.charCodeAt(i);
			if (c === 92 /* \ */) i += 2;
			else if (c === q) return i + 1;
			else i++;
		}
		return i;
	};
	const skipComment = (i: number): number => {
		const end = css.indexOf('*/', i + 2);
		return end < 0 ? css.length : end + 2;
	};

	/** First `{` at/after `from`, skipping strings and comments. -1 on `;`, `}` or EOF. */
	const scanToBrace = (from: number): number => {
		let i = from;
		while (i < css.length) {
			const c = css.charCodeAt(i);
			if (c === 34 || c === 39) i = skipString(i);
			else if (c === 47 && css.charCodeAt(i + 1) === 42) i = skipComment(i);
			else if (c === 123) return i;
			else if (c === 125 || c === 59) return -1;
			else i++;
		}
		return -1;
	};

	/** Index of the `}` matching `open` (which must point at `{`), or css.length. */
	const matchBrace = (open: number): number => {
		let depth = 1;
		let i = open + 1;
		while (i < css.length) {
			const c = css.charCodeAt(i);
			if (c === 34 || c === 39) i = skipString(i);
			else if (c === 47 && css.charCodeAt(i + 1) === 42) i = skipComment(i);
			else if (c === 123) {
				depth++;
				i++;
			} else if (c === 125) {
				if (--depth === 0) return i;
				i++;
			} else i++;
		}
		return css.length;
	};

	/**
	 * Slice the verbatim declaration text out of a style rule's `{ … }` block.
	 * Nested rule spans (except `nested-declarations`, which *are* declarations)
	 * are cut out so `decls` only contains declaration text.
	 */
	const extractDecls = (sr: StyleRule): string | null => {
		const open = scanToBrace(offsetOf(sr.loc));
		if (open < 0) return null;
		const close = matchBrace(open);
		const inner = css.slice(open + 1, close);

		const cuts: Array<[number, number]> = [];
		for (const r of sr.rules ?? []) {
			if (r.type === 'nested-declarations' || r.type === 'ignored') continue;
			const loc = (r as { value?: { loc?: Location2 } }).value?.loc;
			if (!loc) continue;
			const ns = offsetOf(loc);
			if (ns <= open || ns >= close) continue;
			const nOpen = scanToBrace(ns);
			let end: number;
			if (nOpen >= 0 && nOpen < close) end = matchBrace(nOpen) + 1;
			else {
				// Block-less construct (e.g. `@import x;`): cut to its `;` or the block end.
				const semi = css.indexOf(';', ns);
				end = semi >= 0 && semi < close ? semi + 1 : close;
			}
			// Swallow a `;` following the nested rule.
			let j = end;
			while (j < close && /\s/.test(css[j]!)) j++;
			if (css[j] === ';') end = j + 1;
			cuts.push([ns - open - 1, Math.min(end, close) - open - 1]);
		}
		cuts.sort((x, y) => x[0] - y[0]);
		let decls = '';
		let pos = 0;
		for (const [s, e] of cuts) {
			decls += inner.slice(pos, s);
			pos = Math.max(pos, e);
		}
		decls += inner.slice(pos);
		return decls.trim();
	};

	// --- declared CSS animation extraction -----------------------------------------
	// `@keyframes`/`animation:` are NOT forwarded to Rust — gdom lowers them
	// onto element.animate() (the CSS→WAAPI lowering). Frames/specs are parsed
	// here from the raw source so registration can ship them JS-side.

	const keyframes: CssKeyframesDef[] = [];
	const animations: CssAnimationRule[] = [];

	const kebabToCamel = (s: string): string => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

	const parseDeclText = (body: string): Record<string, string> => {
		const props: Record<string, string> = {};
		for (const decl of body.split(';')) {
			const i = decl.indexOf(':');
			if (i === -1) continue;
			const k = decl.slice(0, i).trim();
			const v = decl.slice(i + 1).trim().replace(/\s*!important\s*$/, '');
			if (k && v) props[k.startsWith('--') ? k : kebabToCamel(k)] = v;
		}
		return props;
	};

	/** `@keyframes name { … }` — walk `selector { decls }` entries inside the
	 *  rule's own source span; selector lists (0%, 50%, from, to) expand to
	 *  one frame per selector. */
	const extractKeyframes = (ruleLoc: Location2, name: string): void => {
		const open = scanToBrace(offsetOf(ruleLoc));
		if (open < 0) {
			warnings.push(`@keyframes ${name}: could not locate block — dropped`);
			return;
		}
		const close = matchBrace(open);
		const frames: CssKeyframesDef['frames'] = [];
		let i = open + 1;
		while (i < close) {
			const b = css.indexOf('{', i);
			if (b === -1 || b >= close) break;
			const selText = css.slice(i, b).trim();
			const end = Math.min(matchBrace(b), close);
			const props = parseDeclText(css.slice(b + 1, end));
			for (const sel of selText.split(',')) {
				const s = sel.trim().toLowerCase();
				const offset =
					s === 'from' ? 0 : s === 'to' ? 1 : s.endsWith('%') ? parseFloat(s) / 100 : NaN;
				if (Number.isFinite(offset)) frames.push({ offset, props });
			}
			i = end + 1;
		}
		if (frames.length) keyframes.push({ name, frames });
		else warnings.push(`@keyframes ${name}: no usable keyframes — dropped`);
	};

	const parseTime = (v: string): number | null => {
		const m = /^(-?[\d.]+)(ms|s)$/.exec(v.trim());
		if (!m) return null;
		const n = parseFloat(m[1]!);
		return m[2] === 's' ? n * 1000 : n;
	};

	/** `animation:` shorthand + `animation-*` longhands → one animate() spec.
	 *  Multiple comma animations collapse to the first — one animation
	 *  channel per element. Decls process in order so a shorthand resets and
	 *  later longhands override, matching CSS. */
	const extractAnimation = (decls: string): CssAnimationSpec | null => {
		const f = {
			name: '',
			duration: 0,
			delay: 0,
			iterations: 1,
			direction: 'normal',
			easing: 'ease',
			fill: 'none',
		};
		const applyShorthand = (value: string): void => {
			// shorthand resets everything it doesn't set
			f.name = ''; f.duration = 0; f.delay = 0; f.iterations = 1;
			f.direction = 'normal'; f.easing = 'ease'; f.fill = 'none';
			const first = value.split(',')[0]!.trim();
			// cubic-bezier()/steps() carry spaces inside parens — protect them
			// before tokenizing on whitespace.
			for (const tok of first.replace(/\([^)]*\)/g, (m) => m.replace(/\s+/g, ' ')).split(/\s+/)) {
				if (!tok) continue;
				const time = parseTime(tok);
				if (time !== null) {
					if (!f.duration) f.duration = time;
					else if (!f.delay) f.delay = time;
					continue;
				}
				if (tok === 'infinite' || /^\d+$/.test(tok)) {
					f.iterations = tok === 'infinite' ? 'infinite' : parseInt(tok, 10);
					continue;
				}
				if (['normal', 'reverse', 'alternate', 'alternate-reverse'].includes(tok)) {
					f.direction = tok;
					continue;
				}
				if (['none', 'forwards', 'backwards', 'both'].includes(tok)) {
					f.fill = tok;
					continue;
				}
				if (['running', 'paused'].includes(tok)) continue; // play-state — no channel
				if (
					['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end'].includes(tok) ||
					tok.startsWith('cubic-bezier') ||
					tok.startsWith('steps(')
				) {
					f.easing = tok;
					continue;
				}
				if (!f.name) f.name = tok;
			}
		};
		for (const decl of decls.split(';')) {
			const i = decl.indexOf(':');
			if (i === -1) continue;
			const k = decl.slice(0, i).trim().toLowerCase();
			const v = decl.slice(i + 1).trim();
			if (k === 'animation') applyShorthand(v);
			else if (k === 'animation-name') f.name = v;
			else if (k === 'animation-duration') f.duration = parseTime(v) ?? f.duration;
			else if (k === 'animation-delay') f.delay = parseTime(v) ?? f.delay;
			else if (k === 'animation-timing-function') f.easing = v;
			else if (k === 'animation-iteration-count')
				f.iterations = v === 'infinite' ? 'infinite' : parseInt(v, 10) || f.iterations;
			else if (k === 'animation-direction') f.direction = v;
			else if (k === 'animation-fill-mode') f.fill = v;
		}
		return f.name ? f : null;
	};

	// --- selector mapping ---------------------------------------------------------

	/** Expand `&` against the enclosing rule's selector list. `null` = orphan `&`. */
	const expandNesting = (sel: Selector, parents: Selector[] | null): Selector[] | null => {
		if (!sel.some((c) => c.type === 'nesting')) return [sel];
		if (!parents || parents.length === 0) return null;
		let expanded: Selector[] = [[]];
		for (const comp of sel) {
			if (comp.type === 'nesting') {
				const next: Selector[] = [];
				for (const prefix of expanded) {
					for (const p of parents) {
						if (next.length >= MAX_EXPANDED_SELECTORS) break;
						next.push([...prefix, ...p]);
					}
				}
				expanded = next;
			} else {
				for (const s of expanded) s.push(comp);
			}
		}
		return expanded;
	};

	/** lightningcss combinator kind → wire marker. `deep`/`part`/etc. stay dropped. */
	const COMB_MAP: Record<string, ' ' | '>' | '+' | '~'> = {
		descendant: ' ',
		child: '>',
		'next-sibling': '+',
		'later-sibling': '~',
	};
	const ATTR_OPS: Record<string, AttrOp> = {
		equal: '=',
		includes: '~=',
		'dash-match': '|=',
		prefix: '^=',
		substring: '*=',
		suffix: '$=',
	};

	/** `[attr]` / `[attr op value]` → attr comp, or a reason string. `v` carries
	 *  the native prop name so Rust tests the same map the element writes to.
	 *  `class` is the one attr that never lands in custom_props — it maps onto
	 *  the element's class list (`[class]` presence, `[class~=t]` a class comp,
	 *  the string ops compare against the joined tokens). `[style]` has no
	 *  native counterpart and drops. */
	const mapAttribute = (c: Extract<SelectorComponent, { type: 'attribute' }>): SelComp | string => {
		if (c.namespace && c.namespace.type === 'specific') return 'namespaced attribute selector';
		const name = c.name;
		if (name === 'style') return 'attribute selector "[style]"';
		const v = name === 'class' ? 'class' : nativeAttrName(name);
		if (!c.operation) return { k: 'attr', v };
		const op = ATTR_OPS[c.operation.operator];
		if (!op) return `attribute operator "${c.operation.operator}"`;
		if (name === 'class' && op === '~=') return { k: 'class', v: c.operation.value };
		// `=` compares the coerced prop value (tabindex="0" → number 0);
		// the string ops compare the prop's string form, so they keep raw text.
		const x = op === '=' ? nativeAttrValue(name, c.operation.value) : c.operation.value;
		return { k: 'attr', v, op, x };
	};

	interface MappedCompound {
		comps: SelComp[];
		spec: [number, number, number];
		states: number;
	}

	/** One compound (no combinators) → comps + specificity. Used for both the
	 *  top-level runs between combinators and each `:not()` argument. */
	const mapCompound = (input: SelectorComponent[]): MappedCompound | string => {
		const out: SelComp[] = [];
		let ids = 0;
		let classes = 0;
		let types = 0;
		let states = 0;
		for (const c of input) {
			switch (c.type) {
				case 'type':
					out.push({ k: 'tag', v: c.name });
					types++;
					break;
				case 'class':
					out.push({ k: 'class', v: c.name });
					classes++;
					break;
				case 'id':
					out.push({ k: 'id', v: c.name });
					ids++;
					break;
				case 'universal':
					out.push({ k: 'universal' });
					break;
				case 'attribute': {
					const mapped = mapAttribute(c);
					if (typeof mapped === 'string') return mapped;
					out.push(mapped);
					classes++;
					break;
				}
				case 'combinator':
					return 'combinator inside compound';
				case 'namespace':
					return 'namespaced selector';
				case 'nesting':
					return '"&" has no enclosing rule';
				case 'pseudo-element':
					return `pseudo-element "::${pseudoElementName(c)}"`;
				case 'pseudo-class': {
					const state = STATE_PSEUDOS[c.kind];
					if (state) {
						out.push({ k: 'state', v: state });
						classes++;
						states++;
						break;
					}
					// :not(a, b) ≡ :not(a):not(b) — emit one comp per argument.
					// Each arg must be a combinator-free compound; state pseudos
					// inside can't route into a bucket, so they drop the rule.
					if (c.kind === 'not') {
						for (const inner of c.selectors) {
							const mapped = mapCompound(inner);
							if (typeof mapped === 'string') return `:not(): ${mapped}`;
							if (mapped.states > 0) return ':not() with a state pseudo-class';
							out.push({ k: 'not', sel: mapped.comps });
							ids += mapped.spec[0];
							classes += mapped.spec[1];
							types += mapped.spec[2];
						}
						break;
					}
					return `pseudo-class ":${pseudoClassName(c)}"`;
				}
			}
		}
		return { comps: out, spec: [ids, classes, types], states };
	};

	/** Map a flat lightningcss selector to SelComp[] + specificity, or a reason string. */
	const mapSelector = (input: Selector): MappedSelector | string => {
		// Unwrap :global(…) — splice the inner selector in place. Loop for
		// pathological :global(:global(…)).
		let comps = input;
		for (let n = 0; n < 8; n++) {
			if (!comps.some((c) => c.type === 'pseudo-class' && c.kind === 'global')) break;
			const next: SelectorComponent[] = [];
			for (const c of comps) {
				if (c.type === 'pseudo-class' && c.kind === 'global') next.push(...c.selector);
				else next.push(c);
			}
			comps = next;
		}

		// Split into compound runs at combinators; map each, then re-join with
		// `comb` markers. Matching walks right-to-left on the native side.
		const runs: SelectorComponent[][] = [[]];
		const combs: Array<' ' | '>' | '+' | '~'> = [];
		for (const c of comps) {
			if (c.type === 'combinator') {
				const cv = COMB_MAP[c.value];
				if (!cv) return `combinator "${combinatorLabel(c.value)}"`;
				if (runs[runs.length - 1]!.length === 0) return 'misplaced combinator';
				combs.push(cv);
				runs.push([]);
			} else {
				runs[runs.length - 1]!.push(c);
			}
		}
		if (runs[runs.length - 1]!.length === 0) return 'selector ends with combinator';

		const out: SelComp[] = [];
		let ids = 0;
		let classes = 0;
		let types = 0;
		let states = 0;
		for (let i = 0; i < runs.length; i++) {
			const mapped = mapCompound(runs[i]!);
			if (typeof mapped === 'string') return mapped;
			if (i < runs.length - 1 && mapped.states > 0) {
				return 'state pseudo-class on a non-final compound';
			}
			states += mapped.states;
			ids += mapped.spec[0];
			classes += mapped.spec[1];
			types += mapped.spec[2];
			if (i > 0) out.push({ k: 'comb', v: combs[i - 1]! });
			out.push(...mapped.comps);
		}
		if (states > 1) return 'multiple state pseudo-classes';
		if (out.length === 0) return 'empty selector';
		return { comps: out, spec: [ids, classes, types] };
	};

	// --- rule traversal -----------------------------------------------------------

	const AT_RULE_NAMES: Record<string, string> = {
		media: '@media',
		supports: '@supports',
		keyframes: '@keyframes',
		'font-face': '@font-face',
		'font-palette-values': '@font-palette-values',
		'font-feature-values': '@font-feature-values',
		page: '@page',
		'counter-style': '@counter-style',
		namespace: '@namespace',
		'moz-document': '@-moz-document',
		viewport: '@viewport',
		'custom-media': '@custom-media',
		'layer-statement': '@layer',
		'layer-block': '@layer',
		property: '@property',
		container: '@container',
		scope: '@scope',
		'starting-style': '@starting-style',
		'view-transition': '@view-transition',
		'position-try': '@position-try',
		import: '@import',
	};

	const warnAtRule = (r: Rule): void => {
		const loc = (r as { value?: { loc?: Location2 } }).value?.loc;
		const at =
			AT_RULE_NAMES[r.type] ??
			`@${((r as { value?: { name?: string } }).value?.name ?? r.type)}`;
		warnings.push(
			`unsupported at-rule ${at}${loc ? ` (line ${loc.line + 1})` : ''} — rule dropped`
		);
	};

	const emitStyleRule = (sr: StyleRule, parents: Selector[] | null): void => {
		const line = sr.loc.line + 1;
		const decls = extractDecls(sr);

		// Substitute `&` for every selector in this rule.
		const resolved: Selector[] = [];
		for (const sel of sr.selectors) {
			const expanded = expandNesting(sel, parents);
			if (expanded === null) {
				warnings.push(
					`unsupported selector "${selectorToString(sel)}": "&" has no enclosing rule — dropped (line ${line})`
				);
				continue;
			}
			for (const s of expanded) resolved.push(s);
		}

		if (decls === null) {
			if (resolved.length > 0) {
				warnings.push(
					`could not locate declaration block for "${selectorToString(resolved[0]!)}" — dropped (line ${line})`
				);
			}
		} else {
			for (const sel of resolved) {
				const mapped = mapSelector(sel);
				if (typeof mapped === 'string') {
					warnings.push(
						`unsupported selector "${selectorToString(sel)}": ${mapped} — dropped (line ${line})`
					);
				} else {
					rules.push({ sel: mapped.comps, decls, spec: mapped.spec, order: order++ });
					// `animation:`/`animation-*` decls lower onto animate() —
					// only plain compound class/tag selectors can drive one.
					const anim = extractAnimation(decls);
					if (anim) {
						const classes: string[] = [];
						let tag: string | undefined;
						let ok = true;
						for (const c of mapped.comps) {
							if (c.k === 'class') classes.push(c.v);
							else if (c.k === 'tag') tag = c.v;
							else {
								ok = false;
								break;
							}
						}
						if (ok) {
							animations.push({ classes, tag, spec: anim, spec3: mapped.spec, order: order - 1 });
						} else {
							warnings.push(
								`animation on non-compound selector "${selectorToString(sel)}" — animation dropped (line ${line})`
							);
						}
					}
				}
			}
		}

		// Recurse into nested rules with this rule's resolved selectors as `&`.
		walkRules(sr.rules ?? [], resolved.length > 0 ? resolved : null);
	};

	function walkRules(list: Rule[], parents: Selector[] | null): void {
		for (const r of list) {
			switch (r.type) {
				case 'style':
					emitStyleRule(r.value, parents);
					break;
				case 'nesting': // @nest — wrap is a style rule
					emitStyleRule(r.value.style, parents);
					break;
				case 'nested-declarations': // declarations after a nested rule — kept in parent's decls text
				case 'ignored':
					break;
				case 'keyframes':
					extractKeyframes(r.value.loc, String(r.value.name.value));
					break;
				default:
					warnAtRule(r);
			}
		}
	}

	walkRules(sheet.rules, null);
	return { rules, warnings, keyframes, animations };
}

// --- warning-message helpers ------------------------------------------------------

function combinatorLabel(v: string): string {
	switch (v) {
		case 'descendant':
			return ' ';
		case 'child':
			return '>';
		case 'next-sibling':
			return '+';
		case 'later-sibling':
			return '~';
		default:
			return v;
	}
}

function pseudoClassName(c: { kind: string; name?: string }): string {
	return (c.kind === 'custom' || c.kind === 'custom-function') && c.name ? c.name : c.kind;
}

function pseudoElementName(c: { kind: string; name?: string }): string {
	return (c.kind === 'custom' || c.kind === 'custom-function') && c.name ? c.name : c.kind;
}

/** Reconstruct approximate selector text for diagnostics. */
function selectorToString(sel: Selector): string {
	let s = '';
	for (const c of sel) {
		switch (c.type) {
			case 'combinator':
				s += c.value === 'descendant' ? ' ' : ` ${combinatorLabel(c.value)} `;
				break;
			case 'universal':
				s += '*';
				break;
			case 'namespace':
				s += c.kind === 'named' ? `${c.prefix}|` : c.kind === 'any' ? '*|' : '|';
				break;
			case 'type':
				s += c.name;
				break;
			case 'class':
				s += `.${c.name}`;
				break;
			case 'id':
				s += `#${c.name}`;
				break;
			case 'attribute': {
				const OP_TEXT: Record<string, string> = {
					equal: '=', includes: '~=', 'dash-match': '|=',
					prefix: '^=', substring: '*=', suffix: '$=',
				};
				s += c.operation
					? `[${c.name}${OP_TEXT[c.operation.operator] ?? c.operation.operator}"${c.operation.value}"]`
					: `[${c.name}]`;
				break;
			}
			case 'nesting':
				s += '&';
				break;
			case 'pseudo-class':
				if (c.kind === 'global') s += `:global(${selectorToString(c.selector)})`;
				else if (c.kind === 'not') s += `:not(${c.selectors.map(selectorToString).join(', ')})`;
				else s += `:${pseudoClassName(c)}`;
				break;
			case 'pseudo-element':
				s += `::${pseudoElementName(c)}`;
				break;
		}
	}
	return s;
}
