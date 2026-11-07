/**
 * Multi-window probe — the M3 acceptance gate.
 *
 *   create → mount → paint → element ops → events → close → clean exit
 *
 * Boots the real window (id 0), then through the platform surface:
 *   1. `windows.create({label})` → second native window (id 1)
 *   2. `windows.list`/`get` reflect it; `created` event fires
 *   3. `createWindowRoot(windowId)` + gdom subtree → `setRoot id w` paints it
 *   4. Secondary-window element ops: bounds, focus, simulated clicks —
 *      all routed to the owning window, events stamped with `windowId`
 *   5. `emitTo`/`onWindow` scoping (incl. window 0) + error paths:
 *      duplicate label, non-positive size, fractional/dead windowId
 *   6. `windows.close(id)` → `closed {windowId}` + registry teardown;
 *      primary window closes → exit 0
 *
 * `bun packages/tests/probe-multiwindow.ts`
 */
const T0 = performance.now();
const log = (label: string, extra = '') =>
	console.log(`[${(performance.now() - T0).toFixed(0)}ms] ${label}${extra ? ' — ' + extra : ''}`);

const failures: string[] = [];
const check = (name: string, cond: boolean, detail = '') => {
	console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
	if (!cond) failures.push(name);
};
// A platform call that must reject — returns the error code on success.
const rejects = async (name: string, code: string, p: Promise<unknown>) => {
	try {
		await p;
		check(`${name} rejects`, false, 'resolved instead');
	} catch (e: any) {
		check(`${name} rejects ${code}`, e?.code === code, `got ${e?.code}: ${e?.message}`);
	}
};

const { GpuixRenderer } = await import('@gpuix/native');
const {
	installGlobals,
	doc,
	materializeRoot,
	setViewport,
	dispatchPayload,
	createWindowRoot,
} = await import('@svelte-desktop/gpuix/gdom');
const { setRenderer, flush, drainAfterRender } = await import('@svelte-desktop/gpuix/native');
const { initPlatform, windows, onWindow, onPlatform, emitTo } = await import(
	'@svelte-desktop/platform'
);

installGlobals();
const renderer = new GpuixRenderer((err: unknown, payload: unknown) => {
	if (!err) dispatchPayload(payload);
});
setRenderer(renderer);
initPlatform(renderer);

// ── primary window ──────────────────────────────────────────────────
renderer.init({ title: 'probe primary', width: 800, height: 600 });
setViewport(800, 580);
const primary = doc.createElement('div');
primary.setAttribute(
	'style',
	'display:flex;width:800px;height:580px;background:#1a1a2e',
);
primary.setAttribute('tabindex', '0');
primary.textContent = 'primary window';
doc.body.appendChild(primary);
materializeRoot(primary);
flush();
log('primary mounted');

// element-event windowId evidence: clicks report their owning window
const seenWindowIds = new Set<number>();
primary.addEventListener('click', (ev: any) => seenWindowIds.add(ev.windowId ?? -1));

// ── tick loop ───────────────────────────────────────────────────────
let running = true;
const loop = () => {
	running = renderer.tick();
	drainAfterRender();
	if (running) setImmediate(loop);
};
loop();

// give the primary window a moment to settle, then the create→paint→close flow
await new Promise((r) => setTimeout(r, 300));

// ── 1. create ───────────────────────────────────────────────────────
let createdEvent: any = null;
const offCreated = onPlatform('created', (data: any) => {
	createdEvent = data;
});
const created = await windows.create({
	label: 'secondary',
	title: 'probe secondary',
	width: 420,
	height: 320,
});
log('windows.create', JSON.stringify(created));
check('create returns a new windowId', created.windowId === 1, `windowId=${created.windowId}`);
check('create returns the label', created.label === 'secondary');
await new Promise((r) => setTimeout(r, 60));
check(
	'created event carries {windowId,label}',
	createdEvent?.windowId === 1 && createdEvent?.label === 'secondary',
	JSON.stringify(createdEvent),
);

// ── 2. list / get ───────────────────────────────────────────────────
let list = await windows.list();
check(
	'list has both windows',
	list.length === 2,
	JSON.stringify(list.map((w: any) => w.windowId)),
);
const got = await windows.get('secondary');
check('get(label) resolves', got?.windowId === created.windowId, JSON.stringify(got));

// ── 3. mount + paint ────────────────────────────────────────────────
const winRoot = createWindowRoot(created.windowId);
const content = doc.createElement('div');
content.setAttribute(
	'style',
	'display:flex;width:420px;height:320px;background:#16213e;color:#fff',
);
content.setAttribute('tabindex', '0');
content.textContent = 'secondary window';
winRoot.appendChild(content);
content.addEventListener('click', (ev: any) => seenWindowIds.add(ev.windowId ?? -1));
flush();
log('secondary mounted', `windowRoot id=${(winRoot as any).nativeId}`);
await new Promise((r) => setTimeout(r, 150)); // let it paint bounds

// window-scoped op through the windowId route: title should set on win 1
await windows.setTitle('probe secondary (retitled)', created.windowId).catch(() => null);

// ── 4. element ops route to the owning window ───────────────────────
const contentId = (content as any).nativeId as number;
const bounds = renderer.getElementBounds(contentId);
check(
	'secondary element has bounds (window 1 paint)',
	bounds != null && Math.abs(bounds.width - 420) < 2,
	JSON.stringify(bounds),
);

