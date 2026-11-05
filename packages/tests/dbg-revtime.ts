import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';
installGlobals();
const renderer = new TestGpuixRenderer(640, 600);
setRenderer(renderer as any);
const { mount } = await import('@svelte-desktop/svelte/svelte-client.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// instrument animate + step timing via performance marks
const marks: { name: string; t: number }[] = [];
const mark = (name: string) => marks.push({ name, t: performance.now() });

// wrap requestAnimationFrame to log registration + fire times
const origRaf = (globalThis as any).requestAnimationFrame;
let rafDepth = 0;
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
	const label = `raf#${++rafDepth}`;
	return origRaf((t: number) => { mark(`${label} fired`); return cb(t); });
};

async function pumpOnce() {
	for (const ev of renderer.drainEvents()) dispatchPayload(ev);
	await sleep(0); flush(); renderer.flush(); drainAfterRender();
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
	renderer.simulateClick(hit.bounds.x + 5, hit.bounds.y + 5);
}

const target = doc.createElement('div');
doc.body.appendChild(target);
materializeRoot(target);
const { default: App } = await import('./gen/cases/reversetrans.js');
mount(App, { target });
await sleep(60); await pumpOnce();

// opacity probe
const opacityOf = () => {
	let found: any = null;
	const walk = (n: any) => {
		if (found) return;
		if (n.nodeType === 3 && n.textContent === 'fader') found = n.parentElement;
		for (const c of n.childNodes ?? []) walk(c);
	};
	walk(doc.documentElement);
	return found ? parseFloat(((globalThis as any).getComputedStyle(found) as any).opacity) : null;
};

mark('CLICK-OUT');
clickText('toggle');
// drive at ~16ms cadence, interrupt mid-outro
const t0 = performance.now();
let interrupted = false;
for (let i = 0; i < 60; i++) {
	await sleep(16);
	await pumpOnce();
	const o = opacityOf();
	mark(`frame${i} o=${o?.toFixed(2)}`);
	if (!interrupted && o !== null && o < 0.5) {
		interrupted = true;
		mark('CLICK-IN');
		clickText('toggle');
	}
}
// print timeline with deltas
let prev = marks[0].t;
for (const m of marks) {
	const d = (m.t - prev).toFixed(1);
	console.log(`+${d.padStart(6)}ms  ${m.name}`);
	prev = m.t;
}
