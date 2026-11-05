/**
 * Probe: slide on a class-styled flex chip (the app card's real shape).
 * Regression: getComputedStyle only saw inline props, so a class-driven
 * `padding` fed paddingTop ''→NaN → svelte dropped the padding keyframes
 * and the outro stalled at the 16px padding residual.
 */
import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';

installGlobals();
const renderer = new TestGpuixRenderer(640, 600);
setRenderer(renderer as any);
const { mount } = await import('@svelte-desktop/svelte/svelte-client.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pumpOnce() {
	for (const ev of renderer.drainEvents()) dispatchPayload(ev);
	await sleep(0);
	flush();
	renderer.flush();
	drainAfterRender();
}
function boundsOf(text: string) {
	const tree = JSON.parse(renderer.getAutomationTree());
	let b: any = null;
	const walk = (n: any, p: any) => {
		if (b) return;
		if (n.type === 'text' && n.text === text && p) b = p.bounds;
		n.children?.forEach((c: any) => walk(c, n));
	};
	walk(tree, null);
	return b;
}
function clickText(text: string) {
	const tree = JSON.parse(renderer.getAutomationTree());
	let hit: any = null;
	const walk = (n: any) => {
		if (hit) return;
		if (n.type === 'text' && typeof n.text === 'string' && n.text.includes(text)) hit = n;
		n.children?.forEach(walk);
	};
	walk(tree);
	if (!hit) throw new Error(`no "${text}"`);
	renderer.simulateClick(hit.bounds.x + 5, hit.bounds.y + 5);
}

const target = doc.createElement('div');
doc.body.appendChild(target);
materializeRoot(target);
const { default: App } = await import('./gen/cases/flexslide.js');
mount(App, { target });
await sleep(60);
await pumpOnce();

let pass = 0, fail = 0;
const check = (ok: boolean, label: string) => {
	console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
	ok ? pass++ : fail++;
};

const open = boundsOf('slide');
check(open && open.height > 30, `class chip mounted at full height (got ${open?.height})`);

clickText('toggle');
const hs: number[] = [];
const t0 = Date.now();
while (Date.now() - t0 < 400) {
	await pumpOnce();
	const b = boundsOf('slide');
	if (b) hs.push(b.height);
	await sleep(8);
}
console.log('  outro heights:', hs.map((h) => h.toFixed(1)).join(' → '));
const min = Math.min(...hs);
check(min <= 1, `class chip collapsed to ~0 (got ${min.toFixed(1)} — 16 = dropped padding keyframes)`);
check(hs.filter((h) => h > 2 && h < 33).length >= 3, 'outro passed through intermediate heights');
check(boundsOf('slide') == null, 'chip unmounted after outro');

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
