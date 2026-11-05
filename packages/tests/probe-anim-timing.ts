/**
 * Probe: the reversal-stall mechanisms.
 *
 * 1. `Animation.currentTime` must be LIVE while running — svelte's
 *    counterpart.t() reads it at interrupt time; a stored value is up to a
 *    frame stale, pinning the reversed transition behind the true position
 *    (rewind + hold). With no rAF pumped, a stored field never advances.
 * 2. `animate()` must flush the first-frame pin synchronously — riding the
 *    coalesced setTimeout(0) hop can push the pinned frame a whole tick
 *    late (several visibly frozen frames under load).
 */
import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, materializeRoot } from '@svelte-desktop/gpuix/gdom';
import { setRenderer } from '@svelte-desktop/gpuix/native';

installGlobals();
const inner = new TestGpuixRenderer(640, 400);
const appliedOps: string[][] = [];
const renderer = new Proxy(inner as any, {
	get(t, p) {
		if (p === 'applyBatch')
			return (json: string) => {
				try { appliedOps.push((JSON.parse(json) as unknown[][]).map((o) => String(o[0]))); } catch {}
				return t.applyBatch(json);
			};
		const v = t[p];
		return typeof v === 'function' ? v.bind(t) : v;
	},
});
setRenderer(renderer as any);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (ok: boolean, label: string) => {
	console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
	ok ? pass++ : fail++;
};

const target = doc.createElement('div');
doc.body.appendChild(target);
materializeRoot(target);
const el = doc.createElement('div');
el.textContent = 'x';
target.appendChild(el);
await sleep(0);

// ── live currentTime ────────────────────────────────────────────────
const anim = el.animate([{ opacity: '1' }, { opacity: '0' }], { duration: 1000, fill: 'forwards' });
await sleep(40); // real time passes, no rAF pumped — a stored field stays put
const ct = anim.currentTime;
console.log('  currentTime after 40ms idle:', ct);
check(ct > 10, `currentTime advances without a rAF step (got ${ct?.toFixed(1)}) — live clock, not a stored frame`);

// ── synchronous pin flush ────────────────────────────────────────────
appliedOps.length = 0;
el.animate([{ opacity: '0' }, { opacity: '1' }], { duration: 400, fill: 'forwards' });
// no sleep, no manual flush — the pin must already have reached applyBatch
const pinSent = appliedOps.some((batch) => batch.includes('setStyle'));
check(pinSent, 'first-frame pin reached applyBatch synchronously at animate() call');

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
