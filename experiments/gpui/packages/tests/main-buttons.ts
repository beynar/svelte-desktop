import { GpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot, setViewport } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender, listScrollTop } from '@svelte-desktop/gpuix/native';

installGlobals();

const renderer = new GpuixRenderer((err, payload) => {
	if (err) {
		console.error('[gpuix]', err);
		return;
	}
	dispatchPayload(payload);
});
setRenderer(renderer);
const W = 1280, H = 800;
renderer.init({ title: '5000 buttons — gpuix virtual list', width: W, height: H });
renderer.setDebugFrameOverlay('minimal');
setViewport(W, H);

const COUNT = 5000;
// gpui::list measures each item's own box via layout_as_root — margins are
// excluded, so the row's real pitch is its border-box height: 40px. If
// estimatedItemHeight exceeds it, the scroll anchor can hold offset_in_item
// > 40 and every remeasure snaps the whole list by the difference in a frame.
const ROW_H = 40;
const OVERDRAW = 8;
let clicks = 0;

const target = doc.createElement('div');
target.setAttribute('style', 'display:flex;flex-direction:column;width:100%;height:100%;backgroundColor:#09090b');
doc.body.appendChild(target);
materializeRoot(target);

// ── Header: title + click counter + ticking clock ──
const header = doc.createElement('div');
header.setAttribute('style',
	'display:flex;flex-direction:row;align-items:center;gap:16px;padding:14px 18px;' +
	'border-bottom-width:1px;border-bottom-color:#27272a;background-color:#131316;flex-shrink:0');
target.appendChild(header);

const title = doc.createElement('div');
title.setAttribute('style', 'color:#fafafa;font-size:15px');
header.appendChild(title);
title.appendChild(doc.createTextNode(`${COUNT} buttons — scroll, hover, click`));

const counterEl = doc.createElement('div');
counterEl.setAttribute('style', 'color:#a1a1aa;font-size:13px');
header.appendChild(counterEl);
const counterText = doc.createTextNode('clicks: 0');
counterEl.appendChild(counterText);

const clockEl = doc.createElement('div');
clockEl.setAttribute('style', 'color:#71717a;font-size:13px;margin-left:auto');
header.appendChild(clockEl);
const clockText = doc.createTextNode('');
clockEl.appendChild(clockText);

// ── Virtual list ──
const vl = doc.createElement('virtual-list');
vl.setAttribute('style', 'flex-grow:1');
vl.setCustomProp('itemCount', COUNT);
vl.setCustomProp('estimatedItemHeight', ROW_H);
// ListState's default render overdraw is 512px (~11 rows) — deeper than the
// JS window's 8. Any requested index outside the JS window paints a blank
// unmounted row; keep the native overdraw strictly inside ours.
vl.setCustomProp('overdraw', (OVERDRAW - 1) * ROW_H);
vl.setCustomProp('windowStart', 0);
target.appendChild(vl);

let frameNo = 0;
const IDLE = '#1f1f23', HOVER = '#2e2e35', DOWN = '#3f3f4a', CLICKED = '#1d3a2a';
const clickCounts = new Map<number, number>();
let hoveredEl: any = null;
let hoveredReset: (() => void) | null = null;

const btnStyle = (bg: string) =>
	'display:flex;flex-direction:row;align-items:center;gap:10px;' +
	'padding:10px 14px;border-radius:8px;background-color:' + bg + ';' +
	'border-width:1px;border-color:#27272a;flex-shrink:0;height:' + ROW_H + 'px;margin:0 12px';

