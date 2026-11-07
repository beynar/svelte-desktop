// cva() — class-token lane. Same variant-resolution order as recipe() but
// values are token strings the class resolver maps. `class`/`className`
// call props append last.

export type ClassValue =
	| string | null | undefined | false
	| ClassValue[]
	| { [key: string]: ClassValue };

export type CvaVariantAxes = Record<string, Record<string, ClassValue>>;

type CvaAxisChoice<V, K extends keyof V> =
	| Extract<keyof V[K], string>
	| (Extract<keyof V[K], string> extends `${'true' | 'false'}` ? boolean : never)
	| null | undefined;

type CvaVariantProps<V extends CvaVariantAxes> = Partial<{ [K in keyof V]: CvaAxisChoice<V, K> }>;

type CvaCompoundCond<V extends CvaVariantAxes> = Partial<{
	[K in keyof V]: CvaAxisChoice<V, K> | Array<Extract<keyof V[K], string>>;
}>;

export interface CvaConfig<V extends CvaVariantAxes = CvaVariantAxes> {
	base?: ClassValue;
	variants?: V;
	defaultVariants?: CvaVariantProps<V>;
	compoundVariants?: Array<CvaCompoundCond<V> & { class?: ClassValue; className?: ClassValue }>;
}

export function cva<V extends CvaVariantAxes>(
	config: CvaConfig<V>,
	label?: string,
): (props?: CvaVariantProps<V> & { class?: ClassValue; className?: ClassValue }) => string;
