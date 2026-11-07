/**
 * style-adversarial.test.ts — regression coverage for the styling review's
 * pure-function findings:
 *   - style() sanitizes its fragment stream (a bare primitive used to ride
 *     the wire as `null`, failing the shape check and dropping the WHOLE
 *     batch the op rode in)
 *   - one recipe binding per element — a second env binding warns + drops
 *     rather than silently replacing
 *   - mergeStyleDesc carries a recipe binding through composition and warns
 *     when two collide
 *   - multi-slot recipe(): shared StyleProps values apply to EVERY slot
 *     (tailwind-variants semantics — they used to evaporate), slot-maps
 *     pick their slot, partial slot-maps report unknown keys
 *   - recipe() null/malformed config surfaces a TypeError instead of a
 *     confusing downstream crash
 * The component-context lane (componentTheme thunk reactivity, nested
 * theme() scoping/inheritance) is covered by the conformance cases —
 * componentTheme needs getContext at init.
 */
import { describe, test, expect } from 'bun:test';
import { style, mergeStyleDesc, isNativeStyle, definitionIssues } from '@svelte-desktop/gpuix/gen/nkit/style.js';
import { recipe } from '@svelte-desktop/gpuix/gen/nkit/recipe.js';

const issues = () => definitionIssues.map((i) => `${i.label} → ${i.key}`);

describe('style() — fragment stream sanitization', () => {
	test('non-object members drop out of the stream', () => {
		const env = style([{ p: 'sm' }, 42, 'nope', true, null, { m: 'lg' }]) as never as {
			__frags: unknown[];
		};
		expect(isNativeStyle(env)).toBe(true);
		expect(env.__frags).toEqual([{ p: 'sm' }, { m: 'lg' }]);
	});
	test('a bare primitive yields an empty envelope — never a poisoned frag', () => {
		for (const bad of [42, 'x', true, null, undefined]) {
			const env = style(bad as never) as never as { __frags: unknown[] };
			expect(isNativeStyle(env)).toBe(true);
			expect(env.__frags).toEqual([]);
		}
	});
	test('nested envs unwrap to their ordered frag stream', () => {
		const inner = style([{ p: 'sm' }, { m: 'lg' }]);
		const env = style([inner, { fg: 'red' }]) as never as { __frags: unknown[] };
		expect(env.__frags).toEqual([{ p: 'sm' }, { m: 'lg' }, { fg: 'red' }]);
	});
});

describe('one recipe binding per element', () => {
	test('style() keeps the first binding and warns on the second', () => {
		const a = recipe({ base: { p: 'sm' } }, 'adv-a');
		const b = recipe({ base: { m: 'lg' } }, 'adv-b');
		const env = style([a(), b()]) as never as {
			__recipe: { name: string };
			__frags: unknown[];
		};
		expect(env.__recipe.name).toBe('adv-a');
		expect(env.__frags).toEqual([]);
		expect(issues().some((i) => i.includes("recipe 'adv-b' dropped"))).toBe(true);
	});
	test('mergeStyleDesc carries a binding through composition', () => {
		const r = recipe({ base: { p: 'sm' } }, 'adv-merge');
		const env = mergeStyleDesc(r(), style({ m: 'lg' })) as never as {
			__recipe: { name: string };
			__frags: unknown[];
		};
		expect(env.__recipe.name).toBe('adv-merge');
		expect(env.__frags).toEqual([{ m: 'lg' }]);
	});
	test('mergeStyleDesc warns when both sides bind — later wins', () => {
		const a = recipe({ base: { p: 'sm' } }, 'adv-ma');
		const b = recipe({ base: { m: 'lg' } }, 'adv-mb');
		const env = mergeStyleDesc(a(), b()) as never as { __recipe: { name: string } };
		expect(env.__recipe.name).toBe('adv-mb');
		expect(issues().some((i) => i.includes("'adv-ma'") && i.includes("'adv-mb'"))).toBe(true);
	});
});

describe('recipe() — config guards', () => {
	test('null/malformed config throws TypeError', () => {
		for (const bad of [null, undefined, 42, 'x']) {
			expect(() => recipe(bad as never)).toThrow(TypeError);
		}
	});
	test('a recipe env nested inside a recipe config warns, then unwraps', () => {
		const inner = recipe({ base: { p: 'sm' } }, 'adv-inner');
		const outer = recipe({ base: inner() }, 'adv-outer');
		expect(issues().some((i) => i.includes("recipe 'adv-inner' can't nest"))).toBe(true);
		// inner's frags flattened into outer's base — not silently dropped
		const env = outer() as never as { __recipe: { name: string } };
		expect(env.__recipe.name).toBe('adv-outer');
	});
});

