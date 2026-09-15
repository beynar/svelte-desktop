/**
 * nkit conformance: does the component library render and interact natively?
 * Each case mounts a compiled case component from gen/nkit/cases/, drives real
 * GPUI input, asserts on painted text / automation tree.
 */
import { TestGpuixRenderer } from '@gpuix/native';

// freshness: rebuild gen/ first — the suite must never test stale compiled output
await import('../build.ts');

import { installGlobals, doc, dispatchPayload, materializeRoot, setViewport } from './gdom';
import { setRenderer, flush, drainAfterRender } from './native';

installGlobals();
const renderer = new TestGpuixRenderer(640, 600);
setRenderer(renderer as any);
setViewport(640, 600);

const { mount, unmount } = await import('../node_modules/svelte/src/index-client.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pump(times = 1) {
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

const treeJson = () => JSON.parse(renderer.getAutomationTree());
const painted = () => renderer.getPaintedText().join('|');

/** First node in the automation tree matching `pred` → center coords. */
function findCenter(pred: (n: any) => boolean) {
	let hit: { x: number; y: number; w: number; h: number } | null = null;
	const walk = (n: any) => {
		if (hit || !n || typeof n !== 'object') return;
		if (n.bounds && pred(n)) {
			hit = { x: n.bounds.x + n.bounds.width / 2, y: n.bounds.y + n.bounds.height / 2, w: n.bounds.width, h: n.bounds.height };
			return;
		}
		n.children?.forEach(walk);
	};
	walk(treeJson());
	return hit;
}

function textCenter(text: string) {
	return findCenter((n) => n.type === 'text' && typeof n.text === 'string' && n.text.includes(text));
}

/** innermost non-text node that has a text child containing `t` — for
 *  bounds assertions on the *element* a label lives in (buttons, fills). */
function nodeByText(t: string) {
	let hit: any = null;
	const hasText = (n: any): boolean =>
		!!n && typeof n === 'object' &&
		((n.type === 'text' && typeof n.text === 'string' && n.text.includes(t)) || (n.children ?? []).some(hasText));
	const walk = (n: any) => {
		if (hit || !n || typeof n !== 'object') return;
		if (n.type !== 'text' && n.bounds && (n.children ?? []).some((ch: any) => ch.type === 'text' && hasText(ch))) hit = n;
		n.children?.forEach(walk);
	};
	walk(treeJson());
	return hit;
}

function clickText(text: string) {
	const hit = textCenter(text);
	if (!hit) throw new Error(`clickText: no element containing "${text}"`);
	renderer.simulateClick(hit.x, hit.y);
}

function clickAt(x: number, y: number, button = 0) {
	renderer.simulateClick(x, y, button);
}

function clickType(type: string, nth = 0) {
	let hits: { x: number; y: number }[] = [];
	const walk = (n: any) => {
		if (n.type === type && n.bounds) hits.push({ x: n.bounds.x + n.bounds.width / 2, y: n.bounds.y + n.bounds.height / 2 });
		n.children?.forEach(walk);
	};
	walk(treeJson());
	const hit = hits[nth];
	if (!hit) throw new Error(`clickType: no "${type}" element #${nth}`);
	renderer.simulateClick(hit.x, hit.y);
}

/** Count nodes of a native type in the automation tree. */
function countType(type: string) {
	let n = 0;
	const walk = (node: any) => {
		if (node?.type === type) n++;
		node?.children?.forEach(walk);
	};
	walk(treeJson());
	return n;
}

interface Ctx {
	painted: () => string;
	tree: () => string;
	countType: (t: string) => number;
	findCenter: typeof findCenter;
	clickText: (t: string) => void;
	clickType: (t: string, nth?: number) => void;
	clickAt: (x: number, y: number, button?: number) => void;
	hover: (x: number, y: number) => void;
	type: (keys: string) => void;
	key: (k: string) => void;
	down: (x: number, y: number) => void;
	move: (x: number, y: number) => void;
	up: (x: number, y: number) => void;
	scroll: (x: number, y: number, dy: number) => void;
	pump: (n?: number) => Promise<void>;
}

const cases: { name: string; drive?: (c: Ctx) => Promise<void>; expect: (p: string, c: Ctx) => boolean | string }[] = [
	// ── display ──
	{
		name: 'c-button',
		drive: async (c) => { c.clickText('save-btn'); await c.pump(); },
		expect: (p) => p.includes('save-btn') && p.includes('ghost-btn') && p.includes('btn-n=1'),
	},
	{
		name: 'c-display',
		expect: (p) =>
			['disp-title', 'badge-new', 'chip-beta', 'card-t', 'card-d', 'card-body', 'stat-l', '42', 'empty-t', 'AL'].every((t) =>
				p.includes(t),
			) || 'missing display marker',
	},
	{ name: 'c-alert', expect: (p) => p.includes('alert-t') && p.includes('alert-d') },
	{
		name: 'c-loading',
		expect: (p, c) => p.includes('loading-mounted') && c.countType('svg') >= 1 && c.countType('div') >= 4,
	},
	// ── forms ──
	{
		name: 'c-checkbox',
		drive: async (c) => {
			c.clickText('agree-cb'); await c.pump();
			if (!painted().includes('cb=true')) throw new Error('check did not bind');
			c.clickText('agree-cb'); await c.pump();
		},
		expect: (p) => p.includes('cb=false'),
	},
	{
		name: 'c-switch',
		drive: async (c) => { c.clickText('sw-lbl'); await c.pump(); },
		expect: (p) => p.includes('sw=true'),
	},
	{
		name: 'c-radio',
		drive: async (c) => { c.clickText('opt-b'); await c.pump(); },
		expect: (p) => p.includes('rg=b'),
	},
	{
		name: 'c-segmented',
		drive: async (c) => {
			c.clickText('seg-right'); await c.pump();
			c.clickText('tg-bold'); await c.pump();
		},
		expect: (p) => p.includes('seg=right') && p.includes('tg=true'),
	},
	{
		name: 'c-input',
		drive: async (c) => {
			c.clickType('input'); await c.pump();
			c.type('hi'); await c.pump();
		},
		expect: (p) => p.includes('iv=hi') && p.includes('field-l') && p.includes('field-h'),
	},
	{
		name: 'c-textarea',
		drive: async (c) => {
			c.clickType('textarea'); await c.pump();
			c.type('yo'); await c.pump();
		},
		expect: (p) => p.includes('tv=yo'),
	},
	{
		name: 'c-slider',
		drive: async (c) => {
			// 200px-wide container at top-left; press at x=150 → value≈75
			c.down(150, 10);
			await c.pump();
			c.up(150, 10);
			await c.pump();
		},
		expect: (p) => /sl=(6[5-9]|7[0-9]|8[0-5])/.test(p) || `sl= in "${p}"`,
	},
	{
		name: 'c-select',
		drive: async (c) => {
			c.clickText('pick-one'); await c.pump(2);
			c.clickText('sel-two'); await c.pump(2);
		},
		expect: (p) => p.includes('sel=two'),
	},
	// ── nav/layout ──
	{
		name: 'c-tabs',
		drive: async (c) => { c.clickText('tab-b'); await c.pump(); },
		expect: (p) => p.includes('panel-b') && p.includes('tv=b'),
	},
	{
		name: 'c-accordion',
		drive: async (c) => {
			c.clickText('acc-t-a'); await c.pump();
			if (!painted().includes('acc-body-a')) throw new Error('acc-a did not open');
			c.clickText('acc-t-b'); await c.pump(8); // wait out the slide outro (~200ms)
		},
		// single mode: opening b must close a
		expect: (p) => p.includes('acc-body-b') && !p.includes('acc-body-a'),
	},
	{
		name: 'c-sidebar',
		drive: async (c) => { c.clickText('sb-settings'); await c.pump(); },
		expect: (p) => p.includes('sb=settings'),
	},
	{
		name: 'c-resizable',
		drive: async (c) => {
			// divider = 4px-wide tall div inside the 400px box; drag it +60px right
			const d = c.findCenter((n) => n.bounds.width <= 8 && n.bounds.height >= 80 && n.bounds.x > 0);
			if (!d) throw new Error('divider not found');
			c.down(d.x, d.y); await c.pump();
			c.move(d.x + 60, d.y); await c.pump();
			c.up(d.x + 60, d.y); await c.pump();
		},
		expect: (p) => /rz=(6[0-9]|7[0-9])/.test(p) || `rz in "${p}"`,
	},
	{
		name: 'c-crumbs',
		drive: async (c) => {
			c.clickText('bc-lib'); await c.pump();
			c.clickText('3'); await c.pump();
		},
		expect: (p) => p.includes('nav=lib') && p.includes('pg=3'),
	},
	{
		name: 'c-tree',
		drive: async (c) => {
			c.clickText('tr-root'); await c.pump(); // expands → tr-kid visible
			c.clickText('tr-kid'); await c.pump(); // selects leaf
			if (!painted().includes('ts=kid')) throw new Error('leaf select did not bind');
			c.clickText('tr-root'); await c.pump(); // collapse → tr-kid unpaints
		},
		expect: (p) => p.includes('ts=kid') && !p.includes('tr-kid'),
	},
	{
		name: 'c-table',
		drive: async (c) => { c.clickText('row-ada'); await c.pump(); },
		expect: (p) => p.includes('col-name') && p.includes('row-ada') && p.includes('tsel=row-ada'),
	},
	{
		name: 'c-vlist',
		drive: async (c) => {
			if (!painted().includes('vl-row-0')) throw new Error('row 0 not painted before scroll');
			// bound the window via the automation tree — painted text only covers the screen
			const rows = (renderer.getAutomationTree().match(/vl-row-\d+/g) ?? []).length;
			if (rows > 150) throw new Error(`window not bounded — ${rows} rows materialized`);
			c.scroll(60, 60, -300); // ~12 rows of 24px
			await c.pump(2);
		},
		expect: (p) => !p.includes('vl-row-0|') && p.includes('vl-row-1') && /vl-row-(1[0-9]|2[0-9])\b/.test(p),
	},
	// ── content primitives ──
	{
		name: 'c-content',
		expect: (_p, c) =>
			(c.countType('markdown') >= 1 || _p.includes('md-heading')) &&
			(c.countType('code') >= 1 || _p.includes('codeMarker')) &&
			(c.countType('diff') >= 1 || _p.includes('newLine')),
	},
	// ── overlays ──
	{
		name: 'c-popover',
		drive: async (c) => {
			c.clickText('pop-trig'); await c.pump(2);
			const opened = painted().includes('pop-body') && painted().includes('pop-state=true');
			c.clickText('outside-spot'); await c.pump(8); // wait out the fade outro (~100ms)
			if (!opened) throw new Error('popover never opened');
		},
		expect: (p) => !p.includes('pop-body') && p.includes('pop-state=false'),
	},
	{
		name: 'c-popover-open',
		expect: (p) => p.includes('pop-body'),
	},
	{
		name: 'c-menu',
		drive: async (c) => {
			c.clickText('menu-trig'); await c.pump(2);
			c.clickText('mi-edit'); await c.pump(2);
			if (!painted().includes('msel=edit')) throw new Error('dropdown select did not fire onselect');
			// right-click context menu — also asserts it opens near the pointer, not at y≈0
			const z = c.findCenter((n) => n.type === 'text' && n.text?.includes('ctx-zone'));
			if (!z) throw new Error('no ctx-zone');
			c.clickAt(z.x, z.y, 2); await c.pump(2);
			const item = c.findCenter((n) => n.type === 'text' && n.text?.includes('ctx-item'));
			if (!item) throw new Error('context menu did not open');
			if (Math.abs(item.y - z.y) > 80 || Math.abs(item.x - z.x) > 80)
				throw new Error(`ctx menu painted at ${item.x},${item.y} — pointer was ${z.x},${z.y}`);
			c.clickText('ctx-item'); await c.pump(2);
		},
		expect: (p) => p.includes('msel=ctx'),
	},
	{
		name: 'c-dialog',
		drive: async (c) => {
			c.clickText('dlg-open'); await c.pump(2);
			if (!painted().includes('dlg-t')) throw new Error('dialog did not open');
			c.key('escape'); await c.pump(2);
			if (!painted().includes('dlg=false')) throw new Error('escape did not close');
			c.clickText('dlg-open'); await c.pump(2);
			c.clickAt(8, 8); await c.pump(2); // scrim corner
		},
		expect: (p) => p.includes('dlg=false'),
	},
	{
		name: 'c-toast',
		drive: async (c) => { c.clickText('mk-toast'); await c.pump(2); },
		expect: (p) => p.includes('toast-msg') && p.includes('toast-t'),
	},
	{
		name: 'c-scroll',
		drive: async (c) => { c.scroll(60, 40, -120); await c.pump(2); },
		expect: (p) => /sc=-?[1-9]/.test(p) || `sc in "${p}"`,
	},
	{
		name: 'c-tooltip',
		drive: async (c) => {
			const h = c.findCenter((n) => n.type === 'text' && n.text?.includes('tt-host'));
			if (!h) throw new Error('no tt-host');
			c.hover(h.x, h.y); await c.pump(3);
			if (!painted().includes('tt-text')) throw new Error('tooltip never appeared');
			const hc = c.findCenter((n) => n.type === 'text' && n.text?.includes('hc-host'));
			if (!hc) throw new Error('no hc-host');
			c.hover(hc.x, hc.y); await c.pump(8); // out the tooltip's fade outro
		},
		// tooltip hides on leave — only the hovercard remains
		expect: (p) => !p.includes('tt-text') && p.includes('hc-body'),
	},
	// ── theme + motion ──
	{
		name: 'c-theme',
		drive: async (c) => {
			// registry default: components.button.size='large' → 36px control height
			const btn = nodeByText('big-btn');
			if (!btn || btn.bounds.height < 34) throw new Error(`registry size not applied — btn h=${btn?.bounds?.height}`);
			// theme swap: the button's click handler flips theme → light
			c.clickText('big-btn'); await c.pump(2);
		},
		expect: (p) =>
			p.includes('th=light') && p.includes('dc=primary') && p.includes('themed-chip') && p.includes('inst-chip'),
	},
	{
		name: 'c-motion',
		drive: async (c) => {
			// spinner grid: 9 cells + svg-free (variant replaces the default icon)
			if (!painted().includes('mv-rm=false')) throw new Error('reduced-motion state not painted');
			// progress: 30→80 animates the fill width (WAAPI lane)
			c.clickText('bump-val'); await c.pump();
			if (!painted().includes('80%')) throw new Error('progress label did not update');
			// transition keep-alive: 'anim-box' starts its outro but stays mounted
			c.clickText('hide-box'); await c.pump();
			const midFade = painted().includes('anim-box');
			await c.pump(8); // outro completes → unmount
			if (!midFade) throw new Error('outro did not keep the node alive');
		},
		expect: (p) => !p.includes('anim-box') && p.includes('80%'),
	},
];

const results: [string, string][] = [];
for (const c of cases) {
	const target = doc.createElement('div');
	doc.body.appendChild(target);
	materializeRoot(target);
	try {
		const mod = await import(`./gen/nkit/cases/${c.name}.js`);
		const app = mount(mod.default, { target });
		await sleep(20);
		flush();
		renderer.flush();
		drainAfterRender();
		const ctx: Ctx = {
			painted,
			tree: () => renderer.getAutomationTree(),
			countType,
			findCenter,
			clickText,
			clickType,
			clickAt,
			hover: (x, y) => renderer.simulateMouseMove(x, y),
			type: (k) => renderer.simulateKeystrokes(k),
			key: (k) => { renderer.simulateKeyDown(k); renderer.simulateKeyUp(k); },
			down: (x, y) => renderer.simulateMouseDown(x, y),
			move: (x, y) => renderer.simulateMouseMove(x, y, 0),
			up: (x, y) => renderer.simulateMouseUp(x, y),
			scroll: (x, y, dy) => renderer.simulateScrollWheel(x, y, 0, dy),
			pump,
		};
		if (c.drive) await c.drive(ctx);
		const ok = c.expect(painted(), ctx);
		results.push([c.name, ok === true ? 'PASS' : `FAIL (${ok})`]);
		await unmount(app).catch(() => {});
	} catch (e) {
		results.push([c.name, `ERROR ${String(e).split('\n')[0].slice(0, 120)}`]);
	}
	target.remove();
}

console.log('\n=== NKIT CONFORMANCE ===');
for (const [n, r] of results) console.log(`${r === 'PASS' ? '✅' : '❌'} ${n.padEnd(18)} ${r}`);
console.log(`${results.filter(([, r]) => r === 'PASS').length}/${results.length} pass`);
process.exit(results.every(([, r]) => r === 'PASS') ? 0 : 1);
