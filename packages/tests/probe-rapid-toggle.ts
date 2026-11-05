/**
 * Probe: rapid in/out toggling mid-transition must converge to a clean end
 * state — element present at full bounds with no stale animation styles.
 * Reproduces the bugged sidebar state from rapid open/close.
 */
import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';

installGlobals();
const renderer = new TestGpuixRenderer(640, 600);
setRenderer(renderer as any);
const { mount } = await import('@svelte-desktop/svelte/svelte-client.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function railEls() {
	const hits: any[] = [];
	const walk = (n: any) => {
		if (n.nodeType === 1 && (n.className ?? '').includes('rail')) hits.push(n);
		for (const c of n.childNodes ?? []) walk(c);
	};
	walk(doc.documentElement);
	return hits;
}
const railEl = () => railEls()[0] ?? null;

function boundsOf(text: string) {
	const tree = JSON.parse(renderer.getAutomationTree());
	let b: { width: number; height: number } | null = null;
	const walk = (n: any, parent: any) => {
		if (b) return;
		if (n.type === 'text' && n.text === text && parent) b = parent.bounds;
		n.children?.forEach((c: any) => walk(c, n));
	};
	walk(tree, null);
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
const { default: Slide } = await import('./gen/cases/slide.js');
mount(Slide, { target });
await sleep(60);
await pumpOnce();

let pass = 0, fail = 0;
const check = (ok: boolean, label: string) => {
	console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
	ok ? pass++ : fail++;
};

// Wait for the intro to fully settle, then rapid-toggle: each click lands
// mid-animation (160ms duration vs ~40-90ms between toggles).
await pump(260);
const rail = railEl();
check(!!rail, 'rail present before burst');

for (let i = 0; i < 6; i++) {
	clickText('side');
	await pump(35 + (i % 3) * 20); // 35/55/75ms — always mid-transition
}
// End open: one more toggle if the last state was closed (6 toggles → open)
// 6 toggles from open = open; let it settle.
await pump(400);

const els = railEls();
const el = els[0];
const b = boundsOf('railcontent');
console.log('  rail count:', els.length, els.map((e: any) => e.nativeId));
for (const e of els)
	console.log(`  id=${e.nativeId} props:`, JSON.stringify([...e.style.props]));
console.log('  end bounds:', b ? `${b.width}×${b.height}` : 'unmounted');

check(!!el, 'rail element present after rapid toggles');
check(!!b && b.width >= 199, `rail bounds ~200px (got ${b?.width})`);
const opacity = el?.style.props.get('opacity');
check(opacity === undefined || parseFloat(opacity) >= 0.99, `opacity resolved (got ${opacity})`);
const width = el?.style.props.get('width');
check(
	width === undefined || parseFloat(width) >= 199,
	`width resolved to ~200px (got ${width})`,
);
// 'undefined' string leaking into props — svelte restores
// element.style.overflow = <captured> on introend; if our proxy returned
// undefined at capture time, the literal string 'undefined' ships native.
for (const [k, v] of el?.style.props ?? []) {
	check(v !== 'undefined', `prop ${k} is not the string 'undefined'`);
}

// Now the other direction — leave it closed.
clickText('side');
await pump(400);
check(!railEl(), 'rail unmounted after final close');
// And reopen — a fresh mount after all that churn.
clickText('side');
await pump(400);
check(!!railEl() && (boundsOf('railcontent')?.width ?? 0) >= 199, 'rail clean on remount');

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
