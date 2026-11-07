/**
 * qg-stylesheet.test.ts — the QuickguiSink stylesheet mirror.
 *
 * Feeds op batches straight into the sink (no gdom mount) and asserts the
 * retained NativeNode property map plus the host op log. Covers what the
 * mirror borrows from stylesheet.rs: (spec, order) cascade, inline-wins,
 * state-comps routing decls into the core's *Style JSON codes, and
 * retraction when a match disappears (setClass / unregister / re-register).
 */
import { describe, test, expect } from 'bun:test';
import { PropertyCode, parseColor } from '@quickgui/native';
import { QuickguiSink, createHeadlessRoot } from './qg-backend';

const rule = (
	sel: { k: string; v?: string }[],
	decls: string,
	spec: [number, number, number] = [0, 1, 0],
	order = 0,
) => ({ sel, decls, spec, order });

function makeSink() {
	const { root, host, ops } = createHeadlessRoot();
	const sink = new QuickguiSink(root);
	return { sink, ops };
}

/** Full op batch in one applyBatch call. */
const batch = (sink: QuickguiSink, ops: unknown[][]) => sink.applyBatch(JSON.stringify(ops));
const prop = (sink: QuickguiSink, id: number, code: PropertyCode) =>
	sink.nodes.get(id)?.properties.get(code);
const styleJson = (sink: QuickguiSink, id: number, code: PropertyCode) => {
	const raw = prop(sink, id, code);
	return typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
};

describe('stylesheet mirror — cascade + retraction', () => {
	test('sheet decls apply on createElement/setClass match', () => {
		const { sink } = makeSink();
		batch(sink, [
			['stylesheet.register', 's1', [rule([{ k: 'class', v: 'a' }], 'color:#ff0000')]],
			['createElement', 10, 'div'],
			['setClass', 10, 'a'],
		]);
		expect(prop(sink, 10, PropertyCode.Color)).toBe(parseColor('#ff0000'));
	});

	test('re-registers re-resolve elements that already exist', () => {
		const { sink } = makeSink();
		batch(sink, [
			['createElement', 10, 'div'],
			['setClass', 10, 'a'],
			['stylesheet.register', 's1', [rule([{ k: 'class', v: 'a' }], 'height:50px')]],
		]);
		expect(prop(sink, 10, PropertyCode.Height)).toBe(50);
	});

	test('un-matching a class retracts the decl', () => {
		const { sink, ops } = makeSink();
		batch(sink, [
			['stylesheet.register', 's1', [rule([{ k: 'class', v: 'a' }], 'color:#ff0000')]],
			['createElement', 10, 'div'],
			['setClass', 10, 'a'],
			['appendChild', 0, 10],
		]);
		batch(sink, [['setClass', 10, 'b']]);
		expect(sink.nodes.get(10)?.properties.has(PropertyCode.Color)).toBe(false);
		expect(ops).toContain(`prop:10:Color=null`);
	});

	test('un-matching keeps decls that still match through another rule', () => {
		const { sink } = makeSink();
		batch(sink, [
			[
				'stylesheet.register',
				's1',
				[rule([{ k: 'class', v: 'a' }], 'color:#ff0000'), rule([{ k: 'tag', v: 'div' }], 'color:#00ff00')],
			],
			['createElement', 10, 'div'],
			['setClass', 10, 'a'],
		]);
		batch(sink, [['setClass', 10, 'b']]);
		// .a retracted but div{} still matches — tag rule wins by cascade order
		expect(prop(sink, 10, PropertyCode.Color)).toBe(parseColor('#00ff00'));
	});

	test('stylesheet.unregister retracts everything the sheet owned', () => {
		const { sink } = makeSink();
		batch(sink, [
			['stylesheet.register', 's1', [rule([{ k: 'universal' }], 'color:#ff0000;height:50px')]],
			['createElement', 10, 'div'],
		]);
		expect(prop(sink, 10, PropertyCode.Color)).toBe(parseColor('#ff0000'));
		batch(sink, [['stylesheet.unregister', 's1']]);
		expect(sink.nodes.get(10)?.properties.has(PropertyCode.Color)).toBe(false);
		expect(sink.nodes.get(10)?.properties.has(PropertyCode.Height)).toBe(false);
	});

	test('same-id re-register replaces and retracts stale decls', () => {
		const { sink } = makeSink();
		batch(sink, [
			['stylesheet.register', 's1', [rule([{ k: 'universal' }], 'color:#ff0000')]],
			['createElement', 10, 'div'],
			['stylesheet.register', 's1', [rule([{ k: 'universal' }], 'height:50px')]],
		]);
		expect(sink.nodes.get(10)?.properties.has(PropertyCode.Color)).toBe(false);
		expect(prop(sink, 10, PropertyCode.Height)).toBe(50);
	});

	test('inline style beats sheet and survives retraction', () => {
		const { sink } = makeSink();
		batch(sink, [
			['stylesheet.register', 's1', [rule([{ k: 'class', v: 'a' }], 'color:#ff0000')]],
			['createElement', 10, 'div'],
			['setClass', 10, 'a'],
			['setStyle', 10, { color: '#00ff00' }],
		]);
		expect(prop(sink, 10, PropertyCode.Color)).toBe(parseColor('#00ff00'));
		// un-matching the class must not clear the inline value either
		batch(sink, [['setClass', 10, 'b'], ['stylesheet.unregister', 's1']]);
		expect(prop(sink, 10, PropertyCode.Color)).toBe(parseColor('#00ff00'));
	});

	test('cascade: higher specificity wins, then source order', () => {
		const { sink } = makeSink();
		batch(sink, [
			[
				'stylesheet.register',
				's1',
				[
					rule([{ k: 'class', v: 'a' }], 'color:#ff0000', [0, 1, 0], 0),
					rule([{ k: 'universal' }], 'color:#0000ff', [0, 0, 0], 1),
				],
			],
			['createElement', 10, 'div'],
			['setClass', 10, 'a'],
		]);
		expect(prop(sink, 10, PropertyCode.Color)).toBe(parseColor('#ff0000'));
	});
});

