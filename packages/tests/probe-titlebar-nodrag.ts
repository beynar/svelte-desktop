/**
 * Titlebar no-drag verification — a `data-window-drag` strip containing
 * click targets, a focusable child, and a delegated-handler child. Real
 * CGEvent double-clicks + drags via the vendored Swift helper
 * (bin/cge.swift — posts two full down/up pairs with clickCount 1→2;
 * cliclick's `dc` posts a single clickCount=2 pair and `m` posts
 * mouseMoved, so neither exercises the real input path). Window frame is
 * read through CGWindowList. Asserts:
 *   dblclick button        → click fires (count++), window does NOT zoom
 *   dblclick input         → window does NOT zoom (default_prevented path)
 *   click tabindex child   → element takes focus (click-to-focus)
 *   dblclick tabindex      → window does NOT zoom, focus stays
 *   dblclick delegated     → handler fires, window does NOT zoom
 *   click body tabindex    → element takes focus
 *   dblclick titlebar      → window zooms/restores (AppleActionOnDoubleClick)
 *   drag button            → window does NOT move
 *   single click           → still works after the gesture sequence
 *
 * Manual only — posting CGEvents requires macOS Accessibility (TCC)
 * permission for the host terminal, plus a focused on-screen window.
 *
 * Run: bun probe-titlebar-nodrag.ts   (from packages/tests)
 */
import { existsSync } from 'node:fs';

// ── preconditions — fail fast instead of cascading FAILs ────────────
const CGE = new URL('./bin/cge.swift', import.meta.url).pathname;
if (!existsSync(CGE)) {
	console.error(`[probe] vendored CGEvent helper missing: ${CGE}`);
	process.exit(1);
}
if (!Bun.which('swift')) {
	console.error('[probe] `swift` toolchain not on PATH — install the Xcode CLT (`xcode-select --install`)');
	process.exit(1);
}

import { GpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot, setViewport } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';

installGlobals();
const renderer = new GpuixRenderer((err, payload) => {
	if (err) { console.error('[gpuix]', err); return; }
	dispatchPayload(payload);
});
setRenderer(renderer);
renderer.init({
	title: 'nodrag probe',
	width: 700,
	height: 400,
	titlebarTransparent: true,
	appOwnsTitlebarDrag: true,
});
setViewport(700, 400);

const target = doc.createElement('div');
target.setAttribute('style', 'display:flex;flex-direction:column;width:100%;height:100%');
doc.body.appendChild(target);
materializeRoot(target);

const bar = doc.createElement('div');
bar.setAttribute(
	'style',
	// user-select:none mirrors the app titlebar — without it a dblclick on a
	// text-bearing child word-selects and blurs focus (intentional paint.rs
	// behavior), which would mask the focus assertions below.
	'display:flex;flex-direction:row;align-items:center;height:38px;padding-left:84px;background-color:#26262d;user-select:none',
);
bar.setAttribute('data-window-drag', '');
const title = doc.createElement('div');
title.setAttribute('style', 'flex:1;text-align:center;font-size:12px');
title.textContent = 'probe-title';
const btn = doc.createElement('div');
btn.setAttribute('style', 'padding:4px 10px;background-color:#0a84ff;color:#fff;font-size:12px');
let count = 0;
btn.textContent = 'count: 0';
btn.addEventListener('click', () => {
	count++;
	btn.textContent = `count: ${count}`;
});
const input = doc.createElement('input');
input.setAttribute('style', 'width:90px;margin-left:8px;font-size:12px');
// Focusable child inside the drag region — the click-to-focus regression
// class: track_focus's prevent_default must suppress the titlebar zoom
// while still letting the element take focus.
const tbFocus = doc.createElement('div');
tbFocus.setAttribute('tabindex', '0');
tbFocus.setAttribute('style', 'margin-left:8px;padding:2px 6px;background-color:#3a3a42;font-size:12px');
tbFocus.textContent = 'tb-focus';
// Delegated-handler child — what Svelte's `$.delegated` actually writes:
// a raw el[Symbol('events')] map, bypassing addEventListener entirely.
// gdom's press-target check reads that symbol at materialize time, so the
// write must land before the element is appended to a live parent.
const EVENTS = Symbol('events');
let delegatedClicks = 0;
const del = doc.createElement('div');
del.setAttribute('style', 'margin-left:8px;padding:2px 6px;background-color:#3a3a42;font-size:12px');
del.textContent = 'delegated';
(del as unknown as Record<symbol, unknown>)[EVENTS] = { click: () => delegatedClicks++ };
bar.appendChild(title);
bar.appendChild(btn);
bar.appendChild(input);
bar.appendChild(tbFocus);
bar.appendChild(del);
target.appendChild(bar);

// Focusable element outside the drag region — plain click-to-focus.
const bodyFocus = doc.createElement('div');
bodyFocus.setAttribute('tabindex', '0');
bodyFocus.setAttribute('style', 'margin:24px;padding:12px;background-color:#1c1c22;font-size:12px');
bodyFocus.textContent = 'body-focus';
target.appendChild(bodyFocus);

