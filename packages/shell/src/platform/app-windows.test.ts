import { afterEach, expect, test } from 'bun:test';
import { deliverPlatformEvent, initPlatformForTests } from './bus';
import { appLifecycle } from './app-lifecycle';
import { windowTransitions } from './windows-events';

type Request = { service: string; op: string; args: Record<string, unknown> };
const requests: Request[] = [];
const disposers: (() => void)[] = [];
function setup() {
	requests.length = 0;
	initPlatformForTests({ platformCall(raw) {
		requests.push(JSON.parse(raw));
		return '{"ok":true,"value":null}';
	} });
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
afterEach(() => disposers.splice(0).forEach((off) => off()));

test('quit guards answer only their own native snapshot and preserve request identity', async () => {
	setup();
	disposers.push(appLifecycle.onQuitRequested(async () => 'cancel'));
	await flush();
	const registration = requests.find((r) => r.op === 'subscribeQuit')!;
	deliverPlatformEvent('quitRequested', { requestId: 1, tokens: ['another-page'] });
	await flush();
	expect(requests.filter((r) => r.op === 'replyQuit')).toHaveLength(0);
	deliverPlatformEvent('quitRequested', { requestId: 2, reason: 'api', deadline: 2000, tokens: [registration.args.token] });
	await flush();
	expect(requests.at(-1)).toMatchObject({ service: 'app', op: 'replyQuit', args: { requestId: 2, phase: 'quitRequested', decision: 'cancel' } });
});

test('failed guards cancel; asynchronous completion hooks are awaited and cannot veto', async () => {
	setup();
	let finish!: () => void;
	disposers.push(appLifecycle.onBeforeQuit(() => new Promise<void>((resolve) => { finish = resolve; })));
	await flush();
	const token = requests.find((r) => r.op === 'subscribeQuit')!.args.token;
	deliverPlatformEvent('beforeQuit', { requestId: 4, tokens: [token] });
	await flush();
	expect(requests.filter((r) => r.op === 'replyQuit')).toHaveLength(0);
	finish();
	await flush();
	expect(requests.at(-1)).toMatchObject({ op: 'replyQuit', args: { decision: 'quit', phase: 'beforeQuit' } });
	// Invalid/undefined decisions must fail closed too.
	disposers.push(appLifecycle.onQuitRequested(() => { throw new Error('expected guard failure'); }));
	await flush();
	const guard = requests.filter((r) => r.op === 'subscribeQuit').at(-1)!;
	deliverPlatformEvent('quitRequested', { requestId: 5, tokens: [guard.args.token] });
	await flush();
	expect(requests.at(-1)).toMatchObject({ op: 'replyQuit', args: { decision: 'cancel' } });
});

test('disposing before transport readiness never installs a dangling guard', async () => {
	setup();
	const off = appLifecycle.onWillQuit(() => {});
	off();
	await flush();
	expect(requests.some((r) => r.op === 'subscribeQuit')).toBe(false);
	expect(requests.at(-1)?.op).toBe('unsubscribeQuit');
});

test('legacy observational willQuit backends keep existing parameterless listeners', async () => {
	setup();
	let calls = 0;
	disposers.push(appLifecycle.onWillQuit(() => { calls++; }));
	await flush();
	deliverPlatformEvent('willQuit', {});
	await flush();
	expect(calls).toBe(1);
	expect(requests.some((r) => r.op === 'replyQuit')).toBe(false);
});

test('window APIs carry explicit targets, null parent detachment and native event payloads', async () => {
	setup();
	await windowTransitions.setParent(0, 7);
	await windowTransitions.setParent(null, 7);
	await windowTransitions.getChildren(0);
	await windowTransitions.getLevel(7);
	await windowTransitions.getMaxSize();
	expect(requests.map(({ service, op, args }) => ({ service, op, args }))).toEqual([
		{ service: 'window', op: 'setParent', args: { parentId: 0, windowId: 7 } },
		{ service: 'window', op: 'setParent', args: { parentId: null, windowId: 7 } },
		{ service: 'window', op: 'getChildren', args: { windowId: 0 } },
		{ service: 'window', op: 'getLevel', args: { windowId: 7 } },
		{ service: 'window', op: 'getMaxSize', args: {} },
	]);
	const seen: unknown[] = [];
	const off = windowTransitions.on('fullscreenChanged', (event) => seen.push(event));
	deliverPlatformEvent('fullscreenChanged', { windowId: 7, fullscreen: false, transition: 'exited' });
	off();
	deliverPlatformEvent('fullscreenChanged', { windowId: 7, fullscreen: true, transition: 'entered' });
	expect(seen).toEqual([{ windowId: 7, fullscreen: false, transition: 'exited' }]);
});
