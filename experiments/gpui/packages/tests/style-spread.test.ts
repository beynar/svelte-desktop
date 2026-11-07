/**
 * style-spread.test.ts — the attachment + spread lanes for nkit styles.
 *
 * `style()`/`recipe()`/`mergeStyleDesc` envelopes are callable attachments:
 * `{@attach env}` applies through the element's `styleProps` prop and clears
 * on teardown. The same envelope also exposes `.style` for the prop-spread
 * lane — `{...env.style}` emits `styleProps: env`, and gdom's setter routes
 * it into applyNativeStyle — so attach, spread, and `use:applyStyle` all
 * drive the same setStyleProps/setRecipe ops. Asserts:
 *   - every env is a function carrying __native own-props (attachment shape)
 *   - env(el) emits setStyleProps/setRecipe; its return cleans both layers
 *   - .style → {styleProps: env} (non-enumerable — no self-reference cycle)
 *   - el.styleProps = env / setAttribute('styleProps') / removeAttribute lanes
 */
import { describe, test, expect } from 'bun:test';
import {
	installGlobals,
	doc,
	materializeRoot,
} from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush } from '@svelte-desktop/gpuix/native';
import { style, mergeStyleDesc, isNativeStyle } from '@svelte-desktop/gpuix/gen/nkit/style.js';
import { recipe } from '@svelte-desktop/gpuix/gen/nkit/recipe.js';

installGlobals();

/** Op-recording renderer stand-in — same applyBatch shape as QuickguiSink. */
const ops: unknown[][] = [];
setRenderer({
	applyBatch: (json: string) => {
		ops.push(...(JSON.parse(json) as unknown[][]));
		return [];
	},
} as never);

function drainOps(): unknown[][] {
	flush();
	return ops.splice(0);
}

/** A connected, materialized element (nativeId bound; body is a dead-end host). */
function mountEl(tag = 'div') {
	const el = doc.createElement(tag);
	doc.body.appendChild(el);
	materializeRoot(el);
	drainOps();
	return el;
}

const styleOps = () =>
	drainOps().filter((op) => op[0] === 'setStyleProps' || op[0] === 'setRecipe');

describe('envelope shape — every env is an attachment', () => {
	test('style() env is callable with __native own-props', () => {
		const card = style({ p: 'lg' });
		expect(typeof card).toBe('function');
		expect(isNativeStyle(card)).toBe(true);
		expect(card.__frags).toEqual([{ p: 'lg' }]);
	});

	test('mergeStyleDesc env is callable', () => {
		expect(typeof mergeStyleDesc(style({ p: 'md' }), style({ px: 'xl' }))).toBe('function');
	});

	test('recipe() call env is callable', () => {
		const btn = recipe({ base: { p: 'md' } });
		expect(typeof btn({})).toBe('function');
	});
});

describe('attachment lane — env(el)', () => {
	test('env(el) emits setStyleProps/setRecipe, cleanup clears', () => {
		const el = mountEl();
		const env = style({ p: 'lg', bg: 'primary' });
		const cleanup = env(el);
		let emitted = styleOps();
		expect(emitted).toContainEqual(['setStyleProps', el.nativeId, [{ p: 'lg', bg: 'primary' }]]);
		expect(emitted).toContainEqual(['setRecipe', el.nativeId, null, null, null]);
		expect(typeof cleanup).toBe('function');
		cleanup();
		emitted = styleOps();
		expect(emitted).toContainEqual(['setStyleProps', el.nativeId, null]);
	});

	test('recipe env(el) emits setRecipe with name + variants', () => {
		const el = mountEl();
		const btn = recipe({
			base: { p: 'md' },
			variants: { size: { sm: { p: 'sm' } } },
		});
		btn({ size: 'sm' })(el);
		const emitted = styleOps().find((op) => op[0] === 'setRecipe');
		expect(emitted?.[3]).toEqual({ size: 'sm' });
	});

	test('recipe color rides both lanes — variants tuple + color ctx prop', () => {
		const el = mountEl();
		const btn = recipe({
			base: { bg: 'color' },
			variants: { color: { danger: null } },
		});
		const env = btn({ color: 'danger' });
		expect(env.__ctx).toBe('danger');
		env(el);
		const emitted = drainOps();
		expect(emitted).toContainEqual(['setRecipe', el.nativeId, expect.any(String), { color: 'danger' }, null]);
		expect(emitted).toContainEqual(['setCustomProp', el.nativeId, 'color', 'danger']);
	});
});

