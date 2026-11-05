// What the framework draws, in a real window under Xvfb, with real keys (xdotool): axe-core fails on
// the tab bars, the panels and the lines between panes, and prints what belongs to the app.
// Run by e2e.sh from an example's directory, with A11Y_APP=panes or dashboard.
// Automated checks find part of the problems: the rest is test/a11y-manual-plan.md.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { launch, type AppHandle } from '@kitop/shell/test';

const name = process.env.A11Y_APP ?? 'panes';
const axeSource = await Bun.file(Bun.resolveSync('axe-core/axe.min.js', import.meta.dir)).text();

/** What the framework renders itself. A `tab`, `start` or `end` snippet's content, and the page in a panel, aren't. */
const OWNED = '[data-sd-tabbar], [data-sd-tabs], [data-sd-tablist], [data-sd-tablist] > [role=tab], [data-sd-tab-close], [data-sd-tab-new], [data-sd-splitter], [data-sd-panes], [data-sd-pane], [data-sd-pane-body], [data-sd-tabcontent], [data-sd-tabview]';
/** The app's: the framework paints no text or background, and the page's structure is the app's layout. */
const APP_RULES = ['color-contrast', 'region', 'landmark-one-main', 'landmark-main-is-top-level', 'landmark-no-duplicate-main', 'landmark-unique', 'page-has-heading-one'];

type Found = { rule: string; impact: string | null; owned: boolean; target: string; html: string; why: string };

const auditCode = `(async () => {
	if (!window.axe) (0, eval)(${JSON.stringify(axeSource)});
	const r = await axe.run(document, { resultTypes: ['violations'] });
	const owned = ${JSON.stringify(OWNED)}, app = ${JSON.stringify(APP_RULES)};
	return r.violations.flatMap((v) => v.nodes.map((n) => {
		let el = null;
		try { el = document.querySelector(n.target[0]); } catch {}
		return { rule: v.id, impact: v.impact, owned: !app.includes(v.id) && !!el?.matches(owned), target: n.target.join(' '), html: n.html.slice(0, 160), why: n.failureSummary };
	}));
})()`;

function verdict(where: string, found: Found[]) {
	for (const f of found.filter((f) => !f.owned)) console.log(`[a11y ${name}] app's, ${where}: ${f.rule} (${f.impact}) ${f.target}`);
	return found.filter((f) => f.owned);
}

let app: AppHandle;
const key = async (...keys: string[]) => {
	await Bun.$`xdotool key --clearmodifiers ${keys}`.quiet();
	await Bun.sleep(150);
};
const until = async (check: () => Promise<boolean>, what: string, ms = 10_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check().catch(() => false)) return;
		await Bun.sleep(40);
	}
	throw new Error(`timed out: ${what}`);
};
const tabs = () => app.eval<{ id: string; title?: string }[]>(`window.__tabs.items.map((t) => ({ id: t.id, title: t.title }))`);
const activeId = () => app.eval<string>(`window.__tabs.activeId`);
/** The tab with the keyboard in the window's page, if it has it: not the document's memory of it. */
const focusedTab = () => app.eval<string | null>(`document.hasFocus() && document.activeElement?.getAttribute('role') === 'tab' ? document.activeElement.id.replace('app-tab-', '') : null`);
const focusTab = async (id: string) => {
	await app.platform('view', 'focusPage'); // a view may have the keyboard
	await app.eval(`(document.getElementById('app-tab-${id}').focus(), true)`);
	await until(async () => (await focusedTab()) === id, `the keyboard on tab ${id}`);
};

beforeAll(async () => {
	app = await launch(name === 'dashboard' ? { dev: true, env: { VITE_TABS_SPLIT: process.env.A11Y_SPLIT ?? '0' } } : {});
	await app.waitFor(() => !!document.querySelector('[role=tab]') && !!(globalThis as any).__tabs, { timeout: 40_000 });
	// The real keyboard goes to the focused window.
	await app.platform('window', 'focus');
	await Bun.sleep(300);
}, 90_000);
afterAll(() => app?.close(), 20_000);

