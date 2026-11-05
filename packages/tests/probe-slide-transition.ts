/**
 * Probe: svelte in:/out: transitions must produce real native animation —
 * sampled painted bounds between 0 and full, not a jump cut. Covers both
 * svelte's vertical `slide` (height) and a custom `collapseX` (width).
 */
import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';

installGlobals();
const renderer = new TestGpuixRenderer(640, 600);
setRenderer(renderer as any);
const { mount } = await import('@svelte-desktop/svelte/svelte-client.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Find the bounds of the grandparent of a text node (parent is the span). */
function grandBounds(text: string) {
	const tree = JSON.parse(renderer.getAutomationTree());
	let b: { width: number; height: number } | null = null;
	const walk = (n: any, parent: any, grand: any) => {
		if (b) return;
		if (n.type === 'text' && n.text === text && grand) b = grand.bounds;
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
	// transition setup (measure + first-keyframe pin) lives there. Yielding
	// first keeps this harness honest: a draw here must see post-microtask
	// state, never the un-pinned mount frame.
	await sleep(0);
	flush();
	renderer.flush();
	drainAfterRender();
}

/** Sample `grandBounds(text)[dim]` for `ms` while the transition runs. */
async function sample(text: string, dim: 'width' | 'height', ms: number) {
	const out: number[] = [];
	const start = Date.now();
	while (Date.now() - start < ms) {
		await pumpOnce();
		const b = grandBounds(text);
		if (b) out.push(b[dim]);
		await sleep(8);
	}
	return out;
}

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

// ── vertical slide (height axis) ──────────────────────────────────────
check(grandBounds('sliding')?.height === 60, `panel open at 60px (got ${grandBounds('sliding')?.height})`);
clickText('toggle');
const outH = await sample('sliding', 'height', 280);
console.log('  outro heights:', outH.map((h) => h.toFixed(0)).join(' → '));
check(outH.filter((h) => h > 2 && h < 58).length >= 2, `outro passed through intermediate heights`);
check(grandBounds('sliding') == null, 'panel unmounted after outro');

clickText('toggle');
const inH = await sample('sliding', 'height', 280);
console.log('  intro heights:', inH.map((h) => h.toFixed(0)).join(' → '));
check(inH.filter((h) => h > 2 && h < 58).length >= 2, `intro passed through intermediate heights`);
// no intro flash: never paints ~full then jumps back to ~0
const hFlash = inH.some((h, i) => i > 0 && inH[i - 1] >= 58 && h < 30);
check(!hFlash, 'no intro flash (full-size frame before collapse)');
check(grandBounds('sliding')?.height === 60, `panel back at 60px (got ${grandBounds('sliding')?.height})`);

// ── padded chip — slide animates padding-* longhands, so the box must
//    collapse fully (regression: shorthand-only getComputedStyle fed
//    paddingTop ''→NaN → keyframes dropped padding → stalled at 16px) ──
clickText('chiptoggle');
const chipOut = await sample('chiptext', 'height', 280);
console.log('  chip outro heights:', chipOut.map((h) => h.toFixed(1)).join(' → '));
const chipMin = Math.min(...chipOut);
check(chipMin <= 1, `padded chip collapsed to ~0 (got ${chipMin.toFixed(1)})`);
check(grandBounds('chiptext') == null, 'chip unmounted after outro');

clickText('chiptoggle');
const chipIn = await sample('chiptext', 'height', 280);
console.log('  chip intro heights:', chipIn.map((h) => h.toFixed(1)).join(' → '));
check(chipIn[0] !== undefined && chipIn[0] <= 1, `chip intro started at ~0 (got ${chipIn[0]?.toFixed(1)})`);
check(chipIn.filter((h) => h > 2).length >= 2, `chip intro passed through intermediate heights`);

// ── collapseX (width axis — the sidebar collapse) ─────────────────────
check((grandBounds('railcontent')?.width ?? 0) >= 199, `rail open at 200px (got ${grandBounds('railcontent')?.width})`);
clickText('side');
const outW = await sample('railcontent', 'width', 280);
console.log('  outro widths:', outW.map((w) => w.toFixed(0)).join(' → '));
check(outW.filter((w) => w > 4 && w < 196).length >= 2, `sidebar outro passed through intermediate widths`);
check(grandBounds('railcontent') == null, 'sidebar unmounted after outro');

clickText('side');
const inW = await sample('railcontent', 'width', 280);
console.log('  intro widths:', inW.map((w) => w.toFixed(0)).join(' → '));
check(inW.filter((w) => w > 4 && w < 196).length >= 2, `sidebar intro passed through intermediate widths`);
const wFlash = inW.some((w, i) => i > 0 && inW[i - 1] >= 196 && w < 100);
check(!wFlash, 'no intro flash (full-size frame before collapse)');
check((grandBounds('railcontent')?.width ?? 0) >= 199, `sidebar back at 200px (got ${grandBounds('railcontent')?.width})`);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
