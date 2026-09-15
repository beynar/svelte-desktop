/**
 * Conformance on the QuickGUI backend — headless.
 * Same case fixtures as conformance.ts; drivers synthesize events by invoking
 * the wired NativeNode listeners (the same callbacks the Rust core calls in a
 * live window), and assertions read the retained NativeNode tree.
 *
 * Genuinely unsupported here vs gpuix-TestRenderer: no layout readback (no
 * bounds/scroll APIs on the JS host) → bindsize/scroll/stylecss get property
 * assertions instead of pixel/bounds assertions.
 */
import { NativeNodeTag, PropertyCode, type NativeNode } from '@quickgui/native';
import { installGlobals, doc, materializeRoot } from './gdom';
import { setRenderer, flush, drainAfterRender } from './native';
import { QuickguiSink, createHeadlessRoot, dispatchQgEvent } from './qg-backend';

installGlobals();
const { root, host, ops } = createHeadlessRoot();
const sink = new QuickguiSink(root);
setRenderer(sink as never);

const { mount, unmount } = await import('../node_modules/svelte/src/index-client.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pump(times = 1) {
	for (let i = 0; i < times; i++) {
		await sleep(30);
		flush();
		drainAfterRender();
	}
}

const painted = () => sink.getPaintedText().join('|');
const tree = () => sink.getAutomationTree();

/** DFS walk of the retained NativeNode tree (skips the root itself). */
function* walk(n: NativeNode): Generator<NativeNode> {
	for (const c of n.children) {
		yield c;
		yield* walk(c);
	}
}

/** deepest non-Text element containing a Text node with `text` (hit-test
 *  lands on the innermost node, not the mount-root ancestor). */
function findByText(text: string): NativeNode {
	let best: NativeNode | undefined;
	let bestDepth = -1;
	const depth = (n: NativeNode) => {
		let d = 0;
		for (let p = n.parent; p; p = p.parent) d++;
		return d;
	};
	for (const n of walk(root)) {
		if (n.tag === NativeNodeTag.Text) continue;
		for (const d of walk(n)) {
			if (d.tag === NativeNodeTag.Text && d.text.includes(text)) {
				const dd = depth(n);
				if (dd > bestDepth) {
					best = n;
					bestDepth = dd;
				}
				break;
			}
		}
	}
	if (!best) throw new Error(`findByText: nothing containing "${text}"`);
	return best;
}

function nthByTag(tag: 'div' | 'input' | 'button', nth: number): NativeNode {
	const want = tag === 'input' ? NativeNodeTag.Input : tag === 'button' ? NativeNodeTag.Button : NativeNodeTag.View;
	const hits = [...walk(root)].filter((n) => n.tag === want);
	const hit = hits[nth];
	if (!hit) throw new Error(`nthByTag: no ${tag} #${nth} (${hits.length} found)`);
	return hit;
}

interface Ctx {
	painted: () => string;
	tree: () => string;
	clickText: (t: string) => void;
	clickType: (t: 'div' | 'input' | 'button', nth?: number) => void;
	type: (keys: string) => void;
	pump: (n?: number) => Promise<void>;
}

// root View counts as the first 'div' in clickType ordering (gpuix's window
// root did the same) — indices stay aligned with the gpuix runner.
const ctx: Ctx = {
	painted,
	tree,
	clickText: (t) => dispatchQgEvent(sink, findByText(t).id, 'click'),
	clickType: (t, nth = 0) => dispatchQgEvent(sink, nthByTag(t, nth).id, 'click'),
	type: (keys) => {
		// focused input → per-edit 'input' event with the new full value
		const input =
			(sink.lastFocused != null && sink.nodes.get(sink.lastFocused)?.tag === NativeNodeTag.Input
				? sink.nodes.get(sink.lastFocused)
				: undefined) ?? [...walk(root)].find((n) => n.tag === NativeNodeTag.Input);
		if (input) {
			const cur = (input.properties.get(PropertyCode.Value) as string) ?? '';
			dispatchQgEvent(sink, input.id, 'input', cur + keys);
		} else {
			// no input → treat as a window-level key (root keydown listener)
			for (const k of keys) dispatchQgEvent(sink, root.id, 'keydown', k);
		}
	},
	pump,
};

const cases: { name: string; drive?: (c: Ctx) => Promise<void>; expect: (p: string, c: Ctx) => boolean | string }[] = [
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
		expect: (p, c) => c.tree().includes('"type":"input"'),
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
			c.clickType('div', 2); // [root, mount-root, checkbox-div]
			await c.pump();
		},
		expect: (p) => p.includes('c=true'),
	},
	{
		name: 'bindgroup',
		drive: async (c) => {
			c.clickType('div', 3); // [root, mount-root, radio-a, radio-b]
			await c.pump();
		},
		expect: (p) => p.includes('g=b'),
	},
	{
		// no layout readback API on the quickgui JS host — assert the intent
		// reached the native tree instead of the (impossible) painted result.
		name: 'bindsize',
		drive: async (c) => {
			await c.pump(8);
		},
		expect: (_p) =>
			[...walk(root)].some(
				(n) => n.properties.get(PropertyCode.Width) === 300,
			) || 'no node with width=300 (layout readback unsupported)',
	},
	{ name: 'bindinner', expect: (p) => p.includes('inner-injected') },
	{
		name: 'windowkey',
		drive: async (c) => {
			c.type('x'); // no input in this case → root keydown
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
		// scroll events exist ('wheel') but no scroll-offset readback → the
		// handler fires; the offset stays 0. Asserting the event path, not px.
		name: 'scroll',
		drive: async (c) => {
			const scrollable = [...walk(root)].find((n) => n.listeners.has('wheel'));
			if (!scrollable) throw new Error('no wheel listener wired');
			dispatchQgEvent(sink, scrollable.id, 'wheel', '0,-60');
			await c.pump();
		},
		expect: (p) => p.includes('scrolled=') || 'no scroll handler output',
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
		// scoped .box{height:50px} → the node's Height property on the native tree
		name: 'stylecss',
		expect: (_p) =>
			[...walk(root)].some(
				(n) =>
					n.properties.get(PropertyCode.Height) === 50 &&
					[...walk(n)].some((d) => d.tag === NativeNodeTag.Text && d.text.includes('styled-text')),
			) || 'no node with Height=50 over styled-text',
	},
	{
		name: 'preventdef',
		drive: async (c) => {
			c.clickType('div', 1);
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
		drainAfterRender();
		if (c.drive) await c.drive(ctx);
		const ok = c.expect(painted(), ctx);
		results.push([c.name, ok === true ? 'PASS' : `FAIL (${ok})`]);
		await unmount(app).catch(() => {});
	} catch (e) {
		results.push([c.name, `ERROR ${String(e).split('\n')[0].slice(0, 120)}`]);
	}
	target.remove();
}

console.log('\n=== CONFORMANCE (quickgui backend, headless) ===');
for (const [n, r] of results) console.log(`${r === 'PASS' ? '✅' : '❌'} ${n.padEnd(24)} ${r}`);
console.log(`${results.filter(([, r]) => r === 'PASS').length}/${results.length} pass`);
const interesting = ops.slice(-30);
console.log('\nlast host ops:', interesting.length ? interesting.join(', ') : '(none)');
process.exit(0);