/** The same in every bar, whatever the layout. */
const structure = () =>
	app.eval<{ stray: string[]; orphans: string[]; names: string[]; closeInTree: number; dangling: string[] }>(`(() => {
		const all = [...document.querySelectorAll('[role=tablist]')];
		const tabsIn = [...document.querySelectorAll('[role=tab]')];
		const accessibleText = (el) => [...el.childNodes].map((n) => n.nodeType === 3 ? n.textContent : n.getAttribute?.('aria-hidden') === 'true' ? '' : n.textContent ?? '').join('').trim();
		return {
			stray: all.flatMap((l) => [...l.children].filter((c) => c.getAttribute('role') !== 'tab').map((c) => c.outerHTML.slice(0, 80))),
			orphans: tabsIn.filter((t) => !t.closest('[role=tablist]')).map((t) => t.id),
			names: tabsIn.map(accessibleText),
			closeInTree: document.querySelectorAll('[data-sd-tab-close]:not([aria-hidden="true"])').length,
			// A relationship pointing at nothing is announced as nothing.
			dangling: [...document.querySelectorAll('[aria-controls], [aria-labelledby]')].filter((el) => ['aria-controls', 'aria-labelledby'].some((a) => (el.getAttribute(a) ?? '').split(' ').some((id) => id && !document.getElementById(id)))).map((el) => el.outerHTML.slice(0, 120)),
		};
	})()`);

test('axe: nothing the framework draws in the window page', async () => {
	expect(verdict('window', await app.eval<Found[]>(auditCode))).toEqual([]);
}, 60_000);

test('the list holds only tabs, each named by its title alone, each relationship pointing at something', async () => {
	const s = await structure();
	expect(s.stray).toEqual([]);
	expect(s.orphans).toEqual([]);
	expect(s.closeInTree).toBe(0);
	expect(s.dangling).toEqual([]);
	expect(s.names.some((n) => /close/i.test(n))).toBe(false);
	expect(await app.eval<boolean>(`(() => { const t = document.querySelector('[role=tab][aria-selected=true]'); const p = document.getElementById(t.getAttribute('aria-controls')); return p?.getAttribute('role') === 'tabpanel' && p.getAttribute('aria-labelledby') === t.id; })()`)).toBe(true);
}, 30_000);

test('the keyboard on a tab shows where it is', async () => {
	await focusTab(await activeId());
	await key('Left'); // a key pressed: the ring is for the keyboard, not for a script's focus()
	const ring = await app.eval<{ style: string; offset: string; visible: boolean }>(`(() => { const el = document.activeElement; const c = getComputedStyle(el); return { style: c.outlineStyle, offset: c.outlineOffset, visible: el.matches(':focus-visible') }; })()`);
	expect(ring.visible).toBe(true);
	expect(ring.style).not.toBe('none');
	expect(ring.offset).toBe('-2px'); // inside: the strip clips what's outside a tab
}, 30_000);

