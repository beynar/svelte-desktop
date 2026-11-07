/**
 * Probe: WAAPI mechanics + computed-style single-sourcing.
 * Regression coverage for the adversarial-review findings:
 *  - playState 'running' at birth (svelte's tick: transitions gate on it)
 *  - currentTime is a real seek (running: rebases the clock; paused: repaints now)
 *  - the pin honors direction:'reverse' and negative delay (not blind frames[0])
 *  - detached iterations:Infinity animations die in dematerialize
 *  - @keyframes content is in the css-anim sig (HMR keyframe edits restart)
 *  - flush() re-arms the retry macrotask after a failed batch
 *  - getComputedStyle reads the Rust-resolved cascade (cross-sheet shorthand wins)
 */
import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';
import { registerSheet, unregisterSheet } from '@svelte-desktop/gpuix/native-css/register';

installGlobals();
const renderer = new TestGpuixRenderer(640, 600);
setRenderer(renderer as any);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pumpOnce() {
	for (const ev of renderer.drainEvents()) dispatchPayload(ev);
	await sleep(0);
	flush();
	renderer.flush();
	drainAfterRender();
}

const target = doc.createElement('div');
doc.body.appendChild(target);
materializeRoot(target);
await sleep(30);
await pumpOnce();

let pass = 0,
	fail = 0;
const check = (ok: boolean, label: string) => {
	console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
	ok ? pass++ : fail++;
};
const num = (v: unknown) => parseFloat(String(v));

// ── playState + pin pose ────────────────────────────────────────────
const a = doc.createElement('div');
target.appendChild(a);
await pumpOnce();

const fwd = a.animate([{ opacity: '0' }, { opacity: '1' }], { duration: 1000, easing: 'linear' });
check(fwd.playState === 'running', `playState is 'running' at birth (got ${fwd.playState})`);
check(num(getComputedStyle(a).opacity) < 0.1, `pin applies frames[0] for normal direction (got ${getComputedStyle(a).opacity})`);
fwd.cancel();

const rev = a.animate([{ opacity: '0' }, { opacity: '1' }], { duration: 1000, easing: 'linear', direction: 'reverse' });
check(num(getComputedStyle(a).opacity) > 0.9, `pin applies the LAST frame for direction:reverse (got ${getComputedStyle(a).opacity})`);
rev.cancel();

const neg = a.animate([{ opacity: '0' }, { opacity: '1' }], { duration: 1000, delay: -500, easing: 'linear' });
const nv = num(getComputedStyle(a).opacity);
check(nv > 0.4 && nv < 0.6, `negative-delay pin lands mid-curve (got ${nv}, want ~0.5)`);
neg.cancel();

// ── currentTime is a real seek ──────────────────────────────────────
const sk = a.animate([{ opacity: '0' }, { opacity: '1' }], { duration: 1000, easing: 'linear' });
sk.currentTime = 500; // running seek — rebases the clock
await pumpOnce();
const sv = num(getComputedStyle(a).opacity);
check(sv > 0.4 && sv < 0.6, `running seek lands on the new time (opacity ${sv}, want ~0.5)`);

sk.pause();
sk.currentTime = 250; // paused seek — repaints the held frame synchronously
const pv = num(getComputedStyle(a).opacity);
check(pv > 0.2 && pv < 0.3, `paused seek repaints immediately (opacity ${pv}, want 0.25)`);

sk.play(); // resumes from the held time, not from 0
await pumpOnce();
const rv = num(getComputedStyle(a).opacity);
check(rv >= 0.24 && rv < 0.45, `resume continues from the held time (opacity ${rv})`);
sk.cancel();

// ── detached infinite animations die ────────────────────────────────
const inf = doc.createElement('div');
target.appendChild(inf);
const ia = inf.animate([{ opacity: '0' }, { opacity: '1' }], { duration: 1000, iterations: Infinity });
await pumpOnce();
check(ia.playState === 'running' && inf.getAnimations().length === 1, 'infinite anim tracked as live');
target.removeChild(inf); // dematerialize
check(ia.playState === 'idle' && inf.getAnimations().length === 0, 'detached infinite anim cancelled in dematerialize');
await pumpOnce();
await pumpOnce();
check(inf.getAnimations().length === 0 && ia.playState === 'idle', 'no resurrection after detach');

// ── @keyframes content is part of the anim signature ────────────────
const box = doc.createElement('div');
box.className = 'spinbox';
target.appendChild(box);
const kfRule = {
	classes: ['spinbox'],
	spec: { name: 'pspin', duration: 1000, delay: 0, iterations: 'infinite', direction: 'normal', easing: 'linear', fill: 'none' },
	spec3: [0, 1, 0] as [number, number, number],
	order: 0,
};
const kfUp = [{ offset: 0, props: { opacity: '0' } }, { offset: 1, props: { opacity: '1' } }];
const kfDown = [{ offset: 0, props: { opacity: '1' } }, { offset: 1, props: { opacity: '0' } }];
registerSheet('probe-kf', [], [{ name: 'pspin', frames: kfUp }], [kfRule]);
const first = (box as any)._cssAnim;
check(!!first, 'css animation reconciles onto the matching element');
registerSheet('probe-kf', [], [{ name: 'pspin', frames: kfDown }], [kfRule]);
check((box as any)._cssAnim !== first && box.getAnimations().length === 1, 'keyframe-body edit restarts the running anim');
const second = (box as any)._cssAnim;
registerSheet('probe-kf', [], [{ name: 'pspin', frames: kfDown }], [kfRule]);
check((box as any)._cssAnim === second, 'identical re-register keeps the anim (no spurious restart)');
unregisterSheet('probe-kf');
check((box as any)._cssAnim === null && (box as any)._cssAnimSig === '', 'unregisterSheet cancels the css anim');

// ── flush() re-arms the retry after a failed batch ──────────────────
const proto = Object.getPrototypeOf(renderer);
const origBatch = proto.applyBatch;
let batchCalls = 0;
let failOnce = true;
proto.applyBatch = function (s: string) {
	batchCalls++;
	if (failOnce) {
		failOnce = false;
		throw new Error('boom');
	}
	return origBatch.call(this, s);
};
const h = doc.createElement('div');
target.appendChild(h);
h.style.setProperty('opacity', '0.5');
await sleep(10);
await pumpOnce();
proto.applyBatch = origBatch;
check(batchCalls >= 2, `failed batch retried without waiting for another emit (applyBatch calls: ${batchCalls})`);
check(num(getComputedStyle(h).opacity) === 0.5, 'retried batch delivered the style');

// ── computedStyle reads the Rust cascade (cross-sheet shorthand) ────
registerSheet('probe-s1', [{ sel: [{ k: 'class', v: 'pa' }], decls: 'padding-top:4px', spec: [0, 1, 0], order: 0 }]);
registerSheet('probe-s2', [{ sel: [{ k: 'class', v: 'pb' }], decls: 'padding:8px', spec: [0, 1, 0], order: 0 }]);
const pad = doc.createElement('div');
pad.className = 'pa pb';
target.appendChild(pad);
await pumpOnce();
const ptop = getComputedStyle(pad).paddingTop;
check(ptop === '8px', `later sheet's shorthand wins the cross-sheet cascade (got '${ptop}', mirror said '4px')`);
unregisterSheet('probe-s1');
unregisterSheet('probe-s2');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
