import { test, expect, describe } from 'bun:test';
import { parseStylesheet, type NativeStyleRule } from './parse.ts';

function only(css: string): NativeStyleRule {
	const { rules, warnings } = parseStylesheet(css);
	expect(warnings).toEqual([]);
	expect(rules).toHaveLength(1);
	return rules[0]!;
}

describe('simple selectors', () => {
	test('plain class rule', () => {
		const r = only('.btn { color: red }');
		expect(r.sel).toEqual([{ k: 'class', v: 'btn' }]);
		expect(r.spec).toEqual([0, 1, 0]);
		expect(r.order).toBe(0);
		expect(r.decls).toBe('color: red');
	});

	test('compound .a.b', () => {
		const r = only('.a.b { x: y }');
		expect(r.sel).toEqual([
			{ k: 'class', v: 'a' },
			{ k: 'class', v: 'b' },
		]);
		expect(r.spec).toEqual([0, 2, 0]);
	});

	test('tag + class div.x', () => {
		const r = only('div.x { x: y }');
		expect(r.sel).toEqual([
			{ k: 'tag', v: 'div' },
			{ k: 'class', v: 'x' },
		]);
		expect(r.spec).toEqual([0, 1, 1]);
	});

	test('bare tag', () => {
		const r = only('span { x: y }');
		expect(r.sel).toEqual([{ k: 'tag', v: 'span' }]);
		expect(r.spec).toEqual([0, 0, 1]);
	});

	test('id selector', () => {
		const r = only('#main { x: y }');
		expect(r.sel).toEqual([{ k: 'id', v: 'main' }]);
		expect(r.spec).toEqual([1, 0, 0]);
	});

	test('id + class compound', () => {
		const r = only('#main.on { x: y }');
		expect(r.sel).toEqual([
			{ k: 'id', v: 'main' },
			{ k: 'class', v: 'on' },
		]);
		expect(r.spec).toEqual([1, 1, 0]);
	});

	test('universal', () => {
		const r = only('* { box-sizing: border-box }');
		expect(r.sel).toEqual([{ k: 'universal' }]);
		expect(r.spec).toEqual([0, 0, 0]);
	});

	test('universal + class', () => {
		const r = only('*.x { y: z }');
		expect(r.sel).toEqual([
			{ k: 'universal' },
			{ k: 'class', v: 'x' },
		]);
		expect(r.spec).toEqual([0, 1, 0]);
	});
});

describe('state pseudo-classes', () => {
	const cases: Array<[string, string]> = [
		['hover', 'hover'],
		['active', 'active'],
		['focus', 'focus'],
		['focus-within', 'focusWithin'],
		['focus-visible', 'focusVisible'],
	];
	for (const [pseudo, state] of cases as [string, 'active' | 'focus' | 'focusVisible' | 'focusWithin' | 'hover'][]) {
		test(`:${pseudo} maps to state ${state}`, () => {
			const r = only(`.btn:${pseudo} { x: y }`);
			expect(r.sel).toEqual([
				{ k: 'class', v: 'btn' },
				{ k: 'state', v: state },
			]);
			expect(r.spec).toEqual([0, 2, 0]);
		});
	}

	test('bare :hover', () => {
		const r = only(':hover { x: y }');
		expect(r.sel).toEqual([{ k: 'state', v: 'hover' }]);
		expect(r.spec).toEqual([0, 1, 0]);
	});

	test('two states on one selector is dropped', () => {
		const { rules, warnings } = parseStylesheet('.a:hover:focus { x: y }');
		expect(rules).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('multiple state pseudo-classes');
	});
});

describe(':global unwrap', () => {
	test(':global(.g) unwraps to .g', () => {
		const r = only(':global(.g) { x: y }');
		expect(r.sel).toEqual([{ k: 'class', v: 'g' }]);
		expect(r.spec).toEqual([0, 1, 0]);
	});

	test(':global keeps trailing compound comps', () => {
		const r = only(':global(div.x):hover { y: z }');
		expect(r.sel).toEqual([
			{ k: 'tag', v: 'div' },
			{ k: 'class', v: 'x' },
			{ k: 'state', v: 'hover' },
		]);
		expect(r.spec).toEqual([0, 2, 1]);
	});

	test(':global unwraps inner combinators', () => {
		const r = only(':global(.a .b) { x: y }');
		expect(r.sel).toEqual([
			{ k: 'class', v: 'a' },
			{ k: 'comb', v: ' ' },
			{ k: 'class', v: 'b' },
		]);
	});

	test(':global with unsupported inner still warns', () => {
		const { rules, warnings } = parseStylesheet(':global(.a::before) { x: y }');
		expect(rules).toEqual([]);
		expect(warnings[0]).toContain('pseudo-element');
	});
});

