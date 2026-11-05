// minimal stand-ins for the bits-ui helpers the vendored components import.
// mergeProps merges attrs with class concatenation (cn semantics lite).
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function mergeProps(...sources) {
	const out = {};
	for (const src of sources) {
		if (!src) continue;
		for (const [k, v] of Object.entries(src)) {
			if (k === 'class') out.class = twMerge(clsx(out.class, v));
			else out[k] = v;
		}
	}
	return out;
}
