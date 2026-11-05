// recipe() — cva over StyleProps. Same resolution order as svelai's cva:
// base → variants in key order → compoundVariants → per-call `style` escape.
// Variant values are StyleProps objects, deep-merged (nested hover/active
// merge key-wise; everything else is last-write-wins).
//
// Definition-time validation (the StyleX shape): every fragment in the config
// is walked at module load — typo'd keys, malformed values, undeclared
// defaultVariants — and frozen so components can't mutate shared fragments.
// Palette-dependent color refs re-check on theme swaps via the registry.
import { registerStyleDef, reportIssues, deepFreeze, envify, mergeProps, isNativeStyle } from './style.js';
// '../../native.ts' resolves from the compiled location src/gen/nkit/ —
// the build aliases '../native' for that layout.
import { registerRecipe } from '../native';

let recipeSeq = 0;

/** style() envs unwrap to their frag stream in any frag position — `base`,
 *  variant values, slot-maps, compound styles, the `style:` escape. A
 *  mergeStyleDesc env collapses ordered (null retracts, buckets merge). A
 *  recipe-carrying env can't compose here — one `setRecipe` slot per element
 *  means nested bindings would silently vanish, so they warn instead. */
const fragOf = (v) => {
	if (isNativeStyle(v)) {
		if (v.__recipe)
			reportIssues('recipe()', [`recipe '${v.__recipe.name}' can't nest inside a recipe config — compose style() envs, not recipe bindings`]);
		return v.__frags.length === 1 ? v.__frags[0] : v.__frags.reduce((a, f) => mergeProps(a, f), {});
	}
	return v;
};

function* fragmentsOf(name, { base, variants = {}, compoundVariants = [] }) {
	if (base) yield [`${name}.base`, base];
	for (const key in variants)
		for (const v in variants[key])
			if (variants[key][v]) yield [`${name}.${key}=${v}`, variants[key][v]];
	for (let i = 0; i < compoundVariants.length; i++)
		if (compoundVariants[i].style) yield [`${name}.compound[${i}]`, compoundVariants[i].style];
}

export function recipe(config, label) {
	if (config == null || typeof config !== 'object')
		throw new TypeError('recipe(config): config must be an object');
	// multi-slot shape: `slots:` map → one shared variant tuple drives every
	// slot's per-slot recipe (tailwind-variants semantics)
	if (config.slots) return slotRecipe(config, label ?? `recipe#${++recipeSeq}`);
	const name = label ?? `recipe#${++recipeSeq}`;
	const { base, variants = {}, defaultVariants = {}, compoundVariants = [] } = config;
	// style() envs unwrap to their frags in every frag position — a recipe
	// can compose style() output into base/variants/compounds directly
	const cfg = {
		base: fragOf(base),
		variants: Object.fromEntries(
			Object.entries(variants).map(([axis, table]) => [
				axis,
				Object.fromEntries(Object.entries(table).map(([v, f]) => [v, fragOf(f)])),
			]),
		),
		defaultVariants,
		compoundVariants: compoundVariants.map((c) => ({ ...c, style: fragOf(c.style) })),
	};
	for (const [fragLabel, frag] of fragmentsOf(name, cfg)) {
		reportIssues(fragLabel, registerStyleDef(fragLabel, frag));
		deepFreeze(frag);
	}
	// declaration checks — a typo'd variant key or default silently no-ops
	for (const k in defaultVariants) {
		const v = defaultVariants[k];
		if (!(k in variants)) reportIssues(name, [`defaultVariants key '${k}'`]);
		else if (v != null && v !== false && !(String(v) in variants[k]))
			reportIssues(name, [`defaultVariants ${k}='${v}'`]);
	}
	for (const { style, ...conds } of compoundVariants)
		for (const k in conds)
			if (!(k in variants)) reportIssues(name, [`compoundVariants key '${k}'`]);
	deepFreeze(cfg);

	// The recipe itself resolves natively: the config ships once (Rust
	// compiles the StyleProps fragments), then calls ship variant names.
	registerRecipe(name, cfg);

	return (props = {}) => {
		const { style, ...rest } = props;
		// effective tuple for the call-time audit — the engine re-derives it
		const eff = { ...defaultVariants };
		for (const k in rest) if (rest[k] !== undefined) eff[k] = rest[k];
		for (const key of Object.keys(variants)) {
			const v = eff[key];
			const vk = typeof v === 'boolean' ? String(v) : v;
			if (v != null && v !== false && !(vk in variants[key]))
				reportIssues(name, [`unknown ${key}='${v}'`]);
		}
		return envify({
			__native: true,
			__recipe: { name, variants: rest, extra: fragOf(style) ?? null },
			__frags: [],
			// `color` rides both lanes — the variant tuple (compound matching)
			// and the element's `color` ctx (where `color-*` refs resolve).
			__ctx: rest.color ?? null,
		});
	};
}

