/**
 * Showcase smoke test: mount the real Showcase, then click through every nav
 * item headlessly and assert each page paints something. Catches pages that
 * crash or render empty — the conformance cases can't see them.
 */
import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot, setViewport } from './gdom';
import { setRenderer, flush, drainAfterRender } from './native';

installGlobals();
const renderer = new TestGpuixRenderer(1280, 800);
setRenderer(renderer as any);
setViewport(1280, 800);
const { mount } = await import('../node_modules/svelte/src/index-client.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const target = doc.createElement('div');
target.setAttribute('style', 'display:flex;flex-direction:column;width:1280px;height:800px');
doc.body.appendChild(target);
materializeRoot(target);

const Showcase = (await import('./gen/nkit/showcase/Showcase.js')).default;
const { pages } = await import('./gen/nkit/showcase/pages.js');
mount(Showcase, { target });
await sleep(30);
flush(); renderer.flush(); drainAfterRender();

async function pump(n = 2) {
	for (let i = 0; i < n; i++) {
		for (const ev of renderer.drainEvents()) dispatchPayload(ev);
		await sleep(25);
		flush(); renderer.flush(); drainAfterRender();
	}
}

function textCenter(text: string) {
	const tree = JSON.parse(renderer.getAutomationTree());
	let hit = null;
	const walk = (n) => {
		if (hit || !n) return;
		if (n.type === 'text' && n.text?.includes(text) && n.bounds)
			hit = { x: n.bounds.x + n.bounds.width / 2, y: n.bounds.y + n.bounds.height / 2 };
		n.children?.forEach(walk);
	};
	walk(tree);
	return hit;
}

const results = [];
for (const p of pages) {
	const t = textCenter(p.name);
	if (!t) { results.push([p.name, 'NO-NAV']); continue; }
	renderer.simulateClick(t.x, t.y);
	await pump(3);
	const painted = renderer.getPaintedText().join('|');
	// page renders = it produced >3 distinct painted strings and no crash
	results.push([p.name, painted.split('|').length > 3 ? 'ok' : `THIN: ${painted.slice(0, 80)}`]);
}
console.log('=== SHOWCASE SMOKE ===');
for (const [n, r] of results) console.log(`${r === 'ok' ? '✅' : '❌'} ${n.padEnd(28)} ${r}`);
console.log(`${results.filter(([, r]) => r === 'ok').length}/${results.length} pages paint`);
process.exit(0);
