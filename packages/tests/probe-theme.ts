/**
 * theme-prop probe — the token DEFERRAL path: tokens cross the wire
 * unresolved (`bg-secondary` → backgroundColor:'secondary'), the Rust theme
 * chain resolves them, and a `theme` prop on an ancestor must change the
 * resolved value. secondary base: light #e4e4e7 / dark #27272a.
 * danger readable: dark #ff7466 / light #d2161c.
 */
import { TestGpuixRenderer } from '@gpuix/native';

// rebuild gen/nkit/ so the probe runs current sources (same as conformance)
await import('@svelte-desktop/svelte/build.ts');

import { installGlobals, doc, materializeRoot, applyNativeStyle } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush } from '@svelte-desktop/gpuix/native';
const { resolveTokens } = await import('@svelte-desktop/gpuix/gen/nkit/tokens.js');

installGlobals();
const renderer = new TestGpuixRenderer(400, 300);
setRenderer(renderer as any);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pump = async () => { flush(); renderer.flush(); await sleep(30); };

const styles = () => {
	const out: any[] = [];
	const walk = (n: any) => { out.push(n); n.children?.forEach(walk); };
	walk(JSON.parse(renderer.getTreeJson()));
	return out;
};

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
	if (cond) { pass++; console.log(`✅ ${name}`); }
	else { fail++; console.log(`❌ ${name} ${extra}`); }
};

const root = doc.createElement('div');
doc.body.appendChild(root);
materializeRoot(root);

const mk = (tokens: string, parent: any) => {
	const el = doc.createElement('div');
	applyNativeStyle(el, resolveTokens(tokens));
	parent.appendChild(el);
	return el;
};

// dark default: bg-secondary → #27272a
mk('bg-secondary h-8 w-full', root);

// light-scoped subtree: same token must resolve differently
const themed = doc.createElement('div');
themed.setCustomProp('theme', { mode: 'light' });
root.appendChild(themed);
mk('bg-secondary h-8 w-full', themed);

// ctx color: color="danger" custom prop + text-color-readable (light danger #d2161c)
const ctxWrap = doc.createElement('div');
ctxWrap.setCustomProp('color', 'danger');
themed.appendChild(ctxWrap);
mk('text-color-readable h-8 w-full', ctxWrap);

// state-layer on a generic div: hover bg baked Rust-side (light hover = 5%)
mk('bg-primary text-primary-contrast state-layer h-8 w-full', themed);

await pump();

const bg = (el: any) => el?.style?.backgroundColor;
const all = styles();
check('dark bg-secondary → #27272a', bg(all[1]) === '#27272a', JSON.stringify(all[1]?.style));
check('light bg-secondary → #e4e4e7', bg(all[3]) === '#e4e4e7', JSON.stringify(all[3]?.style));
check('ctx color=danger under light → color #d2161c', all[5]?.style?.color === '#d2161c', JSON.stringify(all[5]?.style));
const hoverBg = all[6]?.style?.hover?.backgroundColor;
check('state-layer hover bg baked (light @5%)', typeof hoverBg === 'string' && hoverBg.length > 0, JSON.stringify(all[6]?.style));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
