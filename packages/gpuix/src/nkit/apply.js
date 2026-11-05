// Svelte actions bridging kit style objects / structured props into gdom.
// ('../../gdom.ts' resolves correctly from the compiled location src/gen/nkit/.)
import { applyNativeStyle } from '../../gdom.ts';

export function applyStyle(el, style) {
	applyNativeStyle(el, style);
	return {
		update(next) {
			applyNativeStyle(el, next);
		},
		destroy() {
			applyNativeStyle(el, null);
		},
	};
}

/** structured native props — position objects, motion, source, theme…
 *  attributes stringify; this goes through el.setCustomProp untouched. */
export function nativeProps(el, props) {
	let keys = [];
	const apply = (obj) => {
		for (const k of keys) el.removeCustomProp(k);
		keys = [];
		for (const k in obj ?? {}) {
			el.setCustomProp(k, obj[k]);
			keys.push(k);
		}
	};
	apply(props);
	return {
		update: apply,
		destroy() {
			for (const k of keys) el.removeCustomProp(k);
		},
	};
}