/** multi-slot theme: { root: recipe(...), icon: recipe(...) } — mirrors svelai's per-slot themes */
export function slots(config, label = 'theme') {
	const out = {};
	for (const slot in config) out[slot] = recipe(config[slot], `${label}.${slot}`);
	return out;
}

/**
 * slotRecipe(config, name) — the tailwind-variants multi-slot shape behind
 * recipe(). One shared variant tuple drives every slot:
 *
 *   const alert = recipe({
 *     slots: { base: {...}, icon: {...} },
 *     base: {...},                                  // optional shared base
 *     variants: { color: { danger: { base: {...}, icon: {...} } } },
 *     compoundVariants: [
 *       { size: 'sm', slots: ['base'], style: {...} },   // shared style → listed slots
 *       { color: 'danger', style: { icon: {...} } },     // slot-mapped style
 *     ],
 *     defaultVariants: { color: 'default' },
 *   });
 *
 *   const s = alert({ color: 'danger' });           // one tuple → every slot
 *   <div {@attach s.base()}><svg {@attach s.icon()}/></div>
 *   s.base({ style: {...} })                        // per-slot escape hatch
 *
 * Decomposes into per-slot recipe registrations (`name.slot`) at definition
 * time — the Rust engine and wire cost are identical to a per-slot theme
 * bag; each element ships its own ~30-byte tuple. A variant value that
 * doesn't name a slot leaves a `null` marker on that slot's axis (declared,
 * adds no style), so compounds can still match shared axes on every slot.
 */
function slotRecipe(config, name) {
	const {
		slots: slotBases = {},
		base,
		variants = {},
		compoundVariants = [],
		defaultVariants = {},
	} = config;
	const slotNames = Object.keys(slotBases);
	const slotSet = new Set(slotNames);
	// A value is a slot-map iff some key names a slot; otherwise it's shared
	// StyleProps applying to every slot (tailwind-variants semantics — a
	// plain {p:'md'} under `variants` styles all slots). Partial intersection
	// is a likely slot-name typo — surface it.
	const slotMapOf = (v, what) => {
		if (v == null || typeof v !== 'object' || isNativeStyle(v) || Array.isArray(v)) return null;
		const keys = Object.keys(v);
		const hits = keys.filter((k) => slotSet.has(k));
		if (!hits.length) return null; // shared StyleProps
		const unknown = keys.filter((k) => !slotSet.has(k));
		if (unknown.length) reportIssues(name, [`${what}: unknown slot key(s) ${unknown.join(', ')}`]);
		return v;
	};
	const bound = {};
	for (const S of slotNames) {
		// shared base + slot base — deep (pseudo buckets merge key-wise)
		const slotBase = mergeProps(mergeProps({}, fragOf(base)), fragOf(slotBases[S]));
		// every axis lands on every slot; unstyled entries become null markers.
		// An env or plain StyleProps value applies to every slot; a slot-map
		// picks [S].
		const slotVariants = {};
		for (const axis in variants) {
			slotVariants[axis] = {};
			for (const v in variants[axis]) {
				const value = variants[axis][v];
				slotVariants[axis][v] =
					value == null ? null
					: isNativeStyle(value) ? fragOf(value)
					: slotMapOf(value, `${axis}=${v}`) ? fragOf(value[S]) ?? null
					: fragOf(value);
			}
		}
		const slotCompounds = [];
		for (const c of compoundVariants) {
			const { style, slots: targets, ...conds } = c;
			if (style == null) continue;
			if (targets) {
				if (targets.includes(S)) slotCompounds.push({ ...conds, style: fragOf(style) });
				continue;
			}
			const sm = slotMapOf(style, 'compound style');
			if (sm) {
				if (sm[S] != null) slotCompounds.push({ ...conds, style: fragOf(sm[S]) });
			} else {
				slotCompounds.push({ ...conds, style: fragOf(style) });
			}
		}
		bound[S] = recipe({
			base: slotBase,
			variants: slotVariants,
			compoundVariants: slotCompounds,
			defaultVariants,
		}, `${name}.${S}`);
	}
	const call = (props = {}) => {
		const out = {};
		for (const S of slotNames)
			out[S] = (extra) => bound[S](extra ? { ...props, ...extra } : props);
		return out;
	};
	call.__slots = slotNames;
	call.__recipes = bound;
	return call;
}
