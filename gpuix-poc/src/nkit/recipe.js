// recipe() — cva over StyleProps. Same resolution order as svelai's cva:
// base → variants in key order → compoundVariants → per-call `style` escape.
// Variant values are StyleProps objects, deep-merged (nested hover/active
// merge key-wise; everything else is last-write-wins).
import { mergeProps } from './style.js';

export function recipe(config) {
	const { base, variants = {}, defaultVariants = {}, compoundVariants = [] } = config;
	return (props = {}) => {
		const out = {};
		mergeProps(out, base);
		const eff = { ...defaultVariants };
		for (const k in props) if (props[k] !== undefined) eff[k] = props[k];
		for (const key of Object.keys(variants)) {
			const v = eff[key];
			mergeProps(out, variants[key][typeof v === 'boolean' ? String(v) : v]);
		}
		for (const { style, ...conds } of compoundVariants)
			if (Object.entries(conds).every(([k, v]) => (Array.isArray(v) ? v.includes(eff[k]) : eff[k] === v)))
				mergeProps(out, style);
		// per-call escape hatch — raw StyleProps merged last
		mergeProps(out, props.style);
		return out;
	};
}

/** multi-slot theme: { root: recipe(...), icon: recipe(...) } — mirrors svelai's per-slot themes */
export function slots(config) {
	const out = {};
	for (const slot in config) out[slot] = recipe(config[slot]);
	return out;
}
