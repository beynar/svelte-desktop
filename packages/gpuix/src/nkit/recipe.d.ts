// recipe() — cva over StyleProps, resolved natively. The generic captures the
// variant axes so call sites get literal-union props: a variant value that
// isn't declared in `variants` is a type error, not just a runtime warn-once.
import type { NativeStyle, StyleProps } from './style.js';

export type VariantAxes = Record<string, Record<string, StyleProps | null | undefined>>;

type AxisChoice<V, K extends keyof V> =
	| Extract<keyof V[K], string>
	| (Extract<keyof V[K], string> extends `${'true' | 'false'}` ? boolean : never)
	| null | undefined;

type VariantProps<V extends VariantAxes> = Partial<{ [K in keyof V]: AxisChoice<V, K> }>;

type CompoundCond<V extends VariantAxes> = Partial<{
	[K in keyof V]: AxisChoice<V, K> | Array<Extract<keyof V[K], string>>;
}>;

export interface RecipeConfig<V extends VariantAxes = VariantAxes> {
	base?: StyleProps;
	variants?: V;
	defaultVariants?: VariantProps<V>;
	compoundVariants?: Array<CompoundCond<V> & { style?: StyleProps }>;
}

/** A recipe call: variant props in → native style envelope out. The config
 *  itself registered with the Rust engine at definition time — the call only
 *  ships the variant tuple. */
export type RecipeFn<V extends VariantAxes> = (
	props?: VariantProps<V> & { style?: StyleProps },
) => NativeStyle;

export function recipe<S extends string, V extends SlotAxes<S>>(
	config: SlotRecipeConfig<S, V>,
	label?: string,
): SlotRecipeFn<S, V>;
export function recipe<V extends VariantAxes>(config: RecipeConfig<V>, label?: string): RecipeFn<V>;

/** multi-slot theme — { root: recipe(...), icon: recipe(...) } */
export function slots<T extends Record<string, RecipeConfig<any>>>(
	config: T,
	label?: string,
): { [K in keyof T]: T[K] extends RecipeConfig<infer V> ? RecipeFn<V> : never };

// ── recipe({slots:…}) — the tailwind-variants multi-slot shape. Variant
// values are slot-maps: one shared axes table drives every slot's per-slot
// recipe (`name.slot` registrations under the hood). ──

type SlotMap<S extends string> = Partial<Record<S, StyleProps | null>>;
export type SlotAxes<S extends string> = Record<string, Record<string, SlotMap<S> | null | undefined>>;

type VariantPropsOf<V> = Partial<{ [K in keyof V]: AxisChoice<V, K> }>;

export interface SlotRecipeConfig<S extends string, V extends SlotAxes<S> = SlotAxes<S>> {
	/** per-slot base fragments — the slot list is inferred from these keys */
	slots: Record<S, StyleProps>;
	/** shared base, deep-merged under every slot's base */
	base?: StyleProps;
	variants?: V;
	defaultVariants?: VariantPropsOf<V>;
	compoundVariants?: Array<
		CompoundCond<V> &
			({ slots?: S[]; style?: StyleProps } | { style?: SlotMap<S> })
	>;
}

/** Per-slot call: optional prop/style overrides → the slot's native envelope. */
export type SlotFn<V> = (extra?: VariantPropsOf<V> & { style?: StyleProps }) => NativeStyle;

/** `recipe(props)` → { slot: SlotFn } — one variant tuple drives every slot. */
export interface SlotRecipeFn<S extends string, V extends SlotAxes<S>> {
	(props?: VariantPropsOf<V>): { [K in S]: SlotFn<V> };
	readonly __slots: readonly S[];
	readonly __recipes: { [K in S]: RecipeFn<VariantAxes> };
}
