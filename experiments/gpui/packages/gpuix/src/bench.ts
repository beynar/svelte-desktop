/**
 * Benchmark suite for the fake-DOM → native pipeline.
 * `bun src/bench.ts`        — run, compare vs bench/baseline.json
 * `SAVE=1 bun src/bench.ts` — run, overwrite the baseline
 */
import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, materializeRoot, setViewport, dispatchPayload } from './gdom';
import { setRenderer, flush, drainAfterRender } from './native';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

installGlobals();
const renderer = new TestGpuixRenderer(1180, 800);
setRenderer(renderer as any);
setViewport(1180, 780);

// op-volume accounting — count what actually crosses the boundary
let runOps = 0;
const origBatch = renderer.applyBatch.bind(renderer);
(renderer as any).applyBatch = (b: string) => {
	runOps += JSON.parse(b).length;
	return origBatch(b);
};

const { default: themeCss } = await import('./gen/theme-css.js');
const { mount, unmount } = await import('../node_modules/svelte/src/index-client.js');
const { default: BenchList } = await import('./gen/cases/BenchList.js');

function pump() {
	for (const ev of renderer.drainEvents()) dispatchPayload(ev);
	flush();
	renderer.flush();
	drainAfterRender();
}

interface Row { ms: number; min: number; ops?: number }
const results = new Map<string, Row>();

async function bench(name: string, runs: number, fn: () => void | Promise<void>, ops = false) {
	await fn(); // warmup (unmeasured)
	const times: number[] = [];
	let opsTotal = 0;
	for (let i = 0; i < runs; i++) {
		runOps = 0;
		const t0 = performance.now();
		await fn();
		times.push(performance.now() - t0);
		opsTotal += runOps;
	}
	const min = Math.min(...times);
	const ms = times.reduce((a, b) => a + b, 0) / times.length;
	results.set(name, { ms, min, ...(ops ? { ops: Math.round(opsTotal / runs) } : {}) });
}

/** Fresh mounted container under body. */
function freshRoot() {
	const el = doc.createElement('div');
	el.setAttribute('style', 'width:1180px;height:780px');
	doc.body.appendChild(el);
	materializeRoot(el as any);
	return el as any;
}

// ── Phase 0: theme parse (single measurement — rules accumulate) ────────────
{
	const t0 = performance.now();
	const st = doc.createElement('style');
	st.textContent = themeCss;
	doc.head.appendChild(st);
	results.set('parse:theme-260k', { ms: performance.now() - t0, min: 0 });
}

// everything below runs WITH the full 1821-rule theme table loaded
doc.documentElement.classList.add('dark');

// ── DOM layer ────────────────────────────────────────────────────────────────

const ROW_CLASS = 'cn-sidebar-menu-button peer/menu-button flex w-full items-center overflow-hidden outline-hidden cn-sidebar-menu-button-variant-default cn-sidebar-menu-button-size-lg';

await bench('dom:mount-500', 3, () => {
	const root = freshRoot();
	for (let i = 0; i < 500; i++) {
		const d = doc.createElement('div');
		d.className = ROW_CLASS;
		const s = doc.createElement('span');
		s.className = 'bench-cell';
		s.textContent = `row ${i}`;
		d.appendChild(s);
		root.appendChild(d);
	}
	flush();
	renderer.flush();
	root.remove();
}, true);

{
	const root = freshRoot();
	const el = doc.createElement('div');
	el.className = ROW_CLASS;
	root.appendChild(el);
	flush();
	await bench('dom:class-flip-2k', 3, () => {
		for (let i = 0; i < 2000; i++)
			el.className = i % 2 ? ROW_CLASS + ' extra' : ROW_CLASS;
	});
	await bench('dom:attr-flip-2k', 3, () => {
		for (let i = 0; i < 2000; i++)
			el.setAttribute('data-active', i % 2 ? 'true' : 'false');
	});
	const p = doc.createElement('p');
	p.textContent = 'x';
	root.appendChild(p);
	flush();
	await bench('dom:text-update-2k', 3, () => {
		for (let i = 0; i < 2000; i++) p.textContent = `stream chunk ${i}`;
	});
	await bench('dom:hover-cycle-2k', 3, () => {
		for (let i = 0; i < 2000; i++)
			dispatchPayload({ elementId: el.nativeId, eventType: i % 2 ? 'mouseEnter' : 'mouseLeave' });
	});
	root.remove();
}

// ── Svelte layer ────────────────────────────────────────────────────────────

let comp: any = null;
const sroot = freshRoot();
await bench('svelte:mount-500', 3, () => {
	comp = mount(BenchList, { target: sroot, props: { rows: 500 } });
	pump();
	unmount(comp);
}, true);

comp = mount(BenchList, { target: sroot, props: { rows: 500 } });
pump();

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
	if (!hit) throw new Error('no ' + text);
	renderer.simulateClick((hit as any).x, (hit as any).y);
}

await bench('svelte:flip-500', 3, () => {
	clickText('flip');
	pump();
}, true);
await bench('svelte:retext-500', 3, () => {
	clickText('tick');
	pump();
}, true);

// ── kit layer — svelai-token components: Svelte + fake DOM, native lane ─────
// same tree shape, but styles resolve through the token table, not rule scans
unmount(comp); // retire the BenchList tree — it would inflate every later applyBatch
const { default: KitBench } = await import('./gen/nkit/KitBench.js');
const { resolveTokens } = await import('./gen/nkit/tokens.js');
const { buttonTheme } = await import('./gen/nkit/themes.js');
const btnCls = buttonTheme.root({ variant: 'soft', color: 'primary', size: 'normal' });
await bench('kit:resolve-10k', 3, () => {
	for (let i = 0; i < 10000; i++) resolveTokens(btnCls, { color: 'primary' });
});

