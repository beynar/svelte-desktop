/**
 * Probe: transform-emitting transitions (fly, scale) must move painted bounds
 * through the native transform pipeline — mid-flight bounds differ from rest
 * bounds and converge exactly, with no style residue afterwards.
 */
import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';

installGlobals();
const renderer = new TestGpuixRenderer(640, 600);
setRenderer(renderer as any);
const { mount } = await import('@svelte-desktop/svelte/svelte-client.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function boxEls(cls: string) {
	const hits: any[] = [];
	const walk = (n: any) => {
		if (n.nodeType === 1 && (n.className ?? '').includes(cls)) hits.push(n);
		for (const c of n.childNodes ?? []) walk(c);
	};
	walk(doc.documentElement);
	return hits;
}

// text node → parent (span) → grandparent (the styled box)
function boundsOf(text: string) {
	const tree = JSON.parse(renderer.getAutomationTree());
	let b: { x: number; y: number; width: number; height: number } | null = null;
	const walk = (n: any, parent: any, grandparent: any) => {
		if (b) return;
		if (n.type === 'text' && n.text === text && grandparent) b = grandparent.bounds;
		n.children?.forEach((c: any) => walk(c, n, parent));
	};
	walk(tree, null, null);
	return b;
}

function clickText(text: string) {
	const tree = JSON.parse(renderer.getAutomationTree());
	let hit: { x: number; y: number } | null = null;
	const walk = (n: any) => {
		if (hit) return;
		if (n.type === 'text' && typeof n.text === 'string' && n.text.includes(text)) {
			hit = { x: n.bounds.x + n.bounds.width / 2, y: n.bounds.y + n.bounds.height / 2 };
		}
		n.children?.forEach(walk);
	};
	walk(tree);
	if (!hit) throw new Error(`no "${text}"`);
	renderer.simulateClick(hit.x, hit.y);
}

async function pumpOnce() {
	for (const ev of renderer.drainEvents()) dispatchPayload(ev);
	// A compositor paints only after the task's microtasks drain — svelte's
	// transition setup (measure + first-keyframe pin) lives there.
	await sleep(0);
	flush();
	renderer.flush();
	drainAfterRender();
}
const pump = async (ms: number) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		await pumpOnce();
		await sleep(8);
	}
};

const target = doc.createElement('div');
doc.body.appendChild(target);
materializeRoot(target);
const { default: Fly } = await import('./gen/cases/fly.js');
mount(Fly, { target });
await sleep(60);
await pumpOnce();
await pump(100);

let pass = 0, fail = 0;
const check = (ok: boolean, label: string) => {
	console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
	ok ? pass++ : fail++;
};

const flyEl = () => boxEls('flybox')[0] ?? null;
const scaleEl = () => boxEls('scalebox')[0] ?? null;

// ── fly: cycle off/on, then sample the re-intro (y:-60 slides down to top:60)
clickText('flytoggle');
await pump(300);
check(!flyEl(), 'flybox unmounted after out:fly');
clickText('flytoggle');
await pumpOnce();

let sawFlyDisplacement = false;
let sawFlyComputed = false;
for (let i = 0; i < 12; i++) {
	const b = boundsOf('flyme');
	if (b && b.y < 55) sawFlyDisplacement = true;
	const el = flyEl();
	const cs = el && getComputedStyle(el);
	if (cs && /translate/.test(cs.transform ?? '')) sawFlyComputed = true;
	await pump(15);
}
check(sawFlyDisplacement, 'fly: painted bounds displaced upward during intro');
check(sawFlyComputed, 'fly: getComputedStyle exposes transform mid-flight');

await pump(300);
const flyRest = boundsOf('flyme');
console.log('  fly rest bounds:', JSON.stringify(flyRest));
check(!!flyRest && Math.abs(flyRest.y - 60) < 1.5, `fly rest y≈60 (got ${flyRest?.y})`);
check(!!flyRest && Math.abs(flyRest.x - 20) < 1.5, `fly rest x≈20 (got ${flyRest?.x})`);
check(
	!!flyRest && Math.abs(flyRest.width - 100) < 1.5 && Math.abs(flyRest.height - 40) < 1.5,
	`fly rest size 100×40 (got ${flyRest?.width}×${flyRest?.height})`,
);
check(
	flyEl()?.style.props.get('transform') === undefined,
	'fly: no transform residue on author layer after intro',
);

// ── scale: cycle off/on, then sample the re-intro (start:0 grows to 80px) ────
clickText('scaletoggle');
await pump(300);
check(!scaleEl(), 'scalebox unmounted after out:scale');
clickText('scaletoggle');
await pumpOnce();

let sawShrink = false;
let sawScaleComputed = false;
for (let i = 0; i < 12; i++) {
	const b = boundsOf('scaleme');
	if (b && b.width < 76) sawShrink = true;
	const el = scaleEl();
	const cs = el && getComputedStyle(el);
	if (cs && /scale/.test(cs.transform ?? '')) sawScaleComputed = true;
	await pump(15);
}
check(sawShrink, 'scale: painted bounds shrunk below rest during intro');
check(sawScaleComputed, 'scale: getComputedStyle exposes scale() mid-flight');

await pump(300);
const scaleRest = boundsOf('scaleme');
console.log('  scale rest bounds:', JSON.stringify(scaleRest));
check(
	!!scaleRest && Math.abs(scaleRest.width - 80) < 1.5 && Math.abs(scaleRest.height - 80) < 1.5,
	`scale rest 80×80 (got ${scaleRest?.width}×${scaleRest?.height})`,
);
check(
	!!scaleRest && Math.abs(scaleRest.x - 200) < 1.5 && Math.abs(scaleRest.y - 200) < 1.5,
	`scale rest position 200,200 (got ${scaleRest?.x},${scaleRest?.y})`,
);
check(
	scaleEl()?.style.props.get('transform') === undefined,
	'scale: no transform residue on author layer after intro',
);

// ── remount sanity after all the churn ──────────────────────────────────────
clickText('flytoggle');
await pump(300);
check(!flyEl(), 'flybox unmounted on final close');
clickText('flytoggle');
await pump(300);
check(!!flyEl() && (boundsOf('flyme')?.width ?? 0) > 90, 'flybox clean on remount');

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
