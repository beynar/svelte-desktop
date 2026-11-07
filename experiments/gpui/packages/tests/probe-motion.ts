/**
 * Probe: the animations-showcase mechanics — custom css(t) rotate transition,
 * crossfade send/receive, animate:flip, imperative animate() with
 * iterations/alternate, and blur's opacity-only fallback.
 */
import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';

installGlobals();
const renderer = new TestGpuixRenderer(800, 900);
setRenderer(renderer as any);
const { mount } = await import('@svelte-desktop/svelte/svelte-client.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function clsEls(cls: string) {
	const hits: any[] = [];
	const walk = (n: any) => {
		if (n.nodeType === 1 && (n.className ?? '').includes(cls)) hits.push(n);
		for (const c of n.childNodes ?? []) walk(c);
	};
	walk(doc.documentElement);
	return hits;
}
const el = (cls: string) => clsEls(cls)[0] ?? null;

async function clickText(text: string) {
	// The automation tree is a point-in-time snapshot of the last painted
	// scene — a read can race an in-flight applyBatch and catch a transient
	// mid-mutation frame. Retry briefly before declaring the target absent.
	for (let attempt = 0; attempt < 8; attempt++) {
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
		if (hit) {
			renderer.simulateClick(hit.x, hit.y);
			return;
		}
		await sleep(15);
	}
	throw new Error(`no "${text}"`);
}

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
const { default: Motion } = await import('./gen/cases/motion.js');
mount(Motion, { target });
await sleep(60);
await pumpOnce();
await pump(120);

let pass = 0, fail = 0;
const check = (ok: boolean, label: string) => {
	console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
	ok ? pass++ : fail++;
};

// ── spinIn custom transition: rotate+scale mid-flight on re-intro ───────────
await clickText('spintoggle');
await pump(400);
check(!el('spinbox'), 'spinbox unmounted');
await clickText('spintoggle');
await pumpOnce();
let sawRotate = false;
for (let i = 0; i < 10; i++) {
	const cs = el('spinbox') && getComputedStyle(el('spinbox'));
	if (cs && /rotate/.test(cs.transform ?? '')) sawRotate = true;
	await pump(30);
}
check(sawRotate, 'spinIn: getComputedStyle exposes rotate() mid-flight');
await pump(600);
check(!!el('spinbox'), 'spinbox present after intro');

// ── blur: opacity animates, no crash on filter emission ────────────────────
await clickText('blurtoggle');
await pump(80);
const blurGone = !el('blurbox');
const blurDimming = (() => {
	const cs = el('blurbox') && getComputedStyle(el('blurbox'));
	return cs && parseFloat(cs.opacity ?? '1') < 0.95;
})();
check(blurGone || blurDimming, 'blur: opacity animates or element outro-ing');
await pump(400);
check(!el('blurbox'), 'blurbox unmounted after out:blur');
await clickText('blurtoggle');
await pump(400);
check(!!el('blurbox'), 'blurbox remounted');

// ── crossfade: hop a token left→right, lands in lane-r ──────────────────────
await clickText('L1');
await pump(500);
check(!!el('token'), 'tokens present after hop');
const r = boundsOf('R1');
console.log('  R1 bounds:', JSON.stringify(r));
check(!!r, 'token R1 materialized in right lane');

// ── animate:flip — reverse order, tokens glide (transform mid-flight) ───────
const f1Before = boundsOf('F1');
await clickText('fliptoggle');
await pumpOnce();
let sawFlipTransform = false;
for (let i = 0; i < 10; i++) {
	const cs = el('fliptok') && getComputedStyle(el('fliptok'));
	// numeric translate required — translate(NaNpx,…) means flip's rect
	// deltas (getComputedStyle transformOrigin/zoom/clientWidth) went NaN
	if (cs && /translate\(-?[\d.]+px/.test(cs.transform ?? '')) sawFlipTransform = true;
	await pump(30);
}
const f1After = boundsOf('F5');
console.log('  F1 before:', JSON.stringify(f1Before), 'F5 tail:', JSON.stringify(f1After));
check(sawFlipTransform, 'flip: transform translate mid-reorder');
check(!!f1After, 'reorder completed');

// ── imperative: burst runs without error ────────────────────────────────────
await clickText('burst');
await pump(100);
let sawBurst = false;
for (let i = 0; i < 8; i++) {
	const cs = el('burstbox') && getComputedStyle(el('burstbox'));
	if (cs && /scale/.test(cs.transform ?? '')) sawBurst = true;
	await pump(30);
}
check(sawBurst, 'imperative burst: scale keyframes ran');

// ── imperative: infinite alternate pulse, then cancel ───────────────────────
await clickText('pulse');
await pump(50);
let sawPulse = false;
for (let i = 0; i < 10; i++) {
	const cs = el('pulsebox') && getComputedStyle(el('pulsebox'));
	if (cs && /scale\(1\.[0-9]/.test(cs.transform ?? '') || /scale\(0\.[0-9]/.test(cs.transform ?? '')) sawPulse = true;
	await pump(40);
}
check(sawPulse, 'imperative pulse: iterating scale transform');
await clickText('pulse');
await pump(100);
const pulseRest = el('pulsebox') && getComputedStyle(el('pulsebox'));
check(
	!/scale/.test(pulseRest?.transform ?? ''),
	`pulse cancelled — transform cleared (got ${pulseRest?.transform})`,
);

// ── imperative: marquee — unitless 0 vs -160px must interpolate, not snap ──
await clickText('marquee');
await pump(60);
const marqSamples: number[] = [];
for (let i = 0; i < 12; i++) {
	const cs = el('marqbox') && getComputedStyle(el('marqbox'));
	const m = /translateX\((-?\d+(?:\.\d+)?)px\)/.exec(cs?.transform ?? '');
	if (m) marqSamples.push(parseFloat(m[1]));
	await pump(45);
}
const marqMid = marqSamples.filter((x) => x < -2 && x > -158);
check(
	marqMid.length >= 2,
	`marquee: translateX interpolates through px values (got ${marqSamples.slice(0, 6).join(', ')})`,
);
await clickText('marquee');
await pump(60);
const marqRest = el('marqbox') && getComputedStyle(el('marqbox'));
check(!/translateX/.test(marqRest?.transform ?? ''), `marquee cancelled — transform cleared (got ${marqRest?.transform})`);

// ── imperative: chained .finished — second stage must run and settle ────────
await clickText('chain');
await pump(340);
const chainDone = (() => {
	const tree = JSON.parse(renderer.getAutomationTree());
	let found = false;
	const walk = (n: any) => {
		if (n.type === 'text' && typeof n.text === 'string' && n.text.includes('done')) found = true;
		n.children?.forEach(walk);
	};
	walk(tree);
	return found;
})();
check(chainDone, 'chain: .finished sequencing reached done state');

// ── declared CSS animation: @keyframes + animation: runs on mount ───────────
let sawCssAnim = false;
for (let i = 0; i < 10; i++) {
	const cs = el('cssanimbox') && getComputedStyle(el('cssanimbox'));
	const m = /rotate\((-?\d+(?:\.\d+)?)deg\)/.exec(cs?.transform ?? '');
	if (m && Math.abs(parseFloat(m[1])) > 1) sawCssAnim = true;
	await pump(40);
}
check(sawCssAnim, 'declared css animation: rotate() mid-flight');

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