describe('combinators', () => {
	test.each([
		['descendant', '.a .b', ' '],
		['child', '.a > .b', '>'],
		['next-sibling', '.a + .b', '+'],
		['later-sibling', '.a ~ .b', '~'],
	])('%s combinator produces a comb comp', (_, sel, comb) => {
		const r = only(`${sel} { x: y }`);
		expect(r.sel).toEqual([
			{ k: 'class', v: 'a' },
			{ k: 'comb', v: comb },
			{ k: 'class', v: 'b' },
		]);
		expect(r.spec).toEqual([0, 2, 0]);
	});

	test('state on a non-final compound drops', () => {
		const { rules, warnings } = parseStylesheet('.a:hover .b { x: y }');
		expect(rules).toEqual([]);
		expect(warnings[0]).toContain('non-final compound');
	});
});

describe('attribute selectors', () => {
	test('bare attribute', () => {
		const r = only('[data-x] { x: y }');
		expect(r.sel).toEqual([{ k: 'attr', v: 'data-x' }]);
		expect(r.spec).toEqual([0, 1, 0]);
	});

	test('attribute with value compounds', () => {
		const r = only('.a[href="x"] { x: y }');
		expect(r.sel).toEqual([
			{ k: 'class', v: 'a' },
			{ k: 'attr', v: 'href', op: '=', x: 'x' },
		]);
		expect(r.spec).toEqual([0, 2, 0]);
	});
});

