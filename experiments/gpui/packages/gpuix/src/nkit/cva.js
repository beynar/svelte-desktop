// mini-cva — same recipe shape + variant resolution order as svelai's engine
// (base → variants in key order → compoundVariants → class/className).
// No tailwind-merge: the token resolver is last-write-wins per prop.
//
// Definition-time check: every class string is tokenized at module load and
// drops are collected into definitionIssues (lane 'class') — silently, since
// the class lane has intentional boundary drops (data-*/peer-*/arbitrary
// pseudos the native channel can't express). The audit is probe-visible.

import { checkTokens } from './tokens.js';
import { reportIssues } from './style.js';

const flat = (v) =>
	v == null || v === false ? [] : Array.isArray(v) ? v.flatMap(flat) : typeof v === 'object' ? flat(Object.values(v)) : [v];

let cvaSeq = 0;

function* classFragments(name, { base, variants = {}, compoundVariants = [] }) {
	if (base) yield [`${name}.base`, base];
	for (const key in variants)
		for (const v in variants[key])
			if (variants[key][v]) yield [`${name}.${key}=${v}`, variants[key][v]];
	for (let i = 0; i < compoundVariants.length; i++) {
		const cv = compoundVariants[i];
		if (cv.class || cv.className) yield [`${name}.compound[${i}]`, [cv.class, cv.className]];
	}
}

export function cva(config, label) {
	const name = label ?? `cva#${++cvaSeq}`;
	for (const [fragLabel, frag] of classFragments(name, config))
		for (const str of flat(frag))
			reportIssues(fragLabel, checkTokens(String(str)), { lane: 'class' });

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
