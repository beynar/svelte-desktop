// mini-cva — same recipe shape + variant resolution order as svelai's engine
// (base → variants in key order → compoundVariants → class/className).
// No tailwind-merge: the token resolver is last-write-wins per prop.

const flat = (v) =>
	v == null || v === false ? [] : Array.isArray(v) ? v.flatMap(flat) : typeof v === 'object' ? flat(Object.values(v)) : [v];

export function cva(config) {
	return (props = {}) => {
		const parts = flat(config.base);
		const { variants = {}, defaultVariants = {}, compoundVariants = [] } = config;
		const eff = { ...defaultVariants };
		for (const k in props) if (props[k] !== undefined) eff[k] = props[k];
		for (const key of Object.keys(variants)) {
			const v = eff[key];
			parts.push(...flat(variants[key][typeof v === 'boolean' ? String(v) : v]));
		}
		for (const { class: c, className: cn, ...conds } of compoundVariants)
			if (Object.entries(conds).every(([k, v]) => (Array.isArray(v) ? v.includes(eff[k]) : eff[k] === v)))
				parts.push(...flat(c), ...flat(cn));
		parts.push(...flat(props.class), ...flat(props.className));
		return parts.filter(Boolean).join(' ');
	};
}