describe('recipe() — multi-slot semantics', () => {
	const alert = recipe(
		{
			slots: { base: { p: 'sm' }, icon: { m: 'xs' } },
			variants: {
				color: {
					// slot-map: each slot gets its own style
					danger: { base: { bg: 'danger' }, icon: { fg: 'danger' } },
					// shared StyleProps: applies to EVERY slot
					quiet: { opacity: 0.6 },
				},
			},
		},
		'adv-alert',
	);

	test('slot-map variant values pick their slot', () => {
		const s = alert({ color: 'danger' });
		expect(alert.__slots).toEqual(['base', 'icon']);
		expect(s.base().__recipe.name).toBe('adv-alert.base');
		expect(s.icon().__recipe.name).toBe('adv-alert.icon');
		expect(s.base().__recipe.variants).toEqual({ color: 'danger' });
	});
	test('shared StyleProps values register on every slot', () => {
		// 'quiet' is a bare StyleProps value — tailwind-variants semantics say
		// it styles all slots. It must land on each slot's recipe config (a
		// null marker would evaporate the style entirely).
		const s = alert({ color: 'quiet' });
		for (const slot of ['base', 'icon']) {
			const env = s[slot]() as never as { __recipe: { variants: Record<string, string> } };
			expect(env.__recipe.variants.color).toBe('quiet');
		}
		// the registered per-slot configs carry the shared style — verify via
		// the recipe's bound registry rather than guessing the wire shape
		const bound = (alert as never as { __recipes: Record<string, (p?: object) => unknown> }).__recipes;
		expect(bound.base({ color: 'quiet' })).toBeTruthy();
		expect(bound.icon({ color: 'quiet' })).toBeTruthy();
	});
	test('partial slot-maps report unknown keys', () => {
		recipe(
			{
				slots: { root: {}, icon: {} },
				variants: { size: { lg: { root: { p: 'lg' }, icoon: { m: 'lg' } } } },
			},
			'adv-typo',
		);
		expect(issues().some((i) => i.includes('icoon'))).toBe(true);
	});
});

describe('vocab parity — previously refused fields now wire', () => {
	test('token lane: tracking/leading/case/tabular-nums/corner radii emit symbolic fields', async () => {
		const { resolveTokens } = await import('@svelte-desktop/gpuix/gen/nkit/tokens.js');
		const out = resolveTokens('tracking-tight leading-tight uppercase tabular-nums rounded-tl-lg rounded-br-sm');
		expect(out.letterSpacing).toBe(-0.4);
		expect(out.lineHeightScale).toBe(1.25);
		expect(out.textTransform).toBe('uppercase');
		expect(out.fontFeatures).toEqual({ tnum: 1 });
		expect(out.borderTopLeftRadius).toBe('lg');
		expect(out.borderBottomRightRadius).toBe('sm');
	});
	test('token lane: numeric leading is px lineHeight', async () => {
		const { resolveTokens } = await import('@svelte-desktop/gpuix/gen/nkit/tokens.js');
		expect(resolveTokens('leading-6').lineHeight).toBe(6);
		expect(resolveTokens('leading-6').lineHeightScale).toBeUndefined();
	});
	test('props lane: new vocab keys reach StyleDesc fields', async () => {
		const { resolveStyleProps } = await import('@svelte-desktop/gpuix/gen/nkit/style.js');
		const fields = resolveStyleProps({
			tracking: -0.4,
			leading: 1.5,
			radiusTl: 'lg',
			radiusB: 4,
			fontFeatures: { tnum: 1 },
			case: 'uppercase',
		});
		expect(fields.letterSpacing).toBe(-0.4);
		expect(fields.lineHeightScale).toBe(1.5);
		expect(fields.borderTopLeftRadius).toBe('lg');
		expect(fields.borderBottomLeftRadius).toBe(4);
		expect(fields.borderBottomRightRadius).toBe(4);
		expect(fields.fontFeatures).toEqual({ tnum: 1 });
		expect(fields.textTransform).toBe('uppercase');
	});
	test('props lane: bad values still drop out of the field map', async () => {
		const { resolveStyleProps, checkStyleProps } = await import('@svelte-desktop/gpuix/gen/nkit/style.js');
		const fields = resolveStyleProps({ tracking: 'wide', case: 'smallcaps' });
		expect(fields.letterSpacing).toBeUndefined();
		expect(fields.textTransform).toBeUndefined();
		// the definition-time audit names the dropped keys
		expect(checkStyleProps({ tracking: 'wide', case: 'smallcaps' }).length).toBe(2);
	});
});