// Minimal stand-in for Svelte's handle_event_propagation — the
// document-level delegated listener that walks the event path and invokes
// el[Symbol('events')] handlers. Registering it also backfills a native
// `click` listener onto every element, matching real app shape.
doc.addEventListener('click', (ev: any) => {
	for (let n = ev.target; n; n = n.parentNode) {
		const h = (n as Record<symbol, { click?: (e: unknown) => void }>)[EVENTS]?.click;
		if (h) h.call(n, ev);
	}
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pump = async (n = 6) => {
	for (let i = 0; i < n; i++) {
		renderer.tick(16);
		flush();
		drainAfterRender();
		await sleep(20);
	}
};

interface Node {
	type: string;
	id?: number;
	text?: string;
	bounds: { x: number; y: number; width: number; height: number };
	children?: Node[];
}
const tree = () => JSON.parse(renderer.getAutomationTree()) as Node;
function find(pred: (n: Node) => boolean, n: Node): Node | null {
	if (pred(n)) return n;
	for (const c of n.children ?? []) {
		const r = find(pred, c);
		if (r) return r;
	}
	return null;
}
const center = (n: Node) => ({ x: n.bounds.x + n.bounds.width / 2, y: n.bounds.y + n.bounds.height / 2 });
const painted = () => (renderer.getPaintedText() as string[]).join(' ');

// Window frame in screen pts via CGWindowList — no AX trust needed.
// Picks this process's largest layer-0 window.
function axFrame(): { x: number; y: number; w: number; h: number } {
	const r = Bun.spawnSync([
		'swift', '-e', `
import Cocoa
let all = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as! [[String: Any]]
var best: [String: CGFloat]?; var area: CGFloat = 0
for w in all {
  guard (w[kCGWindowOwnerPID as String] as? Int) == ${process.pid},
        (w[kCGWindowLayer as String] as? Int) == 0,
        let b = w[kCGWindowBounds as String] as? [String: CGFloat],
        let h = b["Height"], let wd = b["Width"], h * wd > area, h > 100 else { continue }
  best = b; area = h * wd
}
if let b = best { print("\\(Int(b["X"]!)) \\(Int(b["Y"]!)) \\(Int(b["Width"]!)) \\(Int(b["Height"]!))") } else { print("none") }
`]);
	const out = new TextDecoder().decode(r.stdout).trim();
	const err = new TextDecoder().decode(r.stderr).trim();
	if (!/^\d+ \d+ \d+ \d+$/.test(out)) {
		console.error('[axFrame] bad output:', JSON.stringify(out), 'stderr:', err.slice(0, 200));
		return { x: 0, y: 0, w: 0, h: 0 };
	}
	const [x, y, w, h] = out.split(' ').map(Number);
	return { x, y, w, h };
}

let failures = 0;
const check = (name: string, cond: boolean, detail = '') => {
	if (!cond) failures++;
	console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// Real CGEvents via the vendored helper (bin/cge.swift). A helper failure
// is a probe failure — never let it masquerade as a PASS.
const cl = (spec: string) => {
	const r = Bun.spawnSync(['swift', CGE, ...spec.split(' ')]);
	if (r.exitCode !== 0) {
		const err = new TextDecoder().decode(r.stderr).trim();
		check(`cge ${spec}`, false, `exit ${r.exitCode}: ${err.slice(0, 200)}`);
	}
	return r;
};

await pump(10);
// CGEvent hit-tests the topmost window — the probe app opens non-active
// (makeKeyAndOrderFront doesn't activate), so without this raise its
// window can sit below another app's and every event lands there instead.
cl(`raise ${process.pid}`);
await pump(4);
console.log('[probe] painted:', painted().slice(0, 100));

if (!find((n) => n.text === 'count: 0', tree())) {
	console.error('[probe] missing button', JSON.stringify(tree()).slice(0, 400));
	process.exit(1);
}
// content coords → screen coords: fullSizeContentView → content top-left == frame top-left
const toScreen = (n: Node) => {
	const f = axFrame();
	return { x: Math.round(f.x + center(n).x), y: Math.round(f.y + center(n).y) };
};
const btnPt = () => {
	const n = find((n) => typeof n.text === 'string' && n.text.startsWith('count:'), tree());
	if (!n) throw new Error('no button');
	return toScreen(n);
};
const ptFor = (el: { nativeId: number }, label: string) => {
	const n = find((nd) => nd.id === el.nativeId, tree());
	if (!n?.bounds) throw new Error(`no painted automation node for ${label} (nativeId ${el.nativeId})`);
	return toScreen(n);
};
// A non-interactive spot inside the drag region: the painted 'probe-title'
// text sits inside the windowDrag bar but is no press target, so a
// double-click there must reach the titlebar's zoom gesture.
const titlePt = () => {
	const n = find((nd) => nd.text === 'probe-title', tree());
	if (!n?.bounds) throw new Error('no probe-title node');
	return toScreen(n);
};
console.log('[probe] frame', axFrame(), 'btn@', btnPt(), 'title@', titlePt());

// ── 1. double-click the button: clicks fire, no zoom ───────────────
const frame0 = axFrame();
cl(`dbl ${btnPt().x} ${btnPt().y}`);
await pump(8);
const frame1 = axFrame();
check('button dblclick → no zoom',
	frame1.x === frame0.x && frame1.y === frame0.y && frame1.w === frame0.w && frame1.h === frame0.h,
	`frame ${JSON.stringify(frame1)}`);
check('button dblclick → count 2', painted().includes('count: 2'), painted().slice(0, 60));

// ── 1b. double-click the input: no zoom (default_prevented path) ────
{
	const n = find((nd) => nd.type === 'input', tree());
	if (!n) throw new Error('no input node');
	const p = toScreen(n);
	cl(`dbl ${p.x} ${p.y}`);
	await pump(8);
	const f2 = axFrame();
	check('input dblclick → no zoom',
		f2.x === frame1.x && f2.y === frame1.y && f2.w === frame1.w && f2.h === frame1.h,
		`frame ${JSON.stringify(f2)}`);
}

// ── 1c. tabindex child inside the drag region: click focuses ───────
{
	const p = ptFor(tbFocus, 'tbFocus');
	cl(`click ${p.x} ${p.y}`);
	await pump(10);
	check('click tabindex in titlebar → focused',
		renderer.getFocusedElementId() === tbFocus.nativeId,
		`focused=${renderer.getFocusedElementId()} want=${tbFocus.nativeId}`);

	const before = axFrame();
	const p2 = ptFor(tbFocus, 'tbFocus');
	cl(`dbl ${p2.x} ${p2.y}`);
	await pump(8);
	const after = axFrame();
	check('titlebar tabindex dblclick → no zoom',
		after.x === before.x && after.y === before.y && after.w === before.w && after.h === before.h,
		`frame ${JSON.stringify(after)}`);
	check('titlebar tabindex dblclick → still focused',
		renderer.getFocusedElementId() === tbFocus.nativeId,
		`focused=${renderer.getFocusedElementId()}`);
}

// ── 1d. delegated-handler child of the drag region ─────────────────
{
	const before = axFrame();
	const p = ptFor(del, 'del');
	cl(`dbl ${p.x} ${p.y}`);
	await pump(8);
	const after = axFrame();
	check('delegated-handler dblclick → no zoom',
		after.x === before.x && after.y === before.y && after.w === before.w && after.h === before.h,
		`frame ${JSON.stringify(after)}`);
	check('delegated-handler dblclick → handler ran twice',
		delegatedClicks === 2, `clicks=${delegatedClicks}`);
}

// ── 1e. tabindex child outside the drag region: click focuses ──────
{
	const p = ptFor(bodyFocus, 'bodyFocus');
	cl(`click ${p.x} ${p.y}`);
	await pump(10);
	check('click tabindex in body → focused',
		renderer.getFocusedElementId() === bodyFocus.nativeId,
		`focused=${renderer.getFocusedElementId()} want=${bodyFocus.nativeId}`);
}

// ── 2. drag on button: window does NOT move ────────────────────────
{
	const p = btnPt();
	cl(`drag ${p.x} ${p.y} ${p.x + 80} ${p.y + 10}`);
	await pump(8);
	const f = axFrame();
	check('drag on button → window stays',
		Math.abs(f.x - frame1.x) < 4 && Math.abs(f.y - frame1.y) < 4,
		`frame ${JSON.stringify(f)}`);
}

// ── 3. drag empty titlebar ─────────────────────────────────────────
// AppKit's performWindowDrag reads the hardware event tap — synthetic
// leftMouseDragged streams never engage it (verified on the live app
// too), so this can't be asserted from a probe. The press path IS
// covered by the title-text dblclick zoom below: same propagation to
// the titlebar's on_mouse_down, and the drag branch is unchanged code.
{
	const p = titlePt();
	const before = axFrame();
	cl(`drag ${p.x} ${p.y} ${p.x + 100} ${p.y + 60}`);
	await pump(10);
	const f = axFrame();
	console.log(`SKIP drag empty titlebar → synthetic drags can't drive performWindowDrag (frame ${JSON.stringify(f)} vs ${JSON.stringify(before)})`);
}

// ── 4. double-click the title text: zoom toggles ───────────────────
const beforeZoom = axFrame();
cl(`dbl ${titlePt().x} ${titlePt().y}`);
await pump(10);
const zoomed = axFrame();
check('titlebar dblclick → zoom',
	zoomed.w !== beforeZoom.w || zoomed.h !== beforeZoom.h,
	`frame ${JSON.stringify(zoomed)}`);

// ── 5. double-click again on the moved titlebar: restores ──────────
cl(`dbl ${titlePt().x} ${titlePt().y}`);
await pump(10);
const restored = axFrame();
check('titlebar dblclick → restore',
	Math.abs(restored.w - beforeZoom.w) < 6 && Math.abs(restored.h - beforeZoom.h) < 6,
	`frame ${JSON.stringify(restored)}`);

// ── 6. single click still works after all that ─────────────────────
cl(`click ${btnPt().x} ${btnPt().y}`);
await pump(8);
check('single click → count 3', painted().includes('count: 3'), painted().slice(0, 60));

console.log(failures === 0 ? '[probe] ALL PASS' : `[probe] ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
