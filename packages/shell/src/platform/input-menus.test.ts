import { expect, test } from 'bun:test';
import { PlatformTransport, initPlatformForTests } from './bus';
import { clipboard, menu, webview } from './index';
import { toMenuItems } from './components/items.js';

function transport() {
	const t = new PlatformTransport();
	t.serve('notifications', 'responses', { ok: true, value: [] });
	initPlatformForTests(t);
	t.requests.length = 0;
	return t;
}

test('input callbacks are observational, include window identity and unsubscribe', async () => {
	const t = transport(), seen: unknown[] = [];
	const off = webview.onBeforeInput((event) => seen.push(event));
	await webview.setInputPolicy({ intercept: [{ key: 'k', modifiers: ['meta'] }], menuShortcuts: false }, 3);
	expect(t.requests.at(-1)?.args).toEqual({ windowId: 3, intercept: [{ key: 'k', modifiers: ['meta'] }], menuShortcuts: false });
	const event = { windowId: 3, type: 'keyDown', key: 'k', modifiers: ['meta'], isAutoRepeat: false, intercepted: true, keyCode: 40 };
	t.emit('beforeInput', event); off(); t.emit('beforeInput', event);
	expect(seen).toEqual([event]);
});

test('menu lifecycle subscriptions filter independent menus and unsubscribe', () => {
	const t = transport(), seen: string[] = [];
	const offOpen = menu.onWillShow('one', () => seen.push('open'));
	const offClose = menu.onDidClose('one', () => seen.push('close'));
	t.emit('menuWillShow', { id: 'two' }); t.emit('menuWillShow', { id: 'one' });
	t.emit('menuDidClose', { id: 'one' }); offOpen(); offClose();
	t.emit('menuWillShow', { id: 'one' }); t.emit('menuDidClose', { id: 'one' });
	expect(seen).toEqual(['open', 'close']);
});

test('multi-format clipboard publishes a single op and forwards read limits', async () => {
	const t = transport();
	const data = { text: 'hi', html: '<b>hi</b>', formats: { 'com.example.test': 'AAEC' }, files: ['/tmp/example'] };
	await clipboard.write(data);
	await clipboard.read({ formats: ['text/plain', 'com.example.test'], maxBytes: 32 });
	expect(t.requests.map(({ service, op, args }) => ({ service, op, args }))).toEqual([
		{ service: 'clipboard', op: 'write', args: data },
		{ service: 'clipboard', op: 'read', args: { formats: ['text/plain', 'com.example.test'], maxBytes: 32 } },
	]);
});

test('MenuBar and StatusItem preserve native selection and visibility fields', () => {
	const choice = { id: 'mode', label: 'Read', type: 'radio', group: 'mode', checked: true, visible: false, enabled: false, tooltip: 'Read mode', accelerator: 'Cmd+1' };
	expect(toMenuItems([choice]).specs).toEqual([choice]);
});
