/**
 * Conformance suite: does the fake-DOM→gpuix path cover the Svelte API?
 * Each case mounts fresh, optionally gets driven through real GPUI input,
 * and asserts on painted text.
 */
import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot } from './gdom';
import { setRenderer, flush, drainAfterRender } from './native';

installGlobals();
const renderer = new TestGpuixRenderer(640, 600);
setRenderer(renderer as any);

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

/** Find the element containing `text` in the automation tree and click its center. */
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
	if (!hit) throw new Error(`clickText: no element containing "${text}"`);
	renderer.simulateClick((hit as { x: number; y: number }).x, (hit as { x: number; y: number }).y);
}

function clickType(type: string, nth = 0) {
	const tree = JSON.parse(renderer.getAutomationTree());
	let hits: { x: number; y: number }[] = [];
	const walk = (n: any) => {
		if (n.type === type) {
			hits.push({ x: n.bounds.x + n.bounds.width / 2, y: n.bounds.y + n.bounds.height / 2 });
		}
		n.children?.forEach(walk);
	};
	walk(tree);
	const hit = hits[nth];
	if (!hit) throw new Error(`clickType: no "${type}" element #${nth}`);
	renderer.simulateClick(hit.x, hit.y);
}

const painted = () => renderer.getPaintedText().join('|');

interface Ctx {
	painted: () => string;
	clickText: (t: string) => void;
	clickType: (t: string, nth?: number) => void;
	type: (keys: string) => void;
	pump: (n?: number) => Promise<void>;
	tree: () => string;
}

