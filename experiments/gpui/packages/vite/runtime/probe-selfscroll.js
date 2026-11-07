/**
 * Repro: /animations page visually bounces with zero input.
 * Scroll offset is flat — so it's layout oscillation. Poll every
 * element's painted bounds; report which ids change SIZE or Y over time.
 *
 * Run: cd app && bun ../packages/vite/runtime/probe-selfscroll.js
 */
import { execSync } from 'node:child_process';
process.env.SVELTE_NATIVE_ROOT ??= '/Users/arnaud/code/svelte-desktop/app';
process.env.SVELTE_NATIVE_DEVJSON ??= '/Users/arnaud/code/svelte-desktop/app/.svelte-native/dev.json';
await import('./host.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const host = (globalThis.__svelteNativeHost ??= {});

for (let i = 0; i < 400 && !(host.renderer && host.router); i++) await sleep(25);
if (!host.renderer) { console.error('no renderer'); process.exit(1); }
const renderer = host.renderer;
await sleep(800);
try { execSync(`swift /tmp/axraise.swift ${process.pid}`); } catch {}

await host.router.goto('/animations');
await sleep(parseInt(process.env.SETTLE_MS ?? '2500'));

// collect native ids + tag/cls for every gdom element
const all = [];
const walk = (el) => {
	if (!el || el.nodeType !== 1) return;
	const id = el.nativeId ?? el._nativeId;
	if (id != null) all.push({ id, tag: el.tagName, cls: String(el.className ?? '') });
	for (const c of el.childNodes ?? []) walk(c);
};
walk(globalThis.document?.documentElement);
console.log(`elements: ${all.length}`);

// poll bounds ~33ms for ~7s
const hist = new Map(); // id -> [{w,h,y}]
const T = 200;
for (let i = 0; i < T; i++) {
	for (const { id } of all) {
		const b = renderer.getElementBounds(id);
		if (!b) continue;
		let h = hist.get(id);
		if (!h) hist.set(id, (h = []));
		h.push({ w: b.width, h: b.height, y: b.y });
	}
	await sleep(33);
}

const sizeOsc = [], posOsc = [];
for (const { id, tag, cls } of all) {
	const h = hist.get(id);
	if (!h || h.length < 30) continue;
	const ws = h.map((b) => b.w), hs = h.map((b) => b.h), ys = h.map((b) => b.y);
	const rng = (a) => Math.max(...a) - Math.min(...a);
	const dW = rng(ws), dH = rng(hs), dY = rng(ys);
	// oscillation = returns to a prior value, not a drift: count direction reversals
	const reversals = (a) => {
		let r = 0;
		for (let i = 2; i < a.length; i++)
			if ((a[i] - a[i - 1]) * (a[i - 1] - a[i - 2]) < 0) r++;
		return r;
	};
	const label = `${tag}.${String(cls).split(' ')[0]}#${id}`;
	if (dW > 1 || dH > 1) sizeOsc.push({ label, dW: +dW.toFixed(1), dH: +dH.toFixed(1), revH: reversals(hs), revW: reversals(ws) });
	else if (dY > 1 && reversals(ys) > 10) posOsc.push({ label, dY: +dY.toFixed(1), revY: reversals(ys) });
}
// ancestors of the biggest movers — which level drives it
for (const id of [2, 10, 32, 33, 71, 72, 78, 11, 12, 13, 16, 19]) {
	const h = hist.get(id);
	if (!h || !h.length) { console.log(`#${id}: no data`); continue; }
	const ws = h.map((b) => b.w), hs = h.map((b) => b.h), ys = h.map((b) => b.y);
	const rng = (a) => (Math.max(...a) - Math.min(...a)).toFixed(1);
	console.log(`#${id}: dW=${rng(ws)} dH=${rng(hs)} dY=${rng(ys)}  hs[0..8]=${hs.slice(0, 8).map((v) => v.toFixed(0)).join(',')}`);
}
console.log('\n== size oscillators ==');
for (const s of sizeOsc.slice(0, 40)) console.log(` ${s.label} dW=${s.dW} dH=${s.dH} revW=${s.revW} revH=${s.revH}`);
console.log('\n== y oscillators (reversals>10) ==');
for (const s of posOsc.slice(0, 40)) console.log(` ${s.label} dY=${s.dY} revY=${s.revY}`);
process.exit(0);