describe('stylesheet mirror — pseudo-state buckets', () => {
	test(':hover decls pack into HoverStyle JSON', () => {
		const { sink } = makeSink();
		batch(sink, [
			[
				'stylesheet.register',
				's1',
				[rule([{ k: 'class', v: 'a' }, { k: 'state', v: 'hover' }], 'color:#ffffff;border-radius:4px')],
			],
			['createElement', 10, 'div'],
			['setClass', 10, 'a'],
		]);
		const decl = styleJson(sink, 10, PropertyCode.HoverStyle);
		expect(decl).toEqual({ color: parseColor('#ffffff'), borderRadius: 4 });
		// hover decls must NOT leak into the base Color property
		expect(sink.nodes.get(10)?.properties.has(PropertyCode.Color)).toBe(false);
	});

	test('base and state rules coexist on one element', () => {
		const { sink } = makeSink();
		batch(sink, [
			[
				'stylesheet.register',
				's1',
				[
					rule([{ k: 'class', v: 'a' }], 'color:#ff0000', [0, 1, 0], 0),
					rule([{ k: 'class', v: 'a' }, { k: 'state', v: 'active' }], 'color:#00ff00', [0, 2, 0], 1),
				],
			],
			['createElement', 10, 'div'],
			['setClass', 10, 'a'],
		]);
		expect(prop(sink, 10, PropertyCode.Color)).toBe(parseColor('#ff0000'));
		expect(styleJson(sink, 10, PropertyCode.ActiveStyle)).toEqual({ color: parseColor('#00ff00') });
	});

	test(':focus and :focus-within reach their own codes', () => {
		const { sink } = makeSink();
		batch(sink, [
			[
				'stylesheet.register',
				's1',
				[
					rule([{ k: 'state', v: 'focus' }], 'outline:2px solid #3b82f6'),
					rule([{ k: 'state', v: 'focusWithin' }], 'border-color:#123456'),
				],
			],
			['createElement', 10, 'div'],
		]);
		expect(styleJson(sink, 10, PropertyCode.FocusStyle)).toEqual({ outline: '2px solid #3b82f6' });
		expect(styleJson(sink, 10, PropertyCode.FocusWithinStyle)).toEqual({
			borderColor: parseColor('#123456'),
		});
	});

	test(':focus-visible is transport-blocked — decls drop, rule still matches', () => {
		const { sink } = makeSink();
		batch(sink, [
			['stylesheet.register', 's1', [rule([{ k: 'state', v: 'focusVisible' }], 'color:#ffffff')]],
			['createElement', 10, 'div'],
		]);
		expect(sink.nodes.get(10)!.properties.size).toBe(0);
	});

	test('two state comps drop the whole rule like from_wire', () => {
		const { sink } = makeSink();
		batch(sink, [
			[
				'stylesheet.register',
				's1',
				[rule([{ k: 'state', v: 'hover' }, { k: 'state', v: 'active' }], 'color:#ffffff')],
			],
			['createElement', 10, 'div'],
		]);
		expect(sink.nodes.get(10)?.properties.has(PropertyCode.HoverStyle)).toBe(false);
		expect(sink.nodes.get(10)?.properties.has(PropertyCode.ActiveStyle)).toBe(false);
	});

	test('unknown state name drops the rule', () => {
		const { sink } = makeSink();
		batch(sink, [
			['stylesheet.register', 's1', [rule([{ k: 'state', v: 'disabled' }], 'color:#ffffff')]],
			['createElement', 10, 'div'],
		]);
		expect(sink.nodes.get(10)!.properties.size).toBe(0);
	});

	test('state cascade: same bucket resolves per-field by (spec, order)', () => {
		const { sink } = makeSink();
		batch(sink, [
			[
				'stylesheet.register',
				's1',
				[
					rule([{ k: 'class', v: 'a' }, { k: 'state', v: 'hover' }], 'color:#ff0000;opacity:0.5', [0, 1, 0], 0),
					rule(
						[{ k: 'class', v: 'a' }, { k: 'class', v: 'b' }, { k: 'state', v: 'hover' }],
						'color:#00ff00',
						[0, 2, 0],
						1,
					),
				],
			],
			['createElement', 10, 'div'],
			['setClass', 10, 'a b'],
		]);
		expect(styleJson(sink, 10, PropertyCode.HoverStyle)).toEqual({
			color: parseColor('#00ff00'),
			opacity: 0.5,
		});
	});

	test('state props retract with the match', () => {
		const { sink, ops } = makeSink();
		batch(sink, [
			['stylesheet.register', 's1', [rule([{ k: 'class', v: 'a' }, { k: 'state', v: 'hover' }], 'color:#ffffff')]],
			['createElement', 10, 'div'],
			['setClass', 10, 'a'],
			['appendChild', 0, 10],
		]);
		expect(styleJson(sink, 10, PropertyCode.HoverStyle)).toBeDefined();
		batch(sink, [['setClass', 10, 'b']]);
		expect(sink.nodes.get(10)?.properties.has(PropertyCode.HoverStyle)).toBe(false);
		expect(ops).toContain(`prop:10:HoverStyle=null`);
	});

	test('boxShadow layers encode as NativeBoxShadow objects', () => {
		const { sink } = makeSink();
		batch(sink, [
			[
				'stylesheet.register',
				's1',
				[rule([{ k: 'state', v: 'hover' }], 'box-shadow:2px 4px 8px #00000080, inset 0 1px #ffffff')],
			],
			['createElement', 10, 'div'],
		]);
		expect(styleJson(sink, 10, PropertyCode.HoverStyle)).toEqual({
			boxShadow: [
				{ offsetX: 2, offsetY: 4, blurRadius: 8, spreadRadius: 0, inset: false, color: parseColor('#00000080') },
				{ offsetX: 0, offsetY: 1, blurRadius: 0, spreadRadius: 0, inset: true, color: parseColor('#ffffff') },
			],
		});
	});

	test('named colors resolve inside state buckets too', () => {
		const { sink } = makeSink();
		batch(sink, [
			['stylesheet.register', 's1', [rule([{ k: 'state', v: 'hover' }], 'color:tomato')]],
			['createElement', 10, 'div'],
		]);
		expect(styleJson(sink, 10, PropertyCode.HoverStyle)).toEqual({ color: parseColor('#ff6347') });
	});
});