// focus a secondary element — element-scoped op resolves window 1.
// `getFocusedElementId` reports the KEY window's focused element, so the
// secondary (created focused) answers until window 0 is made key again.
renderer.focusElement(contentId);
await new Promise((r) => setTimeout(r, 60));
check(
	'secondary element takes focus',
	renderer.getFocusedElementId() === contentId,
	`focused=${renderer.getFocusedElementId()}`,
);
const primaryId = (primary as any).nativeId as number;
await windows.focus(0);
renderer.focusElement(primaryId);
await new Promise((r) => setTimeout(r, 60));
check(
	'primary element takes focus once window 0 is key',
	renderer.getFocusedElementId() === primaryId,
	`focused=${renderer.getFocusedElementId()}`,
);

// real clicks through the gpui hit test — explicit windowId targeting
renderer.simulateClick(400, 290, 0, null, 0);
renderer.simulateClick(210, 160, 0, null, created.windowId);
await new Promise((r) => setTimeout(r, 120));
check(
	'click in primary stamps windowId 0',
	seenWindowIds.has(0),
	`seen=${JSON.stringify([...seenWindowIds])}`,
);
check(
	'click in secondary stamps windowId 1',
	seenWindowIds.has(created.windowId),
	`seen=${JSON.stringify([...seenWindowIds])}`,
);

// ── 5. emitTo / onWindow ────────────────────────────────────────────
let onWindowHits = 0;
const unsub = onWindow(created.windowId, 'probeEvent', (data: any) => {
	if (data?.windowId === created.windowId) onWindowHits++;
});
let primaryWindowHits = 0;
const unsubPrimary = onWindow(0, 'probePrimary', () => primaryWindowHits++);
emitTo(created.windowId, 'probeEvent', { hello: 'world' });
emitTo(0, 'probeEvent', { hello: 'wrong window' });
emitTo(0, 'probePrimary', { hello: 'primary' });
emitTo(created.windowId, 'probePrimary', { hello: 'wrong window' });
await new Promise((r) => setTimeout(r, 60));
check('onWindow receives emitTo for its window', onWindowHits === 1, `hits=${onWindowHits}`);
check('onWindow(0) receives emitTo(0)', primaryWindowHits === 1, `hits=${primaryWindowHits}`);
unsub();
unsubPrimary();

// ── 6. error paths stay truthful ────────────────────────────────────
await rejects('duplicate label create', 'invalid_args', windows.create({ label: 'secondary' }));
await rejects('negative width create', 'invalid_args', windows.create({ width: -50, height: 100 }));
await rejects('zero height create', 'invalid_args', windows.create({ width: 100, height: 0 }));
await rejects('fractional windowId setTitle', 'invalid_args', windows.setTitle('x', 1.9));
await rejects('dead windowId setTitle', 'unavailable', windows.setTitle('x', 999));
await rejects('dead windowId close', 'unavailable', windows.close(999));

// closed event armed before close so teardown is observable
let closedWindowId: number | null = null;
const offClosed = onPlatform('closed', (data: any) => {
	closedWindowId = data?.windowId ?? -2;
});

// ── 7. close ────────────────────────────────────────────────────────
await new Promise((r) => setTimeout(r, 200)); // let the secondary paint a few frames
await windows.close(created.windowId);
await new Promise((r) => setTimeout(r, 250));
log('windows.close returned');

check(
	'closed event carried windowId',
	closedWindowId === created.windowId,
	`got ${closedWindowId}`,
);
offClosed();

list = await windows.list();
check(
	'list drops the closed window',
	list.length === 1,
	JSON.stringify(list.map((w: any) => w.windowId)),
);
check('get(label) misses the closed window', (await windows.get('secondary')) === null);
check('secondary element ops are dead after close', renderer.getElementBounds(contentId) == null);

// a second create re-uses nothing — ids are monotonic
createdEvent = null;
const third = await windows.create({
	label: 'tertiary',
	title: 'probe tertiary',
	width: 300,
	height: 200,
});
check('re-create allocates a fresh id', third.windowId === 2, `windowId=${third.windowId}`);
await new Promise((r) => setTimeout(r, 60));
check(
	'created event fires for the new window',
	createdEvent?.windowId === 2 && createdEvent?.label === 'tertiary',
	JSON.stringify(createdEvent),
);
offCreated();
await windows.close(third.windowId);
await new Promise((r) => setTimeout(r, 150));

// ── 8. clean exit — closing the last window terminates the app ──────
// QuitMode::LastWindowClosed ends the process from inside `windows.close`
// — anything printed after this call never runs. The probe's success
// line therefore goes BEFORE the close; exit code 0 is the clean-exit
// signal itself.
console.log(
	failures.length === 0
		? `\nPROBE OK — create→mount→paint→element-ops→events→close; clean exit pending on primary close`
		: `\nPROBE FAILED — ${failures.join(', ')}`,
);
if (failures.length > 0) process.exit(1);
log('closing primary — process should exit cleanly from here');
await windows.close(0);
// Reaching this line means the app did NOT quit on last-window-close —
// give tick() a moment, then fail the probe.
await new Promise((r) => setTimeout(r, 1500));
console.error('PROBE FAILED — process still alive after last window closed');
process.exit(1);
