/**
 * Headless proof that the REAL app (app/src/routes) boots inside the kit
 * runtime on the native renderer — TestGpuixRenderer, no window needed.
 *
 * Covers: mount '/' (layout + page + async boundary remote query), client
 * nav to /about and back, command() mutation + query refresh, form() submit
 * dispatch. Logs painted text + automation-tree summary at each step.
 *
 * Run: bun test-app.ts   (compiles app/src → app/gen-app first)
 */
import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';

installGlobals();
const renderer = new TestGpuixRenderer(900, 900);
setRenderer(renderer as any);

await import('@svelte-desktop/svelte/build-app.ts'); // compile ../app/src → src/gen-app
const kit = await import('@svelte-desktop/svelte/gen/kit/index.js');
const { page } = kit;
const { startApp } = await import('./app-boot.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function pump(times = 8) {
	for (let i = 0; i < times; i++) {
		const evs = renderer.drainEvents();
		for (const ev of evs) dispatchPayload(ev);
		await sleep(30);
		flush();
		renderer.flush();
		drainAfterRender();
	}
	renderer.flush();
}
const painted = () => renderer.getPaintedText().join(' | ');
const treeText = () => renderer.getAutomationTree(); // <code> children live in the tree, not painted text
function clickText(text: string) {
	const tree = JSON.parse(renderer.getAutomationTree());
	let hit: { x: number; y: number } | null = null;
	const walk = (n: any) => {
		if (hit) return;
		if (n.type === 'text' && typeof n.text === 'string' && n.text.includes(text)) {
			hit = { x: n.bounds.x + n.bounds.width / 2, y: n.bounds.y + n.bounds.height / 2 };
			return;
		}
		n.children?.forEach(walk);
	};
	walk(tree);
	if (!hit) throw new Error(`clickText: no "${text}" in automation tree`);
	renderer.simulateClick(hit.x, hit.y);
}

const target = doc.createElement('div');
doc.body.appendChild(target);
materializeRoot(target);

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
	console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ' — ' + extra}`);
	if (!cond) failures++;
};

// ── boot ────────────────────────────────────────────────────────────────────
const router = await startApp(target, '/');
await pump();
console.log('[app] mounted — route:', page.route.id, '| url:', page.url.href, '| status:', page.status);
let p = painted();
console.log('[app] painted:', p.slice(0, 1200));
check('root route committed', page.route.id === '/' && page.status === 200, `route=${page.route.id} status=${page.status}`);
check('page chrome painted', p.includes('SvelteKit 3 + Bun, embedded'), p.slice(0, 200));
check('remote query() resolved in boundary', /\(pid \d+\)/.test(p) && treeText().includes('bun:sqlite') && treeText().includes('bun 1'), p.slice(0, 400));
check('remote state painted (counter + host)', /counter in[\s|]*:\s*\|\s*\d+/.test(p) && p.includes('native bridge:') && p.includes('absent'), p.slice(0, 400));

// ── client nav ──────────────────────────────────────────────────────────────
await kit.goto('/about');
await pump();
p = painted();
console.log('[app] /about painted:', p.slice(0, 400));
check('nav /about', page.route.id === '/about' && p.includes('about'), p.slice(0, 200));

await kit.goto('/');
await pump();
p = painted();
check('nav back /', page.route.id === '/' && p.includes('SvelteKit 3 + Bun'), p.slice(0, 200));

// ── remote command() → sqlite write + query refresh ─────────────────────────
const counter = () => {
	// painted shape: "counter in  | <code>bun:sqlite</code> | :  | N |"
	const m = /counter in[\s|]*:\s*\|\s*(\d+)/.exec(painted());
	return m ? Number(m[1]) : null;
};
const before = counter();
clickText('increment via command()');
await pump();
p = painted();
console.log('[app] after increment painted:', p.slice(0, 500));
check('command() incremented counter + refreshed query', counter() === (before ?? -1) + 1, `before=${before} after=${counter()}`);

// ── remote form() dispatch (empty input → fn returns {error}) ───────────────
try {
	clickText('add via form()');
	await pump();
	check('form() submit dispatched without throw', true);
} catch (e) {
	check('form() submit dispatched without throw', false, String(e).split('\n')[0]);
}

// ── native dialog command (no host bridge in-process → graceful fallback) ───
try {
	clickText('native dialog via command()');
	await pump();
	check('openNativeDialog graceful without __nativeBridge', true);
} catch (e) {
	check('openNativeDialog graceful without __nativeBridge', false, String(e).split('\n')[0]);
}

console.log('\n[app] automation tree (truncated):');
console.log(renderer.getAutomationTree().slice(0, 1500));
console.log(`\n${failures === 0 ? 'ALL CHECKS PASS' : failures + ' FAILURES'} — app boot path proven`);
process.exit(failures ? 1 : 0);