describe('stylesheet mirror — decl expansion (parse_decls parity)', () => {
	test('box shorthands expand to the side codes', () => {
		const { sink } = makeSink();
		batch(sink, [
			['stylesheet.register', 's1', [rule([{ k: 'universal' }], 'padding:8px 4px;inset:1px 2px')]],
			['createElement', 10, 'div'],
		]);
		expect(prop(sink, 10, PropertyCode.PaddingTop)).toBe(8);
		expect(prop(sink, 10, PropertyCode.PaddingRight)).toBe(4);
		expect(prop(sink, 10, PropertyCode.PaddingBottom)).toBe(8);
		expect(prop(sink, 10, PropertyCode.PaddingLeft)).toBe(4);
		expect(prop(sink, 10, PropertyCode.Top)).toBe(1);
		expect(prop(sink, 10, PropertyCode.Right)).toBe(2);
		expect(prop(sink, 10, PropertyCode.Bottom)).toBe(1);
		expect(prop(sink, 10, PropertyCode.Left)).toBe(2);
	});

	test('border / flex / gap / overflow shorthands expand like Rust', () => {
		const { sink } = makeSink();
		batch(sink, [
			[
				'stylesheet.register',
				's1',
				[rule([{ k: 'universal' }], 'border:2px solid tomato;flex:2;gap:6px 10px;overflow:hidden auto')],
			],
			['createElement', 10, 'div'],
		]);
		expect(prop(sink, 10, PropertyCode.BorderWidth)).toBe(2);
		expect(prop(sink, 10, PropertyCode.BorderColor)).toBe(parseColor('#ff6347'));
		expect(prop(sink, 10, PropertyCode.FlexGrow)).toBe(2);
		expect(prop(sink, 10, PropertyCode.FlexShrink)).toBe(1);
		expect(prop(sink, 10, PropertyCode.RowGap)).toBe(6);
		expect(prop(sink, 10, PropertyCode.ColumnGap)).toBe(10);
		// auto → scroll, same as the Rust normalization
		expect(prop(sink, 10, PropertyCode.OverflowX)).toBe('hidden');
		expect(prop(sink, 10, PropertyCode.OverflowY)).toBe('scroll');
	});

	test('flex:none and margin-inline expand', () => {
		const { sink } = makeSink();
		batch(sink, [
			['stylesheet.register', 's1', [rule([{ k: 'universal' }], 'flex:none;margin-inline:4px 8px')]],
			['createElement', 10, 'div'],
		]);
		expect(prop(sink, 10, PropertyCode.FlexGrow)).toBe(0);
		expect(prop(sink, 10, PropertyCode.FlexShrink)).toBe(0);
		expect(prop(sink, 10, PropertyCode.MarginLeft)).toBe(4);
		expect(prop(sink, 10, PropertyCode.MarginRight)).toBe(8);
	});

	test('var() resolves against the rule own --* decls', () => {
		const { sink } = makeSink();
		batch(sink, [
			[
				'stylesheet.register',
				's1',
				[rule([{ k: 'universal' }], '--accent:#123456;color:var(--accent);height:var(--missing, 40px)')],
			],
			['createElement', 10, 'div'],
		]);
		expect(prop(sink, 10, PropertyCode.Color)).toBe(parseColor('#123456'));
		expect(prop(sink, 10, PropertyCode.Height)).toBe(40);
	});

	test('unresolvable var() and unsafe values drop', () => {
		const { sink } = makeSink();
		batch(sink, [
			[
				'stylesheet.register',
				's1',
				[rule([{ k: 'universal' }], 'color:var(--missing);background:url(x.png);opacity:inherit')],
			],
			['createElement', 10, 'div'],
		]);
		expect(sink.nodes.get(10)?.properties.has(PropertyCode.Color)).toBe(false);
		expect(sink.nodes.get(10)?.properties.has(PropertyCode.BackgroundColor)).toBe(false);
		expect(sink.nodes.get(10)?.properties.has(PropertyCode.Opacity)).toBe(false);
	});

	test('calc() evaluates and named colors pack', () => {
		const { sink } = makeSink();
		batch(sink, [
			[
				'stylesheet.register',
				's1',
				[rule([{ k: 'universal' }], 'width:calc(100% - 20%);padding:calc(4px * 2);color:tomato')],
			],
			['createElement', 10, 'div'],
		]);
		expect(prop(sink, 10, PropertyCode.Width)).toBe('80%');
		expect(prop(sink, 10, PropertyCode.PaddingTop)).toBe(8);
		expect(prop(sink, 10, PropertyCode.Color)).toBe(parseColor('#ff6347'));
	});

	test('dimension keywords and % values stay dimension-typed', () => {
		const { sink } = makeSink();
		batch(sink, [
			['stylesheet.register', 's1', [rule([{ k: 'universal' }], 'height:50%;min-width:fit-content')]],
			['createElement', 10, 'div'],
		]);
		expect(prop(sink, 10, PropertyCode.Height)).toBe('50%');
		expect(prop(sink, 10, PropertyCode.MinWidth)).toBe('auto');
	});

	test('unitless line-height multiplies font-size like Rust', () => {
		const { sink } = makeSink();
		batch(sink, [
			['stylesheet.register', 's1', [rule([{ k: 'universal' }], 'font-size:10px;line-height:1.5')]],
			['createElement', 10, 'div'],
		]);
		expect(prop(sink, 10, PropertyCode.LineHeight)).toBe(15);
	});

	test('!important strips without gaining a layer', () => {
		const { sink } = makeSink();
		batch(sink, [
			[
				'stylesheet.register',
				's1',
				[
					rule([{ k: 'universal' }], 'color:#00ff00', [0, 0, 0], 0),
					rule([{ k: 'class', v: 'a' }], 'color:#ff0000 !important', [0, 1, 0], 1),
				],
			],
			['createElement', 10, 'div'],
			['setClass', 10, 'a'],
		]);
		expect(prop(sink, 10, PropertyCode.Color)).toBe(parseColor('#ff0000'));
	});

	test('background: gradient drops like the Rust unsafe-value drop', () => {
		const { sink } = makeSink();
		batch(sink, [
			['stylesheet.register', 's1', [rule([{ k: 'universal' }], 'background:linear-gradient(red, blue)')]],
			['createElement', 10, 'div'],
		]);
		expect(sink.nodes.get(10)?.properties.has(PropertyCode.BackgroundColor)).toBe(false);
	});
});

