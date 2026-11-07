// JS↔Rust drift probe — for each StyleProps fragment, compare the JS mirror
// (`resolveStyleProps`, symbolic field names) with what the native engine
// produced on the retained tree (resolved values). Field-name parity means
// the vocabulary mapping didn't drift; value resolution is shared so only
// names need checking. Pseudo buckets compare key-shape recursively.
import { TestGpuixRenderer } from '@gpuix/native';

// rebuild gen/nkit/ so the probe runs current sources (same as conformance)
await import('@svelte-desktop/svelte/build.ts');
import { installGlobals, doc, materializeRoot } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';

installGlobals();
const { style, resolveStyleProps } = await import('@svelte-desktop/gpuix/gen/nkit/style.js');
const renderer = new TestGpuixRenderer(800, 600);
setRenderer(renderer as any);

const FRAGMENTS: unknown[] = [
	{ p: 'lg', px: 'xl' }, { px: 'xl', p: 'lg' },
	{ p: 'md', pt: 'sm' }, { m: 'lg', mx: 'auto' }, { m: 'sm', ms: 'lg' },
	{ bg: 'primary', fg: 'danger', rounded: 'lg', borderW: 2, borderColor: 'info' },
	{ w: 'full', h: 'screen', minW: 0, maxH: 'fit' },
	{ flex: 'row', items: 'center', justify: 'between', gap: 'md', wrap: true },
	{ grow: 1, shrink: 0, basis: '1/2' },
	{ pos: 'absolute', inset: 0, top: 'md', z: 'top' },
	{ overflow: 'hidden', overflowX: 'auto' },
	{ ring: 2, ringColor: 'primary', ringInset: true },
	{ raised: 'md' }, { raised: 'md', borderW: 4, borderColor: 'danger' },
	{ shadow: { offsetX: 0, offsetY: 2, blurRadius: 4, spreadRadius: 0, color: '#000000' } },
	{ text: 'lg', font: 'mono', tracking: 'wide', leading: 'tight', align: 'center' },
	{ underline: true, decoration: 'primary', italic: true, uppercase: true },
	{ lineClamp: 3, opacity: 0.5, cursor: 'pointer', select: 'none' },
	{ aspect: 'video', aspect: 'square' } as Record<string, unknown>,
	{ aspect: 'square', objectFit: 'cover' },
	{ hover: { bg: 'info', fg: 'primary' } },
	{ focusVisible: { ring: 2, ringColor: 'info' }, active: { bg: 'primary' } },
	{ dark: { bg: 'elevated' }, hover: { bg: 'primary', ring: 1 } },
	{ hover: { p: 'sm', px: 'lg', bg: 'info' } },
	{ disabled: { opacity: 0.4, cursor: 'default' } },
	{ gridCols: 3, colSpan: 2, rowSpan: 1 },
	{ self: 'end', content: 'start' },
	{ rotate: 45, scale: 1.5, translateX: 'sm' },
	{ bg: 'primary', hover: { bg: 'danger' }, focusVisible: { bg: 'info' } },
	{ unknownKey: 1, bg: 'primary' },
	{ p: null, m: 'sm' },
	{ bg: 'color-primary' },
	{ p: 'control-md', gap: 'space-lg' },
	// ordered-fragment streams — the theme-ladder shape: levels ship unmerged
	// and the engine resolves them (null deletes a level's fields).
	[{ p: 'md' }, { p: null }],
	[{ px: 'sm' }, { p: null }],
	[{ p: 'md', bg: 'danger' }, { p: null }],
	[{ p: 'md' }, { p: false }],
	[{ hover: { bg: 'danger', fg: 'primary' } }, { hover: { fg: null } }],
	[{ hover: { bg: 'danger' } }, { hover: null }],
	[{ ring: 2 }, { ringColor: 'primary' }],
	[{ shadow: 'lg' }, { ring: null }],
	[{ ring: 2 }, { ring: null }],
	[{ p: 'md', hover: { bg: 'info' } }, { px: 'lg', hover: { fg: 'danger' } }],
];

const root = doc.createElement('div');
doc.body.appendChild(root);
materializeRoot(root as any);
const { applyNativeStyle } = await import('@svelte-desktop/gpuix/gdom');

const els: any[] = [];
for (const frag of FRAGMENTS) {
	const el = doc.createElement('div');
	applyNativeStyle(el, style(frag as any));
	root.appendChild(el);
	els.push(el);
}
flush(); (renderer as any).flush(); drainAfterRender();
await new Promise((r) => setTimeout(r, 30));

const nativeStyles: Record<string, any>[] = [];
const walk = (n: any) => { nativeStyles.push(n.style ?? {}); n.children?.forEach(walk); };
walk(JSON.parse((renderer as any).getTreeJson()));
nativeStyles.shift(); // drop the synthetic tree root — els start at index 1

// Normalizations both directions:
//  - null values are absent (native buckets serialize a full StyleDesc with
//    nulls; a null leaf is the same as a missing key)
//  - boxShadow collapses to presence-only — the mirror emits a single shadow
//    object, the native pipe normalizes to an array and may add `inset`/
//    consume the `ring` flag
//  - `auto` dimension values serialize away natively (Auto is the default)
//  - `raised`/`lift` stay symbolic in the mirror but resolve to
//    boxShadow/borderColor/border*Width natively — presence of those fields
//    under a raised fragment is expected, not drift
const RAISED_KEYS = new Set(['raised', 'lift', 'boxShadow', 'borderColor', 'borderWidth',
	'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']);

const keyShape = (o: any, prefix = ''): string[] =>
	Object.keys(o ?? {}).flatMap((k) => {
		const v = o[k];
		if (v == null) return [];
		if (k === 'boxShadow') return [`${prefix}${k}`];
		return v && typeof v === 'object' && !Array.isArray(v)
			? keyShape(v, `${prefix}${k}.`)
			: [`${prefix}${k}`];
	}).sort();

const stripAuto = (o: any, keys: Set<string>, prefix = '') => {
	for (const k of Object.keys(o ?? {})) {
		if (o[k] === 'auto') keys.delete(`${prefix}${k}`);
		else if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) && k !== 'boxShadow')
			stripAuto(o[k], keys, `${prefix}${k}.`);
	}
};

let pass = 0, fail = 0;
FRAGMENTS.forEach((frag, i) => {
	const mirror = resolveStyleProps(frag as any);
	const native = nativeStyles[i];
	if (!native) { console.log(`❌ [${i}] no native style for ${JSON.stringify(frag)}`); fail++; return; }
	const hasRaised = (frag as any).raised != null || (frag as any).lift != null;
	const mj = new Set(keyShape(mirror));
	const nj = new Set(keyShape(native));
	stripAuto(mirror, mj);
	if (hasRaised) {
		for (const k of [...mj]) if (RAISED_KEYS.has(k)) mj.delete(k);
		for (const k of [...nj]) if (RAISED_KEYS.has(k)) nj.delete(k);
	}
	const missing = [...mj].filter((k) => !nj.has(k));
	const extra = [...nj].filter((k) => !mj.has(k));
	const label = `[${i}] ${JSON.stringify(frag).slice(0, 60)}`;
	if (missing.length === 0 && extra.length === 0) { pass++; return; }
	console.log(`❌ ${label}\n   missing natively: ${JSON.stringify(missing)}\n   extra natively: ${JSON.stringify(extra)}`);
	fail++;
});
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
