import { execSync } from 'node:child_process';
process.env.SVELTE_NATIVE_ROOT ??= '/Users/arnaud/code/svelte-desktop/app';
process.env.SVELTE_NATIVE_DEVJSON ??= '/Users/arnaud/code/svelte-desktop/app/.svelte-native/dev.json';
await import('./host.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const host = (globalThis.__svelteNativeHost ??= {});
for (let i = 0; i < 400 && !(host.renderer && host.router); i++) await sleep(25);
const renderer = host.renderer;
await sleep(800);
try { execSync(`swift /tmp/axraise.swift ${process.pid}`); } catch {}
await host.router.goto('/animations');
await sleep(2000);

const byId = new Map();
const walk = (el) => {
	if (!el || el.nodeType !== 1) return;
	if (el.nativeId != null) byId.set(el.nativeId, el);
	for (const c of el.childNodes ?? []) walk(c);
};
walk(globalThis.document?.documentElement);

for (const id of [72, 73, 289, 19, 78]) {
	const el = byId.get(id);
	if (!el) { console.log(`#${id} not found`); continue; }
	let chain = [];
	let cur = el;
	while (cur) {
		chain.unshift(`${cur.tagName}#${cur.nativeId}.${String(cur.className ?? '').split(' ')[0]}`);
		cur = cur.parentNode;
	}
	console.log(`\n#${id} ${el.tagName}.${el.className}`);
	console.log('  chain:', chain.join(' > '));
	console.log('  style attr:', String(el.getAttribute?.('style') ?? '').slice(0, 300));
	console.log('  inline style keys:', el.style ? Object.keys(el.style._decls ?? el.style.declarations ?? {}) : 'n/a');
}
// children of page-head and .scroll top-level
for (const pid of [72]) {
	const p = byId.get(pid);
	console.log(`\nchildren of #${pid}:`);
	for (const c of p?.childNodes ?? []) {
		if (c.nodeType === 1)
			console.log(`  ${c.tagName}#${c.nativeId}.${c.className} style="${String(c.getAttribute?.('style') ?? '').slice(0, 160)}"`);
	}
}
process.exit(0);