describe('stylesheet mirror — inline release back to the sheet', () => {
	test('setStyle replace releases props the new object omits', () => {
		const { sink } = makeSink();
		batch(sink, [
			['stylesheet.register', 's1', [rule([{ k: 'class', v: 'a' }], 'color:#ff0000')]],
			['createElement', 10, 'div'],
			['setClass', 10, 'a'],
			['setStyle', 10, { color: '#00ff00', height: 20 }],
		]);
		expect(prop(sink, 10, PropertyCode.Color)).toBe(parseColor('#00ff00'));
		// removeProperty-shaped batch: the whole object re-pushes without color
		batch(sink, [['setStyle', 10, { height: 20 }]]);
		expect(prop(sink, 10, PropertyCode.Height)).toBe(20);
		expect(prop(sink, 10, PropertyCode.Color)).toBe(parseColor('#ff0000')); // sheet re-claims
	});

	test('setCustomProp null releases the code to the sheet', () => {
		const { sink } = makeSink();
		batch(sink, [
			['stylesheet.register', 's1', [rule([{ k: 'universal' }], 'color:#ff0000')]],
			['createElement', 10, 'div'],
			['setCustomProp', 10, 'color', '#0000ff'],
		]);
		expect(prop(sink, 10, PropertyCode.Color)).toBe(parseColor('#0000ff'));
		batch(sink, [['setCustomProp', 10, 'color', null]]);
		expect(prop(sink, 10, PropertyCode.Color)).toBe(parseColor('#ff0000'));
	});

	test('id selector context follows setCustomProp id incl. removal', () => {
		const { sink } = makeSink();
		batch(sink, [
			['stylesheet.register', 's1', [rule([{ k: 'id', v: 'main' }], 'color:#ff0000')]],
			['createElement', 10, 'div'],
			['setCustomProp', 10, 'id', 'main'],
		]);
		expect(prop(sink, 10, PropertyCode.Color)).toBe(parseColor('#ff0000'));
		batch(sink, [['setCustomProp', 10, 'id', null]]);
		expect(sink.nodes.get(10)?.properties.has(PropertyCode.Color)).toBe(false);
	});
});

