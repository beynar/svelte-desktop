/**
 * Kit-layer conformance: load chains, hooks, navigation, error boundaries —
 * asserted against painted text and router state via the real gpuix renderer.
 * Run: bun run build && bun src/kit-conformance.ts
 */
import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot } from './gdom';
import { setRenderer, flush, drainAfterRender } from './native';

installGlobals();
const renderer = new TestGpuixRenderer(640, 3200);
setRenderer(renderer as any);

const { state: hookState } = await import('./hooks.ts');
const kit = await import('./gen/kit/index.js');
const { page, navigating } = kit;
const { startKit } = await import('./kit-app.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pump(times = 6) {
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

function painted() {
	return renderer.getPaintedText().join(' | ');
}
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
	if (!hit) throw new Error(`clickText: no "${text}"`);
	renderer.simulateClick(hit.x, hit.y);
}

const target = doc.createElement('div');
doc.body.appendChild(target);
materializeRoot(target);
const router = await startKit(target, '/');
await pump();

type Case = { name: string; run: () => Promise<void> | void; expect: (p: string) => boolean; state?: () => boolean };
const cases: Case[] = [
	{
		name: 'boot: layout+page loads, handle+locals, parent(), event.data',
		expect: (p) =>
			p.includes('user:arnaud') && // universal +layout.ts
			p.includes('server-user:from-hook') && // handle → locals → +layout.server.ts
			p.includes('hello arnaud') && // parent() in +page.ts
			/notes-in-db:\d+/.test(p) && // +page.server.ts → bun:sqlite
			/via-data:\d+/.test(p), // event.data in universal load
		run: () => {},
		state: () => hookState.handled === 1, // handle wrapped the nav ONCE
	},
	{
		name: 'link interception: <a href> → goto',
		run: () => clickText('item 7'),
		expect: (p) => p.includes('item 7 → doubled 14 (param 7)') && p.includes('app chrome'),
	},
	{
		name: 'goto() from a component',
		run: async () => {
			await clickText('← home');
			await pump();
			clickText('goto /item/42');
		},
		expect: (p) => p.includes('item 42 → doubled 84'),
	},
	{
		name: 'redirect() in load',
		run: async () => kit.goto('/item/0'),
		expect: (p) => p.includes('hello arnaud') && page.url.pathname === '/',
	},
	{
		name: 'layout persists local state across navigation',
		run: () => clickText('layout-clicks'),
		expect: (p) => p.includes('layout-clicks:1'),
	},
	{
		name: 'invalidate(key) re-runs matching depends() only',
		run: async () => {
			const beforeN = /n=(\d+)/.exec(painted())?.[1];
			const beforeLayout = hookState.layoutLoads;
			clickText('reload home load');
			await pump();
			const afterN = /n=(\d+)/.exec(painted())?.[1];
			if (Number(afterN) !== Number(beforeN) + 1)
				throw new Error(`page load did not rerun exactly once (n ${beforeN}→${afterN})`);
			if (hookState.layoutLoads !== beforeLayout)
				throw new Error('layout server load reran despite no matching depends()');
		},
		expect: (p) => p.includes('layout-clicks:1') && p.includes('user:arnaud'),
	},
	{
		name: 'expected error() → nearest +error.svelte inside layout',
		run: async () => kit.goto('/boom'),
		expect: (p) => p.includes('error 418: teapot') && p.includes('app chrome'),
		state: () => page.status === 418 && hookState.errors.length === 0, // expected errors skip handleError
	},
	{
		name: 'unexpected throw → handleError + 500 boundary',
		run: async () => kit.goto('/crash'),
		expect: (p) => p.includes('error 500: kaboom'),
		state: () => hookState.errors.some((m) => m.includes('kaboom')),
	},
	{
		name: '404 for unmatched route',
		run: async () => kit.goto('/nope'),
		expect: (p) => p.includes('error 404') && p.includes('not found: /nope'),
	},
	{
		name: 'handleFetch intercepts; +server.ts endpoint resolves',
		run: async () => kit.goto('/fetch'),
		expect: (p) => p.includes('who:handleFetch') && p.includes('time:endpoint'),
	},
	{
		name: 'beforeNavigate can cancel',
		run: async () => {
			const off = kit.beforeNavigate((n: any) => {
				if (n.to?.url.pathname === '/about') n.cancel();
			});
			await kit.goto('/about');
			off();
		},
		expect: (p) => p.includes('who:handleFetch'), // still on /fetch
	},
	{
		name: 'navigating + afterNavigate fire with to/from',
		run: async () => {
			let seen: any = null;
			const off = kit.afterNavigate((n: any) => (seen = n));
			await kit.goto('/about');
			off();
			if (!seen || seen.to.url.pathname !== '/about' || seen.from.url.pathname !== '/fetch')
				throw new Error('afterNavigate payload wrong: ' + JSON.stringify(seen));
		},
		expect: (p) => p.includes('about — no load') && navigating.to === null,
	},
	{
		name: 'back() pops history',
		run: async () => kit.back(),
		expect: (p) => p.includes('who:handleFetch') || p.includes('error'), // previous entry
	},
	{
		name: '[...rest] param captures slashes',
		run: async () => kit.goto('/rest/a/b/c'),
		expect: (p) => p.includes('rest — a/b/c'),
	},
	{
		name: '[[optional]] param matches with and without value',
		run: async () => {
			await kit.goto('/opt');
			await pump(2);
			if (!painted().includes('opt — absent')) throw new Error('bare /opt did not match');
			await kit.goto('/opt/x');
		},
		expect: (p) => p.includes('opt — x'),
	},
	{
		name: '[param=matcher] constrains the route',
		run: async () => {
			await kit.goto('/hex/deadbeef');
			await pump(2);
			if (!painted().includes('hex — deadbeef')) throw new Error('hex match failed');
			await kit.goto('/hex/xyz'); // matcher rejects → 404
		},
		expect: (p) => p.includes('error 404'),
	},
	{
		name: '(group) segments: layout applies, no url segment',
		run: async () => kit.goto('/gpage'),
		expect: (p) =>
			p.includes('group-layout') && p.includes('gpage — grouped route') && page.url.pathname === '/gpage',
	},
	{
		name: 'form action: default + ?/named → page.form',
		run: async () => {
			await kit.goto('/action');
			await pump();
			clickText('submit default');
			await pump();
			clickText('submit named');
		},
		expect: (p) => p.includes('form:named:named-note'),
	},
	{
		name: 'action fail() → form prop + status, no rerun',
		run: () => clickText('submit bad'),
		expect: (p) => p.includes('invalid-input'),
		state: () => page.status === 400,
	},
	{
		name: 'action redirect() → navigates',
		run: () => clickText('submit away'),
		expect: (p) => p.includes('about — no load'),
	},
	{
		name: 'use:enhance intercepts and still applies result',
		run: async () => {
			await kit.goto('/action');
			await pump();
			clickText('submit enhanced');
		},
		expect: (p) => p.includes('enhanced:enhanced-note') && p.includes('form:named:enhanced-note'),
	},
	{
		name: 'streaming: promise fields resolve in-place; transport round-trips',
		run: async () => kit.goto('/stream'),
		expect: (p) => p.includes('streamed!') && p.includes('price:1234'),
	},
	{
		name: 'pushState → page.state + url, shallow back() restores',
		run: async () => {
			await kit.goto('/shallow');
			await pump();
			clickText('push shallow state');
			await pump();
			if (!painted().includes('tab:2') || !page.url.search.includes('tab=2'))
				throw new Error('shallow state not applied: ' + painted().slice(0, 160));
			await kit.back();
		},
		expect: (p) => p.includes('tab:none') && page.url.search === '',
	},
	{
		name: 'preloadData runs loads without navigating',
		run: async () => {
			await kit.goto('/preload');
			await pump();
			clickText('preload /item/9');
		},
		expect: (p) => p.includes('preloaded:loaded:9:200') && page.url.pathname === '/preload',
	},
	{
		name: 'navigation coalescing: superseded nav abandoned',
		run: async () => {
			const slow = kit.goto('/slow');
			await kit.goto('/about');
			await slow;
			await pump(3); // let /slow's chain settle — it must not commit
		},
		expect: (p) => p.includes('about — no load') && !p.includes('slow — done'),
	},
	{
		name: 'reroute hook maps /legacy → /about',
		run: async () => kit.goto('/legacy'),
		expect: (p) => p.includes('about — no load') && page.url.pathname === '/legacy',
	},
	{
		name: '$app/paths resolve + $app/environment + updated + deserialize',
		run: () => {
			if (kit.resolve('/item/[id]', { id: '7' }) !== '/item/7') throw new Error('resolve param');
			if (kit.resolve('/opt/[[opt]]', {}) !== '/opt') throw new Error('resolve optional');
			if (!kit.browser || kit.building) throw new Error('environment flags');
			if (kit.updated.current !== false) throw new Error('updated.current');
			const r = kit.deserialize('{"type":"success","status":200,"data":{"x":1}}');
			if (r.data.x !== 1) throw new Error('deserialize');
		},
		expect: () => true,
	},
	{
		name: 'onNavigate: cb before nav, returned fn after',
		run: async () => {
			const order = [];
			const off = kit.onNavigate((n) => {
				order.push('before:' + n.to?.url.pathname);
				return () => order.push('after');
			});
			await kit.goto('/');
			off();
			if (order.join(',') !== 'before:/,after') throw new Error('order: ' + order.join(','));
		},
		expect: (p) => p.includes('hello arnaud'),
	},
	{
		name: '$app/server: cookies, getClientAddress, getRequestEvent, read',
		run: async () => kit.goto('/serverside'),
		expect: (p) =>
			p.includes('session:none') &&
			p.includes('ip:127.0.0.1') &&
			p.includes('ev:from-hook') &&
			p.includes('read:handle') &&
			p.includes('rq:from-hook'), // remote fn ran through handle, saw locals
	},
	{
		name: 'cookies.set in action → persists across the rerun load',
		run: () => clickText('set cookie'),
		expect: (p) => p.includes('session:abc'),
	},
	{
		name: 'refreshAll re-runs loads (and remote queries)',
		run: async () => {
			const before = /loads:(\d+)/.exec(painted())?.[1];
			clickText('refreshAll');
			await pump();
			const after = /loads:(\d+)/.exec(painted())?.[1];
			if (Number(after) !== Number(before) + 1)
				throw new Error(`loads ${before}→${after}`);
		},
		expect: (p) => p.includes('session:abc'),
	},
	{
		name: 'disableScrollHandling + json/text/asset + goto opts',
		run: async () => {
			kit.disableScrollHandling();
			if ((await kit.json({ a: 1 })).status !== 200) throw new Error('json()');
			if ((await kit.text('hi')).status !== 200) throw new Error('text()');
			if (kit.asset('/x.png') !== '/x.png') throw new Error('asset()');
			await kit.goto('/item/5', { state: { from: 'goto' }, invalidateAll: true });
			if (page.state.from !== 'goto') throw new Error('goto state opt');
		},
		expect: (p) => p.includes('item 5 → doubled 10'),
	},
	// ── adversarial-review regressions ─────────────────────────────────────
	{
		name: 'cancelled nav does not kill an in-flight nav; navigating clears',
		run: async () => {
			const off = kit.beforeNavigate((n) => {
				if (n.to?.url.pathname === '/about') n.cancel();
			});
			const p1 = kit.goto('/slow');
			await sleep(20); // /slow is mid-load
			await kit.goto('/about'); // cancelled — must NOT supersede /slow
			off();
			await p1;
			if (page.url.pathname !== '/slow') throw new Error('slow nav dropped: ' + page.url.pathname);
			if (navigating.to !== null) throw new Error('navigating stuck after cancel');
		},
		expect: (p) => p.includes('slow — done'),
	},
	{
		name: 'history: back() restores url incl. search + popped state',
		run: async () => {
			await kit.goto('/item/5?tab=2');
			await kit.goto('/about');
			await kit.back();
			if (page.url.search !== '?tab=2') throw new Error('search lost: ' + page.url.href);
		},
		expect: (p) => p.includes('item 5') && p.includes('tab:2'),
	},
	{
		name: 'uses tracking: searchParams read reruns on search-only change',
		run: async () => {
			await kit.goto('/item/5?tab=9'); // same route+params, only search changed
		},
		expect: (p) => p.includes('tab:9'),
	},
	{
		name: 'event.fetch: Request passthrough + endpoint error()→Response + full epEvent',
		run: async () => {
			await kit.goto('/dep');
		},
		expect: (p) =>
			p.includes('runs:1') &&
			p.includes('time:endpoint') &&
			p.includes('post:hi-body') && // POST body survived event.fetch
			p.includes('fail:418') && // endpoint error(418) → Response, not a throw
			p.includes('session:abc'), // endpoint sees the committed cookie jar
	},
	{
		name: 'invalidate(url) matches recorded fetch hrefs; predicate form works',
		run: async () => {
			await kit.invalidate('/api/time');
			await pump();
			if (!/runs:2/.test(painted())) throw new Error('invalidate(/api/time) did not rerun');
			await kit.invalidate((u) => u.pathname === '/api/time');
			await pump();
			if (!/runs:3/.test(painted())) throw new Error('predicate invalidate did not rerun');
		},
		expect: (p) => p.includes('runs:3'),
	},
	{
		name: 'GET form submits as navigation, not an action',
		run: async () => {
			await kit.goto('/action');
			await pump();
			clickText('submit get');
			await pump();
			if (page.url.pathname !== '/item/7' || page.url.search !== '?q=needle')
				throw new Error('GET form nav: ' + page.url.href);
		},
		expect: (p) => p.includes('item 7'),
	},
	{
		name: 'submitter name/value reaches formData',
		run: async () => {
			await kit.goto('/action');
			await pump();
			clickText('intent b');
		},
		expect: (p) => p.includes('form:intent:b'),
	},
	{
		name: 'use:enhance result callback gets update()',
		run: async () => {
			clickText('submit upd');
		},
		expect: (p) => p.includes('enhanced-update') && p.includes('form:named:upd-note'),
	},
	{
		name: 'remote form(): spread props dispatch to the remote fn',
		run: async () => {
			clickText('submit remote');
		},
		expect: (p) => p.includes('rf:ok:rf-note'),
	},
	{
		name: 'remote query()/command() are kit-shaped callables',
		run: async () => {
			const remote = await import('./gen/remote.js');
			const r = remote.query(() => 'val')();
			if (typeof r.then !== 'function') throw new Error('resource not thenable');
			if ((await r) !== 'val') throw new Error('await resource failed');
			if (r.current !== 'val') throw new Error('current');
			const c = remote.command((x) => x * 2);
			if (typeof c !== 'function') throw new Error('command not callable');
			if ((await c(21)) !== 42) throw new Error('command result');
			if (c.pending !== false) throw new Error('pending');
		},
		expect: () => true,
	},
	{
		name: 'cross-page action runs the target route action then navigates',
		run: async () => {
			await kit.goto('/');
			await pump();
			clickText('cross-page post');
			await pump();
			if (page.url.pathname !== '/action') throw new Error('did not land on /action: ' + page.url.pathname);
		},
		expect: (p) => p.includes('action — form:none'),
	},
	{
		name: 'page.form resets on navigation',
		run: async () => {
			await kit.goto('/action');
			await pump();
			clickText('submit default');
			await pump();
			if (page.form == null) throw new Error('form missing after submit');
			await kit.goto('/about');
			if (page.form !== null) throw new Error('form leaked across nav');
		},
		expect: (p) => p.includes('about — no load'),
	},
	{
		name: 'hash-only nav updates url without rerunning loads',
		run: async () => {
			const handled = hookState.handled;
			await kit.goto('/about#frag');
			if (page.url.hash !== '#frag') throw new Error('hash lost: ' + page.url.href);
			if (hookState.handled !== handled) throw new Error('loads reran on hash nav');
		},
		expect: (p) => p.includes('about — no load'),
	},
	{
		name: 'navigating.complete is a promise that resolves',
		run: async () => {
			const g = kit.goto('/item/9');
			const c = navigating.complete;
			if (!(c instanceof Promise)) throw new Error('no complete promise');
			await g;
			await c;
		},
		expect: (p) => p.includes('item 9'),
	},
	{
		name: '404 sets page.route.id = null',
		run: async () => {
			await kit.goto('/definitely-missing');
			if (page.route.id !== null) throw new Error('route.id: ' + page.route.id);
			if (page.status !== 404) throw new Error('status: ' + page.status);
		},
		expect: (p) => p.includes('404'),
	},
	{
		name: 'resolve() embedded params + $app/paths match()',
		run: async () => {
			if (kit.resolve('/file-[name].json', { name: 'x' }) !== '/file-x.json') throw new Error('embedded');
			if (kit.resolve('/item/[id]?tab=2', { id: '5' }) !== '/item/5?tab=2') throw new Error('query kept');
			if (kit.resolve('plain', { x: 1 }) !== 'plain') throw new Error('non-/ passthrough');
			const m = await kit.match('/item/9');
			if (m?.id !== '/item/[id]' || m.params.id !== '9') throw new Error('match()');
		},
		expect: () => true,
	},
	{
		name: 'getRequestEvent() works inside handle; server parent() sees server data only',
		run: async () => {
			await kit.goto('/');
		},
		expect: (p) => p.includes('psv:none') && p.includes('psrv:from-hook') && p.includes('hello arnaud'),
		state: () => hookState.greInHandle === true,
	},
];

let pass = 0;
for (const c of cases) {
	try {
		await c.run();
		await pump();
		const p = painted();
		if (!c.expect(p)) throw new Error('painted: ' + p.slice(0, 220));
		if (c.state && !c.state()) throw new Error('state check failed');
		console.log(`ok   ${c.name}`);
		pass++;
	} catch (e) {
		console.log(`FAIL ${c.name}: ${String(e).split('\n')[0]}`);
	}
}
console.log(`\n${pass}/${cases.length} kit cases pass`);
process.exit(pass === cases.length ? 0 : 1);