function makeRow(i: number) {
	const btn = doc.createElement('div');
	btn.setAttribute('style', btnStyle(clickCounts.get(i) ? CLICKED : IDLE));
	const label = doc.createElement('div');
	label.setAttribute('style', 'color:#e4e4e7;font-size:13px');
	label.appendChild(doc.createTextNode(`Button #${i}`));
	const badge = doc.createElement('div');
	badge.setAttribute('style', 'color:#71717a;font-size:11px;margin-left:auto');
	const badgeText = doc.createTextNode(`${clickCounts.get(i) ?? 0} clicks`);
	badge.appendChild(badgeText);
	btn.appendChild(label);
	btn.appendChild(badge);

	let cur = clickCounts.get(i) ? CLICKED : IDLE;
	const setBg = (c: string) => {
		if (c === cur) return;
		cur = c;
		console.log(`[f${frameNo}] setBg row ${i} ${c}`);
		btn.setAttribute('style', btnStyle(c));
	};
	// Single-hover invariant: only one row can be hovered at a time. A stale
	// enter (GPUI defers hover transitions captured at prepaint — the leave can
	// be suppressed) is cleared by the next enter on any other row.
	btn.addEventListener('mouseover', () => {
		if (hoveredReset && hoveredEl !== btn) hoveredReset();
		hoveredEl = btn;
		hoveredReset = () => { if (!clickCounts.get(i)) setBg(IDLE); };
		if (!clickCounts.get(i)) setBg(HOVER);
	});
	btn.addEventListener('mouseout', () => {
		if (hoveredEl === btn) { hoveredEl = null; hoveredReset = null; }
		if (!clickCounts.get(i)) setBg(IDLE);
	});
	btn.addEventListener('mousedown', () => setBg(DOWN));
	btn.addEventListener('click', () => {
		const n = (clickCounts.get(i) ?? 0) + 1;
		clickCounts.set(i, n);
		clicks++;
		badgeText.textContent = `${n} clicks`;
		counterText.textContent = `clicks: ${clicks}`;
		setBg(CLICKED);
	});
	return btn;
}

// ── Window slicing ──
let windowStart = 0;
function renderWindow(start: number) {
	const visible = Math.ceil(H / ROW_H) + 2 * OVERDRAW;
	const end = Math.min(COUNT, start + visible);
	while (vl.firstChild) vl.removeChild(vl.firstChild);
	for (let i = start; i < end; i++) vl.appendChild(makeRow(i));
	windowStart = start;
	vl.setCustomProp('windowStart', start);
	console.log(`[f${frameNo}] renderWindow ${start}..${end}`);
}
function syncRange() {
	if (!vl.nativeId) return;
	const anchor = listScrollTop(vl.nativeId);
	if (!anchor) return;
	const [itemIndex] = anchor;
	const start = Math.max(0, Math.min(COUNT - 1, itemIndex - OVERDRAW));
	if (start !== windowStart) renderWindow(start);
}
vl.addEventListener('visiblerange', syncRange);
vl.addEventListener('scroll', syncRange);

renderWindow(0);
flush();
console.log(`mounted virtual list, ${COUNT} logical rows`);

// Debug watcher: per-frame bounds capture to catch 1-frame layout transients.
let lastBounds = new Map<string, { x: number; y: number; w: number; h: number }>();
const captureBounds = () => {
	try {
		const tree = JSON.parse(renderer.getAutomationTree());
		const cur = new Map<string, { x: number; y: number; w: number; h: number }>();
		const walk = (n: any) => {
			if (n.bounds && n.id) cur.set(String(n.id), n.bounds);
			(n.children ?? []).forEach(walk);
		};
		walk(tree);
		if (lastBounds.size) {
			const diffs: string[] = [];
			for (const [id, b] of cur) {
				const prev = lastBounds.get(id);
				if (!prev || JSON.stringify(prev) !== JSON.stringify(b)) {
					diffs.push(`${id}:${prev ? `${prev.x},${prev.y} ${prev.width}x${prev.height}` : 'new'} -> ${b.x},${b.y} ${b.width}x${b.height}`);
				}
			}
			for (const id of lastBounds.keys()) if (!cur.has(id)) diffs.push(`-${id}`);
			if (diffs.length) console.log(`[f${frameNo}] ${diffs.length} moved: ${diffs.slice(0, 10).join(' | ')}`);
		}
		lastBounds = cur;
	} catch {}
};

setInterval(() => {
	clockText.textContent = new Date().toLocaleTimeString();
}, 250);

const loop = () => {
	frameNo++;
	const running = renderer.tick();
	drainAfterRender();
	captureBounds();
	if (running) setImmediate(loop);
};
loop();