describe('stylesheet mirror — combinators, attr selectors, :not()', () => {
	const comb = (v: string) => ({ k: 'comb', v });
	const attr = (v: string, op?: string, x?: unknown) => ({ k: 'attr', v, op, x });
	const not = (...sel: { k: string; v?: string }[]) => ({ k: 'not', sel });

	test('descendant + child combinators match ancestry', () => {
		const { sink } = makeSink();
		batch(sink, [
			[
				'stylesheet.register',
				's1',
				[
					rule([{ k: 'class', v: 'marked' }, comb(' '), { k: 'class', v: 't' }], 'color:#ff0000'),
					rule([{ k: 'class', v: 'marked' }, comb('>'), { k: 'class', v: 't' }], 'padding:9px'),
				],
			],
			['createElement', 1, 'div'],
			['createElement', 2, 'div'],
			['createElement', 3, 'div'],
			['createElement', 4, 'div'],
			['appendChild', 1, 2],
			['appendChild', 2, 3],
			['appendChild', 3, 4],
			['setClass', 2, 'marked'],
			['setClass', 4, 't'],
		]);
		expect(prop(sink, 4, PropertyCode.Color)).toBe(parseColor('#ff0000'));
		expect(prop(sink, 4, PropertyCode.PaddingTop)).toBeUndefined(); // `>` blocked by plain(3)
	});

	test('reparent flips a descendant match live', () => {
		const { sink } = makeSink();
		batch(sink, [
			[
				'stylesheet.register',
				's1',
				[rule([{ k: 'class', v: 'marked' }, comb(' '), { k: 'class', v: 't' }], 'color:#ff0000')],
			],
			['createElement', 1, 'div'],
			['createElement', 2, 'div'],
			['createElement', 3, 'div'],
			['appendChild', 1, 2],
			['appendChild', 1, 3],
			['setClass', 2, 'marked'],
			['setClass', 3, 't'],
		]);
		expect(sink.nodes.get(3)?.properties.has(PropertyCode.Color)).toBe(false);
		batch(sink, [['moveBefore', 2, 3, null]]);
		expect(prop(sink, 3, PropertyCode.Color)).toBe(parseColor('#ff0000'));
		batch(sink, [['moveBefore', 1, 3, null]]);
		expect(sink.nodes.get(3)?.properties.has(PropertyCode.Color)).toBe(false);
	});

	test('sibling combinators + reorder', () => {
		const { sink } = makeSink();
		batch(sink, [
			[
				'stylesheet.register',
				's1',
				[
					rule([{ k: 'class', v: 'x' }, comb('~'), { k: 'class', v: 'y' }], 'color:#ff0000'),
					rule([{ k: 'class', v: 'x' }, comb('+'), { k: 'class', v: 'y' }], 'padding:7px'),
				],
			],
			['createElement', 1, 'div'],
			['createElement', 2, 'div'],
			['createElement', 3, 'div'],
			['createElement', 4, 'div'],
			['appendChild', 1, 2],
			['appendChild', 1, 3],
			['appendChild', 1, 4],
			['setClass', 2, 'x'],
			['setClass', 4, 'y'],
		]);
		expect(prop(sink, 4, PropertyCode.Color)).toBe(parseColor('#ff0000')); // .x ~ .y
		expect(prop(sink, 4, PropertyCode.PaddingTop)).toBeUndefined(); // mid(3) between
		batch(sink, [['moveBefore', 1, 3, null]]); // mid to the end — x,y adjacent
		expect(prop(sink, 4, PropertyCode.PaddingTop)).toBe(7);
	});

	test('attr selectors match custom props', () => {
		const { sink } = makeSink();
		batch(sink, [
			[
				'stylesheet.register',
				's1',
				[
					rule([attr('data-open')], 'color:#ff0000'),
					rule([attr('data-open', '=', true)], 'padding:3px'),
					rule([attr('data-tags', '~=', 'hot')], 'margin:5px'),
				],
			],
			['createElement', 10, 'div'],
			['createElement', 11, 'div'],
			['setCustomProp', 10, 'data-open', true],
			['setCustomProp', 10, 'data-tags', 'a hot b'],
			['setCustomProp', 11, 'data-open', false],
		]);
		expect(prop(sink, 10, PropertyCode.Color)).toBe(parseColor('#ff0000'));
		expect(prop(sink, 10, PropertyCode.PaddingTop)).toBe(3);
		expect(prop(sink, 10, PropertyCode.MarginTop)).toBe(5);
		expect(prop(sink, 11, PropertyCode.Color)).toBe(parseColor('#ff0000')); // present ≠ true
		expect(prop(sink, 11, PropertyCode.PaddingTop)).toBeUndefined();
		// attr change re-tests
		batch(sink, [['setCustomProp', 10, 'data-open', null]]);
		expect(sink.nodes.get(10)?.properties.has(PropertyCode.Color)).toBe(false);
	});

	test(':not() negates a compound', () => {
		const { sink } = makeSink();
		batch(sink, [
			[
				'stylesheet.register',
				's1',
				[rule([{ k: 'class', v: 'btn' }, not({ k: 'class', v: 'disabled' })], 'color:#ff0000')],
			],
			['createElement', 1, 'div'],
			['createElement', 2, 'div'],
			['setClass', 1, 'btn'],
			['setClass', 2, 'btn disabled'],
		]);
		expect(prop(sink, 1, PropertyCode.Color)).toBe(parseColor('#ff0000'));
		expect(sink.nodes.get(2)?.properties.has(PropertyCode.Color)).toBe(false);
	});

	test('state comps outside the subject compound drop the rule', () => {
		const { sink } = makeSink();
		batch(sink, [
			[
				'stylesheet.register',
				's1',
				[
					rule(
						[{ k: 'class', v: 'a' }, { k: 'state', v: 'hover' }, comb(' '), { k: 'class', v: 'b' }],
						'color:#ff0000',
					),
				],
			],
			['createElement', 1, 'div'],
			['createElement', 2, 'div'],
			['appendChild', 1, 2],
			['setClass', 1, 'a'],
			['setClass', 2, 'b'],
		]);
		expect(sink.nodes.get(2)?.properties.has(PropertyCode.Color)).toBe(false);
	});
});