describe('skipped constructs', () => {

	test('pseudo-element warns and drops', () => {
		const { rules, warnings } = parseStylesheet('.e::before { x: y }');
		expect(rules).toEqual([]);
		expect(warnings[0]).toContain('pseudo-element');
	});

	test('::selection warns and drops', () => {
		const { rules, warnings } = parseStylesheet('::selection { x: y }');
		expect(rules).toEqual([]);
		expect(warnings[0]).toContain('pseudo-element');
	});

	test.each(['nth-child(2)', 'disabled', 'checked', 'first-child', 'last-child'])(
		'pseudo-class :%s warns and drops',
		(p) => {
			const { rules, warnings } = parseStylesheet(`.a:${p} { x: y }`);
			expect(rules).toEqual([]);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain('pseudo-class');
		}
	);

	test(':not(compound) produces a not comp', () => {
		const r = only('.a:not(.b) { x: y }');
		expect(r.sel).toEqual([
			{ k: 'class', v: 'a' },
			{ k: 'not', sel: [{ k: 'class', v: 'b' }] },
		]);
	});

	test.each([
		['media', '@media (min-width: 100px) { .a { x: y } }'],
		['supports', '@supports (display: grid) { .a { x: y } }'],
		['font-face', '@font-face { font-family: x; src: url(y) }'],
		['layer', '@layer base { .a { x: y } }'],
		['container', '@container (min-width: 100px) { .a { x: y } }'],
		['scope', '@scope (.a) to (.b) { .c { x: y } }'],
	])('at-rule @%s warns and drops', (name, css) => {
		const { rules, warnings } = parseStylesheet(css);
		expect(rules).toEqual([]);
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toContain(`@${name}`);
	});

	test('unsupported at-rule does not leak inner style rules', () => {
		const { rules } = parseStylesheet('@media screen { .secret { x: y } }');
		expect(rules).toEqual([]);
	});

	test('a bad selector in a list only drops that selector', () => {
		const { rules, warnings } = parseStylesheet('.ok, .bad::before { x: y }');
		expect(rules).toHaveLength(1);
		expect(rules[0]!.sel).toEqual([{ k: 'class', v: 'ok' }]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('pseudo-element');
	});

	test('top-level & with no enclosing rule warns', () => {
		const { rules, warnings } = parseStylesheet('&.lonely { x: y }');
		expect(rules).toEqual([]);
		expect(warnings[0]).toContain('"&"');
	});
});

describe('specificity', () => {
	test('specificity triples', () => {
		const { rules } = parseStylesheet(`
			#a.b.c { x: 1 }
			.a.b { x: 2 }
			div.a { x: 3 }
			#z { x: 4 }
			div { x: 5 }
			* { x: 6 }
			.a:hover { x: 7 }
		`);
		expect(rules.map((r) => r.spec)).toEqual([
			[1, 2, 0],
			[0, 2, 0],
			[0, 1, 1],
			[1, 0, 0],
			[0, 0, 1],
			[0, 0, 0],
			[0, 2, 0],
		]);
	});
});

describe('order', () => {
	test('order increments monotonically across rules and selector lists', () => {
		const { rules } = parseStylesheet(`
			.a { x: 1 }
			.b, .c { x: 2 }
			#d { x: 3 }
		`);
		expect(rules.map((r) => r.order)).toEqual([0, 1, 2, 3]);
	});

	test('skipped rules do not disturb monotonic order', () => {
		const { rules } = parseStylesheet(`
			.a { x: 1 }
			.b:hover .c { x: 2 }
			.d { x: 3 }
		`);
		expect(rules).toHaveLength(2);
		expect(rules.map((r) => r.order)).toEqual([0, 1]);
	});
});

describe('decls passthrough', () => {
	test('verbatim text, unminified formatting preserved', () => {
		const r = only('.a { color:#fff;   padding:4px }');
		expect(r.decls).toBe('color:#fff;   padding:4px');
	});

	test('var(--token) preserved verbatim', () => {
		const r = only('.a { color: var(--token); background:var(--bg, #fff) }');
		expect(r.decls).toBe('color: var(--token); background:var(--bg, #fff)');
	});

	test('shorthand padding:4px 8px preserved', () => {
		const r = only('.a { padding:4px 8px }');
		expect(r.decls).toBe('padding:4px 8px');
	});

	test('custom properties and !important preserved', () => {
		const r = only('.a { --my-var: 1px 2px; color: red !important }');
		expect(r.decls).toBe('--my-var: 1px 2px; color: red !important');
	});

	test('all selectors in a list share the same decls text', () => {
		const { rules } = parseStylesheet('.a, #b { x: 1; y: 2 }');
		expect(rules).toHaveLength(2);
		expect(rules[0]!.decls).toBe('x: 1; y: 2');
		expect(rules[0]!.decls).toBe(rules[1]!.decls);
	});

	test('weird values survive verbatim', () => {
		const r = only('.a { content: "{"; margin: 0 }');
		expect(r.decls).toBe('content: "{"; margin: 0');
	});
});

describe('nesting', () => {
	test('descendant nesting emits a combinator rule', () => {
		const { rules, warnings } = parseStylesheet('.a { x: 1; .b { y: 2 } }');
		expect(warnings).toEqual([]);
		expect(rules).toHaveLength(2);
		expect(rules[0]!.sel).toEqual([{ k: 'class', v: 'a' }]);
		expect(rules[0]!.decls).toBe('x: 1;');
		expect(rules[1]!.sel).toEqual([
			{ k: 'class', v: 'a' },
			{ k: 'comb', v: ' ' },
			{ k: 'class', v: 'b' },
		]);
		expect(rules[1]!.decls).toBe('y: 2');
	});

	test('&.x compounds to .a.x', () => {
		const { rules, warnings } = parseStylesheet('.a { &.x { y: 2 } }');
		expect(warnings).toEqual([]);
		expect(rules).toHaveLength(2);
		expect(rules[0]!.sel).toEqual([{ k: 'class', v: 'a' }]);
		expect(rules[0]!.decls).toBe('');
		expect(rules[1]!.sel).toEqual([
			{ k: 'class', v: 'a' },
			{ k: 'class', v: 'x' },
		]);
		expect(rules[1]!.decls).toBe('y: 2');
		expect(rules[1]!.spec).toEqual([0, 2, 0]);
		expect(rules[1]!.order).toBe(1);
	});

	test('&.x with parent decls keeps decls clean of nested text', () => {
		const { rules } = parseStylesheet('.a { x: 1; &.x { y: 2 } }');
		expect(rules[0]!.decls).toBe('x: 1;');
		expect(rules[1]!.decls).toBe('y: 2');
	});

	test('&:hover compounds state onto parent', () => {
		const { rules } = parseStylesheet('.btn { &:hover { c: d } }');
		expect(rules).toHaveLength(2);
		expect(rules[1]!.sel).toEqual([
			{ k: 'class', v: 'btn' },
			{ k: 'state', v: 'hover' },
		]);
	});

	test('nested rule inside compound parent resolves &', () => {
		const { rules } = parseStylesheet('div.a { &.b { x: 1 } }');
		expect(rules[1]!.sel).toEqual([
			{ k: 'tag', v: 'div' },
			{ k: 'class', v: 'a' },
			{ k: 'class', v: 'b' },
		]);
		expect(rules[1]!.spec).toEqual([0, 2, 1]);
	});

	test('declarations after a nested rule stay in parent decls', () => {
		const { rules } = parseStylesheet('.a { &.x { y: 2 } z: 9; }');
		expect(rules).toHaveLength(2);
		expect(rules[0]!.sel).toEqual([{ k: 'class', v: 'a' }]);
		expect(rules[0]!.decls).toBe('z: 9;');
		expect(rules[1]!.decls).toBe('y: 2');
	});
});

describe('declared css animation', () => {
	test('@keyframes extracts name + percentage/from/to frames', () => {
		const { keyframes } = parseStylesheet(
			'@keyframes spin { from { transform: rotate(0deg); opacity: 0 } 50% { opacity: .5 } to { transform: rotate(360deg); opacity: 1 } }'
		);
		expect(keyframes).toEqual([
			{
				name: 'spin',
				frames: [
					{ offset: 0, props: { transform: 'rotate(0deg)', opacity: '0' } },
					{ offset: 0.5, props: { opacity: '.5' } },
					{ offset: 1, props: { transform: 'rotate(360deg)', opacity: '1' } },
				],
			},
		]);
	});

	test('@keyframes selector list expands to one frame per selector', () => {
		const { keyframes } = parseStylesheet('@keyframes p { 0%, 60% { opacity: 0 } 100% { opacity: 1 } }');
		expect(keyframes[0]?.frames.map((f) => f.offset)).toEqual([0, 0.6, 1]);
	});

	test('animation shorthand on a class selector produces an animation rule', () => {
		const { animations, warnings } = parseStylesheet('.spin { animation: spin 1.2s linear infinite }');
		expect(animations).toEqual([
			{
				classes: ['spin'],
				spec: {
					name: 'spin',
					duration: 1200,
					delay: 0,
					iterations: 'infinite',
					direction: 'normal',
					easing: 'linear',
					fill: 'none',
				},
				spec3: [0, 1, 0],
				order: 0,
			},
		]);
		expect(warnings).toEqual([]);
	});

	test('animation shorthand: first time is duration, second is delay', () => {
		const { animations } = parseStylesheet('.x { animation: pulse 600ms ease-out 2s 3 alternate forwards }');
		expect(animations[0]?.spec).toMatchObject({
			name: 'pulse',
			duration: 600,
			delay: 2000,
			iterations: 3,
			direction: 'alternate',
			easing: 'ease-out',
			fill: 'forwards',
		});
	});

	test('animation-* longhands populate the spec', () => {
		const { animations } = parseStylesheet(
			'.x { animation-name: bob; animation-duration: 250ms; animation-iteration-count: 2; animation-direction: reverse; animation-fill-mode: both }'
		);
		expect(animations[0]?.spec).toMatchObject({
			name: 'bob',
			duration: 250,
			iterations: 2,
			direction: 'reverse',
			fill: 'both',
		});
	});

	test('animation on a tag+class selector carries both match arms', () => {
		const { animations } = parseStylesheet('div.x { animation: j 1s }');
		expect(animations[0]?.classes).toEqual(['x']);
		expect(animations[0]?.tag).toBe('div');
	});

	test('animation on a non-compound selector is dropped with a warning', () => {
		const { animations, warnings } = parseStylesheet('.a .b { animation: j 1s }');
		expect(animations).toEqual([]);
		expect(warnings.some((w) => w.includes('animation'))).toBe(true);
	});
});

describe('robustness', () => {
	test('empty input', () => {
		expect(parseStylesheet('')).toEqual({ rules: [], warnings: [], keyframes: [], animations: [] });
	});

	test.each(['.a {', '}', 'div{', '@media (', '%%%', '.a { color::: } .b{x:y}'])(
		'broken input does not throw: %j',
		(css) => {
			const res = parseStylesheet(css);
			expect(Array.isArray(res.rules)).toBe(true);
			expect(Array.isArray(res.warnings)).toBe(true);
		}
	);

	test('parseable rules survive alongside garbage', () => {
		const { rules } = parseStylesheet('.good { x: y } }');
		expect(rules.length).toBeGreaterThanOrEqual(1);
		expect(rules[0]!.sel).toEqual([{ k: 'class', v: 'good' }]);
	});

	test('comments and whitespace tolerated', () => {
		const r = only('/* hi */ .a /* there */ { x: y /* z */ }');
		expect(r.sel).toEqual([{ k: 'class', v: 'a' }]);
	});
});
