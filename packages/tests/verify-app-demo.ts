/**
 * /app demo verification — drives the real notes app end-to-end:
 * mount → navigate /about → back → type a note → add → delete → done.
 * Screenshots land in /tmp/app-verify-*.png.
 *
 * Run: bun src/verify-app-demo.ts
 */
import { GpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot, setViewport } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';

installGlobals();
await import('@svelte-desktop/svelte/build-app.ts');

const renderer = new GpuixRenderer((err, payload) => {
	if (err) { console.error('[gpuix]', err); return; }
	dispatchPayload(payload);
});
setRenderer(renderer);
renderer.init({ title: 'svelte·desktop — notes', width: 900, height: 640 });
setViewport(900, 640);

const target = doc.createElement('div');
target.setAttribute('style', 'display:flex;flex-direction:column;width:100%;height:100%');
doc.body.appendChild(target);
materializeRoot(target);

const { startApp } = await import('./app-boot.ts');
await startApp(target, '/');
flush();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pump = async (n = 6) => {
	for (let i = 0; i < n; i++) { renderer.tick(); flush(); drainAfterRender(); await sleep(25); }
};

interface Node { type: string; text?: string; bounds: { x: number; y: number; width: number; height: number }; children?: Node[] }
const tree = () => JSON.parse(renderer.getAutomationTree()) as Node;
function find(pred: (n: Node) => boolean, n: Node): Node | null {
	if (pred(n)) return n;
	for (const c of n.children ?? []) { const r = find(pred, c); if (r) return r; }
	return null;
}
const center = (n: Node) => ({ x: n.bounds.x + n.bounds.width / 2, y: n.bounds.y + n.bounds.height / 2 });
const byText = (t: string) => {
	const hit = find((n) => n.text === t || (typeof n.text === 'string' && n.text.includes(t)), tree());
	if (!hit) throw new Error(`no element with text "${t}"`);
	return center(hit);
};
const shot = (p: string) => renderer.captureScreenshot(p);
const painted = () => (renderer.getPaintedText() as string[]).join(' ');

let failures = 0;
const check = (name: string, cond: boolean) => {
	if (!cond) failures++;
	console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
};

await pump(10);
console.log('[verify] mounted:', painted().slice(0, 120));

// 1 → /about
const aboutNav = byText('About');
(renderer as any).simulateClick(aboutNav.x, aboutNav.y);
await pump(14);
const aboutText = painted();
check('navigated to /about', aboutText.includes('no webview, no DOM'));
check('runtime card painted', aboutText.includes('pid'));
shot('/tmp/app-verify-about.png');

// 2 → back to /
const back = byText('Notes');
(renderer as any).simulateClick(back.x, back.y);
await pump(14);
check('back on /', painted().includes('Add note'));

// 3 → type a note and add it
const input = find((n) => n.type === 'input' || n.type === 'textfield' || n.type === 'textField', tree());
const inputPt = input ? center(input) : byText('Write a note');
(renderer as any).simulateClick(inputPt.x, inputPt.y);
await pump(6);
// simulateKeystrokes takes space-separated GPUI keystroke names —
// one token per character, 'space' for word gaps.
const keys = 'native demo note'.split('').map((c) => (c === ' ' ? 'space' : c)).join(' ');
(renderer as any).simulateKeystrokes(keys);
await pump(4);
const addBtn = byText('Add note');
(renderer as any).simulateClick(addBtn.x, addBtn.y);
await pump(14);
const afterAdd = painted();
// the input field itself paints the typed text — a real row exists only when
// a per-note × button materializes in the tree
check('note added via remote form()', !!find((n) => n.text === '×', tree()) && afterAdd.includes('native demo note'));
shot('/tmp/app-verify-note.png');

// 4 → delete it via the × button
const del = find((n) => n.text === '×', tree());
if (del) {
	const d = center(del);
	console.log(`[debug] × at ${JSON.stringify(d)} bounds ${JSON.stringify(del.bounds)}`);
	(renderer as any).simulateClick(d.x, d.y);
	await pump(20);
} else {
	console.log('[debug] no × node in tree:', JSON.stringify(tree()).slice(-800));
}
// the input keeps its text after submit — assert the row itself is gone
check('note deleted via command()', !find((n) => n.text === '×', tree()));

// 5 → counter increments via command()
const counterBtn = byText('counter ·');
const before = Number(painted().match(/counter · (\d+)/)?.[1] ?? -1);
(renderer as any).simulateClick(counterBtn.x, counterBtn.y);
await pump(14);
check('counter incremented', painted().includes(`counter · ${before + 1}`));

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