if (name === 'panes') {
	const panes = () => app.eval<{ id: string; tabs: string[]; active: string; focused: boolean }[]>(`window.__tabs.panes.panes.map((p) => ({ id: p.id, tabs: [...p.tabs], active: p.active, focused: p.id === window.__tabs.panes.focusedId }))`);
	const inView = <T>(tab: string, code: string) => app.platform<T>('view', 'executeJavaScript', { id: `app-${tab}`, code });
	const reset = async () => {
		await app.eval(`(() => { const t = window.__tabs; for (const x of [...t.items]) t.close(x.id); return true; })()`);
		await until(async () => (await panes()).length === 1 && (await tabs()).length === 1, 'one pane, one tab');
	};
	const open = async (path: string) => {
		const before = (await tabs()).length;
		await app.eval(`(window.__tabs.open(${JSON.stringify(path)}, { reuse: false }), true)`);
		await until(async () => (await tabs()).length === before + 1, `a tab on ${path}`);
		return activeId();
	};

	test('the window page names itself: the active tab, as its window does', async () => {
		await reset();
		await until(async () => (await app.eval<string>(`document.title`)) !== '', 'a title');
		expect(await app.eval<string>(`document.title`)).toBe(await app.eval<string>(`window.__tabs.titleOf(window.__tabs.active)`));
	}, 30_000);

	test('axe: two panes and a line between them, and in a pane\'s own page', async () => {
		await reset();
		const b = await open('/threads/1');
		await app.eval(`(window.__tabs.toSide(${JSON.stringify(b)}, 'right'), true)`);
		await until(async () => (await panes()).length === 2, 'two panes');
		await app.waitFor(() => !!document.querySelector('[data-sd-splitter]'));
		expect(verdict('two panes', await app.eval<Found[]>(auditCode))).toEqual([]);
		expect((await structure()).dangling).toEqual([]);
		// In a view: the page alone, none of the framework's roles.
		await until(() => inView<boolean>(b, `document.documentElement.hasAttribute('data-desktop-hydrated')`), 'its page hydrated', 20_000);
		expect(await inView<number>(b, `document.querySelectorAll('[role=tab], [role=tablist], [role=tabpanel], [data-sd-tabbar]').length`)).toBe(0);
		expect(verdict('a pane\'s page', await inView<Found[]>(b, auditCode))).toEqual([]);
	}, 60_000);

	test('Delete closes the tab with the keyboard, which stays in the bar on the next one', async () => {
		await reset();
		const b = await open('/threads/1');
		const c = await open('/threads/2');
		await focusTab(c);
		await key('Delete');
		await until(async () => !(await tabs()).some((t) => t.id === c), 'closed');
		await until(async () => (await focusedTab()) === b, 'the keyboard on the tab shown next');
		// A tab in a field of yours: its keys are the field's.
		await app.eval(`(() => { const t = document.getElementById('app-tab-${b}'); const i = Object.assign(document.createElement('input'), { id: 'rename', value: 'abc' }); t.append(i); i.focus(); return true; })()`);
		await key('Delete');
		await key('Left');
		expect((await tabs()).some((t) => t.id === b)).toBe(true);
		expect(await activeId()).toBe(b);
		await app.eval(`(document.getElementById('rename').remove(), true)`);
	}, 40_000);

	test('its pane\'s last tab closed: the keyboard goes on to the pane in focus', async () => {
		await reset();
		const b = await open('/threads/1');
		await app.eval(`(window.__tabs.toSide(${JSON.stringify(b)}, 'right'), true)`);
		await until(async () => (await panes()).length === 2, 'two panes');
		await focusTab(b);
		await key('Delete');
		await until(async () => (await panes()).length === 1, 'its pane gone');
		const left = (await panes())[0]!.active;
		await until(async () => (await focusedTab()) === left, 'the keyboard on the pane left');
	}, 40_000);

	test('what a drag does: ⇧← reorders, ⌥→ makes a pane, ⌥PageUp moves to the one before, the keyboard following', async () => {
		await reset();
		const first = await activeId();
		const b = await open('/threads/1');
		await focusTab(b);
		await key('shift+Left');
		await until(async () => (await panes())[0]!.tabs[0] === b, 'first in its bar');
		await until(async () => (await focusedTab()) === b, 'the keyboard still on it');
		await key('alt+Right');
		await until(async () => (await panes()).length === 2, 'a new pane');
		expect((await panes()).map((p) => p.tabs)).toEqual([[first], [b]]);
		await until(async () => (await focusedTab()) === b, 'the keyboard on it, in its pane');
		expect((await panes())[1]!.focused).toBe(true);
		await key('alt+Prior');
		await until(async () => (await panes()).length === 1, 'back in the first pane');
		expect((await panes())[0]!.tabs).toContain(b);
		await until(async () => (await focusedTab()) === b, 'the keyboard on it again');
	}, 40_000);

	test('F6 gets out of a web view to the bar, and back; Enter goes in from a tab', async () => {
		await reset();
		const b = await open('/threads/1');
		const hasKeyboard = () => inView<boolean>(b, `document.hasFocus()`);
		await until(() => inView<boolean>(b, `document.documentElement.hasAttribute('data-desktop-hydrated')`), 'its page hydrated', 20_000);
		await app.platform('view', 'focus', { id: `app-${b}` });
		await until(hasKeyboard, 'the view has the keyboard');
		await key('F6');
		await until(async () => (await focusedTab()) === b, 'the keyboard on its tab');
		expect(await hasKeyboard()).toBe(false);
		await key('F6');
		await until(hasKeyboard, 'in the view again');
		await key('F6');
		await until(async () => (await focusedTab()) === b, 'the bar again');
		await key('Return');
		await until(hasKeyboard, 'Enter: in the view');
	}, 60_000);

	test('the line between two panes: a ring for the keyboard, the arrows, and Enter for equal shares', async () => {
		await reset();
		const b = await open('/threads/1');
		await app.eval(`(window.__tabs.toSide(${JSON.stringify(b)}, 'right'), true)`);
		await until(async () => (await panes()).length === 2, 'two panes');
		await focusTab(b);
		await app.eval(`(document.querySelector('[data-sd-splitter]').focus(), true)`);
		const now = () => app.eval<number>(`Number(document.querySelector('[data-sd-splitter]').getAttribute('aria-valuenow'))`);
		const start = await now();
		await key('Right');
		await until(async () => (await now()) > start, 'moved');
		expect(await app.eval<string>(`getComputedStyle(document.querySelector('[data-sd-splitter]')).outlineStyle`)).not.toBe('none');
		expect(await app.eval<boolean>(`document.querySelector('[data-sd-splitter]').matches(':focus-visible')`)).toBe(true);
		await key('Return');
		await until(async () => (await now()) === 50, 'equal shares');
		expect(await app.eval<boolean>(`document.activeElement === document.querySelector('[data-sd-splitter]')`)).toBe(true);
	}, 40_000);
}