const kroot = freshRoot();
await bench('kit:mount-500', 3, () => {
	comp = mount(KitBench, { target: kroot, props: { rows: 500 } });
	pump();
	unmount(comp);
}, true);

comp = mount(KitBench, { target: kroot, props: { rows: 500 } });
pump();
await bench('kit:flip-500', 3, () => {
	clickText('kitflip');
	pump();
}, true);
await bench('kit:retext-500', 3, () => {
	clickText('kittick');
	pump();
}, true);

// same 500 buttons, no Svelte — isolates the component-runtime share of the gap
const { applyNativeStyle } = await import('./gdom');
await bench('kit:mount-500-dom', 3, () => {
	const root = freshRoot();
	const st = resolveTokens(buttonTheme.root({ variant: 'soft', color: 'primary', size: 'normal' }), { color: 'primary' });
	// fragment build + single attach — same batching Svelte's mount gets
	const frag = doc.createDocumentFragment();
	for (let i = 0; i < 500; i++) {
		const b = doc.createElement('button');
		applyNativeStyle(b, st);
		const t = doc.createElement('span');
		t.textContent = `row ${i}`;
		b.appendChild(t);
		frag.appendChild(b);
	}
	root.appendChild(frag);
	flush();
	renderer.flush();
	root.remove();
}, true);

// ── raw gpuix baseline — same tree, direct op stream, no fake DOM/Svelte ────
// the delta vs dom:/svelte: is the emulation tax in absolute ms
let rawRoot = 0;
let nextRaw = 1_000_000;
const rawRows: number[] = [];
const rawCells: number[] = [];
await bench('raw:mount-500', 3, () => {
	nextRaw = 1_000_000;
	rawRows.length = 0;
	rawCells.length = 0;
	const rootId = nextRaw++;
	const ops: unknown[] = [
		['createElement', rootId, 'div'],
		['setStyle', rootId, { display: 'flex', flexDirection: 'column', width: 400, backgroundColor: '#09090b' }],
	];
	for (let i = 0; i < 500; i++) {
		const r = nextRaw++;
		rawRows.push(r);
		ops.push(
			['createElement', r, 'div'],
			['setStyle', r, { display: 'flex', flexDirection: 'row', gap: 8, paddingTop: 4, paddingBottom: 4, paddingLeft: 8, paddingRight: 8 }],
			['appendChild', rootId, r],
		);
		for (const t of [`row ${i}`, `item ${i}`, '0']) {
			const c = nextRaw++;
			rawCells.push(c);
			ops.push(['createElement', c, 'text'], ['setText', c, t], ['setStyle', c, { fontSize: 13, color: '#fafafa' }], ['appendChild', r, c]);
		}
	}
	ops.push(['setRoot', rootId]);
	renderer.applyBatch(JSON.stringify(ops));
	renderer.flush();
	if (rawRoot) renderer.applyBatch(JSON.stringify([['destroyElement', rawRoot]]));
	rawRoot = rootId;
}, true);

let rawOn = false;
await bench('raw:setstyle-500', 3, () => {
	rawOn = !rawOn;
	const ops = rawRows.map((r) => [
		'setStyle', r,
		{ display: 'flex', flexDirection: 'row', gap: 8, paddingTop: 4, paddingBottom: 4, paddingLeft: 8, paddingRight: 8, backgroundColor: rawOn ? '#27272a' : '#09090b' },
	]);
	renderer.applyBatch(JSON.stringify(ops));
	renderer.flush();
}, true);

let rawTick = 0;
await bench('raw:settext-500', 3, () => {
	rawTick++;
	const ops = rawCells.filter((_, i) => i % 3 === 2).map((c) => ['setText', c, String(rawTick)]);
	renderer.applyBatch(JSON.stringify(ops));
	renderer.flush();
}, true);

// ── native paint ────────────────────────────────────────────────────────────
{
	const s = (renderer as any).getDebugFrameOverlayStats?.();
	if (s) results.set('paint:frame-ms(p90)', { ms: s.p90Ms ?? 0, min: s.currentMs ?? 0 });
}

// ── report ──────────────────────────────────────────────────────────────────
mkdirSync('bench', { recursive: true });
const basePath = 'bench/baseline.json';
const base: Record<string, Row> = existsSync(basePath) ? JSON.parse(readFileSync(basePath, 'utf8')) : {};

console.log('\nscenario                mean       min      ops      vs baseline');
console.log('─'.repeat(74));
for (const [name, r] of results) {
	const b = base[name];
	const delta = b ? `${(((r.ms - b.ms) / b.ms) * 100).toFixed(0).padStart(6)}%` : '     —';
	console.log(
		`${name.padEnd(24)}${r.ms.toFixed(1).padStart(7)} ms ${r.min.toFixed(1).padStart(7)} ms  ${String(r.ops ?? '—').padStart(7)} ${delta}`,
	);
}
const latest = Object.fromEntries(results);
writeFileSync('bench/latest.json', JSON.stringify(latest, null, 2));
if (process.env.SAVE || !existsSync(basePath)) {
	writeFileSync(basePath, JSON.stringify(latest, null, 2));
	console.log('\nbaseline written');
}