const cases: { name: string; drive?: (c: Ctx) => Promise<void>; expect: (p: string) => boolean | string }[] = [
	{ name: 'state', expect: (p) => p.includes('n=0') },
	{
		name: 'state-click',
		drive: async (c) => {
			c.clickText('n=0');
			await c.pump();
		},
		expect: (p) => p.includes('n=1'),
	},
	{ name: 'derived', expect: (p) => p.includes('d=6') },
	{ name: 'ifelse', expect: (p) => p.includes('AAA') },
	{
		name: 'ifelse-click',
		drive: async (c) => {
			c.clickText('swap');
			await c.pump();
		},
		expect: (p) => p.includes('BBB'),
	},
	{ name: 'each', expect: (p) => p.includes('[a]') && p.includes('[b]') && p.includes('[c]') },
	{
		name: 'each-reorder',
		drive: async (c) => {
			c.clickText('reorder');
			await c.pump();
		},
		expect: (p) => p.indexOf('[c]') < p.indexOf('[a]'),
	},
	{ name: 'key', expect: (p) => p.includes('key-0') },
	{ name: 'await', drive: async (c) => { await c.pump(3); }, expect: (p) => p.includes('RESOLVED') },
	{
		name: 'bindvalue',
		drive: async (c) => {
			c.clickType('input');
			await c.pump();
			c.type('hi');
			await c.pump();
		},
		expect: (p) => p.includes('v=hi'),
	},
	{
		name: 'use',
		drive: async (c) => {
			c.clickText('tag=none');
			await c.pump();
		},
		expect: (p) => p.includes('tag=upd:two'),
	},
	{ name: 'attach', expect: (p) => p.includes('a=attached') },
	{ name: 'fade', expect: (p) => p.includes('fading') },
	{
		name: 'fade-out',
		drive: async (c) => {
			c.clickText('toggle');
			await c.pump(4);
		},
		expect: (p) => !p.includes('fading'),
	},
	{ name: 'classdir', expect: (p) => p.includes('cls') },
	{ name: 'svelteelement', expect: (p) => p.includes('dyn-div') },
	{
		name: 'svelteelement-swap',
		drive: async (c) => {
			c.clickText('mk-input');
			await c.pump();
		},
		expect: (p, ctx) => ctx.tree().includes('"type":"input"'),
	},
	{ name: 'boundary', expect: (p) => p.includes('caught') },
	{ name: 'head', expect: (p) => p.includes('head-ok') },
	{ name: 'snippet', expect: (p) => p.includes('row:1') },
	{ name: 'spread', expect: (p) => p.includes('spread') },
	{
		name: 'modifiers-once',
		drive: async (c) => {
			c.clickText('once:0');
			await c.pump();
			c.clickText('once:1');
			await c.pump();
		},
		expect: (p) => p.includes('once:1') && !p.includes('once:2'),
	},
	{ name: 'store', expect: (p) => p.includes('storeval') },
	{ name: 'context', expect: (p) => p.includes('ctx=ctx-value') },
	{ name: 'html', expect: (p) => p.includes('injected') },
	{
		name: 'tick',
		drive: async (c) => {
			c.clickText('go');
			await c.pump(2);
		},
		expect: (p) => p.includes('n=42 ticked'),
	},
	{
		name: 'bindthis',
		drive: async (c) => {
			c.clickText('show');
			await c.pump();
		},
		expect: (p) => p.includes('tag=SPAN'),
	},
	{
		name: 'bindchecked',
		drive: async (c) => {
			c.clickType('div', 2); // checkbox renders as a clickable div
			await c.pump();
		},
		expect: (p) => p.includes('c=true'),
	},
	{
		name: 'bindgroup',
		drive: async (c) => {
			c.clickType('div', 3); // radio "b" renders as a clickable div
			await c.pump();
		},
		expect: (p) => p.includes('g=b'),
	},
	{
		name: 'bindsize',
		drive: async (c) => {
			await c.pump(8); // ResizeObserver-lite polls on a 100ms interval
		},
		expect: (p) => p.includes('w=300'),
	},
	{ name: 'bindinner', expect: (p) => p.includes('inner-injected') },
	{
		name: 'windowkey',
		drive: async (c) => {
			c.type('x');
			await c.pump();
		},
		expect: (p) => p.includes('key:x'),
	},
	{ name: 'rawsnippet', expect: (p) => p.includes('raw-snippet-out') },
	{
		name: 'formdata',
		drive: async (c) => {
			c.clickText('collect');
			await c.pump();
		},
		expect: (p) => p.includes('a=1') && p.includes('b=2') && p.includes('extra=E'),
	},
	{
		name: 'scroll',
		drive: async (c) => {
			// wheel-scroll inside the tall container
			renderer.simulateScrollWheel(30, 30, 0, -60);
			await c.pump();
		},
		expect: (p) => p.includes('scrolled=') && !p.includes('scrolled=0'),
	},
	{
		name: 'htmlupdate',
		drive: async (c) => {
			c.clickText('swap-html');
			await c.pump();
		},
		expect: (p) => p.includes('new-html') && !p.includes('old-html'),
	},
	{ name: 'entities', expect: (p) => p.includes('a & b') && !p.includes('&amp;') },
	{
		name: 'stylecss',
		expect: (_p, ctx) => {
			// scoped .box{height:50px} must reach real native layout
			const walk = (n: any): boolean =>
				(n.bounds?.height === 50 && JSON.stringify(n).includes('styled-text')) ||
				(n.children ?? []).some(walk);
			return walk(JSON.parse(ctx.tree()));
		},
	},
	{
		name: 'preventdef',
		drive: async (c) => {
			c.clickType('div', 1); // [mount-root, checkbox-div, c=div]
			await c.pump();
		},
		expect: (p) => p.includes('c=false'),
	},
	{ name: 'clickmethod', drive: async (c) => c.pump(), expect: (p) => p.includes('c=true') },
	{ name: 'currenttarget', expect: (p) => p.includes('ct=ok') },
	{ name: 'selectbind', expect: (p) => p.includes('v=a') },
	{ name: 'customelem', expect: (p) => p.includes('ce-inner') },
	{ name: 'defaultval', expect: (p) => p.includes('d=preset') },
	{ name: 'unmount', expect: (p) => p.includes('unmount-me') },
];

const results: [string, string][] = [];
for (const c of cases) {
	const target = doc.createElement('div');
	doc.body.appendChild(target);
	materializeRoot(target);
	try {
		const mod = await import(`./gen/cases/${c.name.replace(/-.*$/, '')}.js`);
		const app = mount(mod.default, { target });
		await sleep(20);
		flush();
		renderer.flush();
		drainAfterRender();
		const ctx: Ctx = {
			painted,
			clickText,
			clickType,
			type: (k) => renderer.simulateKeystrokes(k),
			pump,
			tree: () => renderer.getAutomationTree(),
		};
		if (c.drive) await c.drive(ctx);
		const ok = c.expect(painted(), ctx);
		results.push([c.name, ok === true ? 'PASS' : `FAIL (${ok})`]);
		await unmount(app).catch(() => {});
	} catch (e) {
		results.push([c.name, `ERROR ${String(e).split('\n')[0].slice(0, 120)}`]);
	}
	target.remove(); // dematerialize the case's tree before the next mount
}

console.log('\n=== CONFORMANCE ===');
for (const [n, r] of results) console.log(`${r === 'PASS' ? '✅' : '❌'} ${n.padEnd(24)} ${r}`);
console.log(`${results.filter(([, r]) => r === 'PASS').length}/${results.length} pass`);
process.exit(0);
