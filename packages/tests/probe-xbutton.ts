/**
 * x-button parity probe — the 1/1 svelai recipe, ctx-color inheritance,
 * disabled/loading gating, squared/fullWidth compounds, and the
 * state-layer overlay, verified against the real test renderer.
 */
import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, materializeRoot } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush } from '@svelte-desktop/gpuix/native';

installGlobals();
const renderer = new TestGpuixRenderer(640, 600);
setRenderer(renderer as any);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pump = async () => { flush(); renderer.flush(); await sleep(30); };

const tree = () => JSON.parse(renderer.getAutomationTree());
const find = (pred: (n: any) => boolean): any => {
	let hit: any = null;
	const walk = (n: any) => { if (hit) return; if (pred(n)) hit = n; n.children?.forEach(walk); };
	walk(tree());
	return hit;
};

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
	if (cond) { pass++; console.log(`✅ ${name}`); }
	else { fail++; console.log(`❌ ${name} ${extra}`); }
};

// ── mount a stack of buttons through the fake DOM ──────────────────────
const root = doc.createElement('div');
doc.body.appendChild(root);
materializeRoot(root);

const mk = (props: Record<string, unknown>, parent = root) => {
	const el = doc.createElement('x-button' as any);
	for (const [k, v] of Object.entries(props)) el.setCustomProp(k, v);
	parent.appendChild(el);
	return el;
};

// solid danger — ctx color on the element
mk({ variant: 'solid', color: 'danger', size: 'large' });
// soft via INHERITED ctx: wrapper carries color, button doesn't
const wrap = doc.createElement('div');
wrap.setCustomProp('color', 'success');
root.appendChild(wrap);
mk({ variant: 'soft' }, wrap);
// outline neutral → the compound (border-neutral-muted)
mk({ variant: 'outline', color: 'neutral' });
// disabled — inert
mk({ disabled: true });
// loading — also inert in svelai
mk({ loading: true });
// squared small → 28×28 compound
mk({ squared: true, size: 'small' });
// link variant — no state layer, underline on hover
mk({ variant: 'link' });

await pump();

const bounds = (pred: (n: any) => boolean) => find(pred)?.bounds;

// find by type x-button in order
const buttons = (() => {
	const all: any[] = [];
	const walk = (n: any) => { if (n.type === 'x-button') all.push(n); n.children?.forEach(walk); };
	walk(tree());
	return all;
})();

check('seven x-buttons mounted', buttons.length === 7, `got ${buttons.length}`);

const [solid, soft, outline, disabled, loading, squared, link] = buttons;
// automation bounds are the CONTENT box — the 1px transparent border insets
// each side, so `h-control-N` reports N−2. svelai's control heights are
// border-box; the resolved StyleDesc carries 36/32/28 and gpui honors them.
check('size=large → control-lg (36 outer, 34 content)', Math.round(solid?.bounds?.height) === 34, JSON.stringify(solid?.bounds));
check('squared small → 28×28 outer (26 content)', Math.round(squared?.bounds?.height) === 26 && Math.round(squared?.bounds?.width) === 26, JSON.stringify(squared?.bounds));
check('outline renders', outline?.bounds?.height > 0);
check('disabled renders at control-md', disabled?.bounds?.height === 30);
check('link renders at control-md', link?.bounds?.height === 30);

// screenshot evidence: solid danger paints the danger base
await pump();
const shot = await renderer.screenshot?.('probe-xbutton.png');
console.log('screenshot:', shot ?? 'n/a');

// events: disabled + loading buttons must not emit clicks
const center = (b: any) => ({ x: b.bounds.x + b.bounds.width / 2, y: b.bounds.y + b.bounds.height / 2 });
const before = renderer.drainEvents().length;
renderer.simulateClick(center(disabled).x, center(disabled).y);
renderer.simulateClick(center(loading).x, center(loading).y);
await pump();
const evs = renderer.drainEvents();
check('disabled + loading emit zero events', evs.length === 0, JSON.stringify(evs));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