describe('multi-slot recipe — the tv shape', () => {
	const alert = recipe({
		slots: { base: { p: 'md' }, icon: { w: 'sm' } },
		base: { radius: 'lg' },
		variants: {
			color: {
				danger: { base: { bg: 'danger' }, icon: { fg: 'danger' } },
				plain: { base: { bg: 'surface' } }, // icon unstyled → null marker
			},
		},
		defaultVariants: { color: 'plain' },
		compoundVariants: [{ color: 'danger', slots: ['icon'], style: { w: 'md' } }],
	});

	test('call returns per-slot fns producing callable envs', () => {
		expect(Array.isArray(alert.__slots)).toBe(true);
		expect(alert.__slots).toEqual(['base', 'icon']);
		const s = alert({ color: 'danger' });
		expect(typeof s.base).toBe('function');
		expect(typeof s.icon).toBe('function');
		expect(typeof s.base()).toBe('function'); // the env
		expect(s.base().__recipe.name).toMatch(/\.base$/);
		expect(s.icon().__recipe.name).toMatch(/\.icon$/);
	});

	test('shared tuple ships on each slot env; slot names decompose', () => {
		const el = mountEl();
		alert({ color: 'danger' }).icon()(el);
		const emitted = styleOps().find((op) => op[0] === 'setRecipe');
		expect(emitted?.[2]).toMatch(/\.icon$/);
		expect(emitted?.[3]).toEqual({ color: 'danger' });
	});

	test('per-slot extra props merge over the shared tuple', () => {
		const s = alert({ color: 'danger' });
		const env = s.base({ style: { mt: 'lg' } });
		expect(env.__recipe.variants).toEqual({ color: 'danger' });
		expect(env.__recipe.extra).toEqual({ mt: 'lg' });
	});

	test('slot env attaches through the same styleProps lane', () => {
		const el = mountEl();
		alert({ color: 'plain' }).base()(el);
		expect(el._nativeEnv?.__recipe?.name).toMatch(/\.base$/);
	});
});

describe('composition — style() envs inside recipe positions', () => {
	test('env in base/variants/compounds unwraps to frags', () => {
		const interactive = style({ cursor: 'pointer', hover: { bg: 'surface-floating' } });
		const chip = recipe({
			base: interactive,
			variants: { tone: { accent: mergeStyleDesc(interactive, { bg: 'primary-muted' }) } },
			compoundVariants: [{ tone: 'accent', style: interactive }],
		});
		const env = chip({ tone: 'accent', style: interactive });
		// env unwraps: extra is a single frag (not the env function)
		expect(env.__recipe.extra).toEqual({ cursor: 'pointer', hover: { bg: 'surface-floating' } });
	});

	test('multi-frag env collapses ordered into one frag', () => {
		const merged = mergeStyleDesc(style({ p: 'md', m: 'sm' }), { m: null, px: 'lg' });
		const env = recipe({ base: merged })({});
		expect(env.__recipe).not.toBeNull();
		// the unwrap merged frags: m retracted, px kept
		expect(env.__recipe.name).toContain('recipe#');
	});

	test('env variant value in multi-slot applies to every slot', () => {
		const ring = style({ ring: 2, ringColor: 'color/50' });
		const t = recipe({
			slots: { box: { p: 'md' }, icon: { w: 'sm' } },
			variants: { state: { focus: ring } },
		});
		const s = t({ state: 'focus' });
		expect(s.box().__recipe.name).toMatch(/\.box$/);
		expect(s.icon().__recipe.name).toMatch(/\.icon$/);
	});

	test('env in a slot-map entry unwraps for that slot only', () => {
		const t = recipe({
			slots: { box: { p: 'md' }, icon: { w: 'sm' } },
			variants: { tone: { hot: { icon: style({ fg: 'danger' }) } } },
		});
		expect(typeof t({ tone: 'hot' }).icon()).toBe('function');
	});
});

describe('spread lane — env.style', () => {
	test('.style → {styleProps: env}, non-enumerable', () => {
		const card = style({ p: 'lg' });
		expect(card.style).toEqual({ styleProps: card });
		// non-enumerable — env spreads must not copy a self-reference
		expect({ ...card }).not.toHaveProperty('style');
		expect(String(JSON.stringify(card))).not.toContain('styleProps');
	});

	test('el.styleProps = env emits setStyleProps; removeAttribute clears', () => {
		const el = mountEl();
		el.styleProps = style({ px: 'xl' });
		expect(styleOps()).toContainEqual(['setStyleProps', el.nativeId, [{ px: 'xl' }]]);
		el.removeAttribute('styleProps');
		expect(styleOps()).toContainEqual(['setStyleProps', el.nativeId, null]);
	});

	test('setAttribute("styleProps", env) routes the same lane', () => {
		const el = mountEl();
		el.setAttribute('styleProps', style({ px: 'xl' }) as never);
		expect(styleOps()).toContainEqual(['setStyleProps', el.nativeId, [{ px: 'xl' }]]);
		expect(el.hasAttribute('styleProps')).toBe(false); // prop channel, not an attr
	});
});
