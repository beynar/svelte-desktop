/**
 * hover-ancestor probe — regression check for CSS :hover semantics:
 * a parent must stay hovered while the pointer is over a painted child.
 *
 * `.card:hover` is a native bucket and `card` also carries JS
 * mouseover/mouseout listeners — both evaluate `hitbox.is_hovered`, so the
 * JS events are an observable proxy for the native pseudo state.
 *
 * Sequence: move onto card padding (enter) → onto the painted `.badge`
 * child (must NOT leave) → off the card (leave). Each expectation logs
 * PASS/FAIL.
 *
 * Run: bun src/probe-hover-ancestor.ts
 */
import { GpuixRenderer } from '@gpuix/native';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';
import { installGlobals, doc, materializeRoot, dispatchPayload } from '@svelte-desktop/gpuix/gdom';
import { registerSheet } from '@svelte-desktop/gpuix/native-css/register';
import { parseStylesheet } from '@svelte-desktop/gpuix/native-css/parse';

installGlobals();

const renderer = new GpuixRenderer((err, payload) => {
	if (err) {
		console.error('[gpuix]', err);
		return;
	}
	dispatchPayload(payload);
});
setRenderer(renderer);
const W = 640, H = 480;
renderer.init({ title: 'hover-ancestor probe', width: W, height: H });

const { rules, warnings } = parseStylesheet(`
.card {
	display: flex; flex-direction: column; gap: 12px;
	margin: 32px; padding: 24px;
	background-color: #1f2937; border-radius: 12px;
	border-width: 1px; border-color: #374151;
}
.card:hover { background-color: #374151; border-color: #60a5fa }
div.badge {
	align-self: flex-start; color: #ffffff; background-color: #2563eb;
	border-radius: 6px; padding: 4px 10px; font-size: 12px;
}
#title { color: #f9fafb; font-size: 22px }
`);
for (const w of warnings) console.log('[native-css]', w);
registerSheet('probe-hover-ancestor', rules);
flush();

const target = doc.createElement('div');
target.setAttribute('style', 'display:flex;flex-direction:column;width:100%;height:100%;background-color:#09090b');
doc.body.appendChild(target);
materializeRoot(target);

const card = doc.createElement('div');
card.className = 'card';
const title = doc.createElement('div');
title.setAttribute('id', 'title');
title.appendChild(doc.createTextNode('hover ancestor probe'));
const badge = doc.createElement('div');
badge.className = 'badge';
badge.appendChild(doc.createTextNode('painted child'));
card.appendChild(title);
card.appendChild(badge);
target.appendChild(card);

// JS listeners ride the same hitbox.is_hovered predicate the native
// :hover bucket uses — observable proxy for the pseudo state.
const events: string[] = [];
card.addEventListener('mouseover', () => events.push('enter'));
card.addEventListener('mouseout', () => events.push('leave'));

card.addEventListener('click', () => events.push('click'));
flush();

// ── scripted verification ────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Simulated input dispatches on the UI thread, but the emitted JS events
// ride the TSFN — they only land when the loop turns. tick() pumps frames,
// the sleep delivers the callbacks.
const tick = async (n = 10) => { for (let i = 0; i < n; i++) { renderer.tick(); drainAfterRender(); await sleep(20); } };

interface Node { type: string; bounds: { x: number; y: number; width: number; height: number }; children?: Node[] }
function find(pred: (n: Node) => boolean, n: Node): Node | null {
	if (pred(n)) return n;
	for (const c of n.children ?? []) { const r = find(pred, c); if (r) return r; }
	return null;
}
const center = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

let failures = 0;
function expect(label: string, fn: () => boolean) {
	const ok = fn();
	if (!ok) failures++;
	console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
}

let frames = 0;
const loop = () => {
	const running = renderer.tick();
	drainAfterRender();
	if (++frames === 20) void verify();
	if (running) setImmediate(loop);
};

async function verify() {
	const tree = JSON.parse(renderer.getAutomationTree()) as Node;
	// badge = the div wrapping the 'painted child' text; card = its parent
	const badgeNode = find((n) => n.type === 'div' && n.children?.some((c) => c.type === 'text' && (c as { text?: string }).text === 'painted child'), tree);
	const cardNode = find((n) => n.children?.includes(badgeNode as Node) ?? false, tree);
	if (!cardNode || !badgeNode) {
		console.log('FAIL could not locate card/badge in automation tree');
		process.exit(1);
	}
	const cardB = cardNode.bounds, badgeB = badgeNode.bounds;
	console.log(`[debug] card ${JSON.stringify(cardB)} badge ${JSON.stringify(badgeB)}`);

	// The full sequence, then one assertion — event delivery trails the
	// dispatch by a pump cycle, so per-move checks race the TSFN.
	const pad = { x: cardB.x + cardB.width - 8, y: cardB.y + 6 };
	const bc = center(badgeB);
	(renderer as any).simulateMouseMove(pad.x, pad.y); await tick();
	(renderer as any).simulateMouseMove(bc.x, bc.y); await tick();
	(renderer as any).simulateMouseMove(pad.x, pad.y); await tick();
	(renderer as any).simulateMouseMove(4, 4); await tick();

	// enter once (card area), nothing over the painted badge, leave at the
	// end. A leave over the badge would show 'enter,leave,enter,leave'.
	expect('ancestor hover survives the painted child', () => events.join() === 'enter,leave');
	console.log(`[events] ${events.join(' → ') || '(none)'}`);
	console.log(failures === 0 ? 'ALL PASS — ancestor hover survives painted children' : `${failures} FAILURE(S)`);
	process.exit(failures ? 1 : 0);
}

loop();