if (name === 'dashboard' && process.env.A11Y_SPLIT !== '1') {
	test('host.system.accessibility is read again when the engine sees a preference change', async () => {
		// No way to flip the system's setting here: its media query says it did.
		await app.eval(`(async () => {
			const listeners = (window.__a11yListeners = []);
			const real = window.matchMedia;
			window.matchMedia = (q) => ({ matches: real.call(window, q).matches, media: q, addEventListener: (_, f) => listeners.push(f), removeEventListener: () => {} });
			host.system.dispose();
			await host.system.init();
			window.matchMedia = real;
			return true;
		})()`);
		expect(await app.eval<number>(`window.__a11yListeners.length`)).toBe(4);
		await app.eval(`(window.__a11yBefore = host.system.accessibility, window.__a11yListeners[0](), true)`);
		await until(() => app.eval<boolean>(`host.system.accessibility !== window.__a11yBefore && typeof host.system.accessibility.reduceMotion === 'boolean'`), 'read again');
	}, 20_000);

	test('the list changes nothing on screen: no box of its own, tabs at their size, + right after the last', async () => {
		const m = await app.eval<{ display: string; tab: number; rem: number; gap: number }>(`(() => {
			const bar = document.querySelector('[data-sd-tabbar]');
			const tabs = [...bar.querySelectorAll('[role=tab]')];
			const last = tabs.at(-1).getBoundingClientRect();
			return { display: getComputedStyle(bar.querySelector('[role=tablist]')).display, tab: last.width, rem: parseFloat(getComputedStyle(document.documentElement).fontSize), gap: bar.querySelector('[data-sd-tab-new]').getBoundingClientRect().left - last.right };
		})()`);
		expect(m.display).toBe('contents');
		expect(m.tab).toBe(12 * m.rem); // shrink-wrapping the strip would make them as wide as their text
		expect(m.gap).toBeGreaterThanOrEqual(0);
		expect(m.gap).toBeLessThan(16);
	}, 20_000);

	test('a tab bar in the window: ⇧→ reorders, Enter goes into the page, Delete leaves the keyboard on the next tab', async () => {
		await app.eval(`(document.querySelector('[data-sd-tab-new]').click(), true)`);
		await until(async () => (await tabs()).length >= 2, 'two tabs');
		const order = async () => (await tabs()).map((t) => t.id);
		const before = await order();
		const last = before.at(-1)!;
		await app.eval(`(window.__tabs.activate(${JSON.stringify(last)}), true)`);
		await focusTab(last);
		await key('shift+Left');
		await until(async () => (await order()).indexOf(last) === before.length - 2, 'a place to the left');
		await until(async () => (await focusedTab()) === last, 'the keyboard still on it');
		await key('Return');
		await until(() => app.eval<boolean>(`document.activeElement?.hasAttribute('data-sd-tabcontent')`), 'the keyboard in the page');
		await key('Tab');
		// Gone on from the panel, which isn't left focusable.
		await until(() => app.eval<boolean>(`!document.querySelector('[data-sd-tabcontent]').hasAttribute('tabindex')`), 'the panel as it was');
		await focusTab(last);
		await key('Delete');
		await until(async () => !(await order()).includes(last), 'closed');
		const next = await activeId();
		await until(async () => (await focusedTab()) === next, 'the keyboard on the tab shown next');
		expect(verdict('after closing', await app.eval<Found[]>(auditCode))).toEqual([]);
	}, 60_000);
}
