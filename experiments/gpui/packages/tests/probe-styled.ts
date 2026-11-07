/**
 * native-css probe — exercises the stylesheet pipeline end to end:
 * parseStylesheet → registerSheet (stylesheet.register op) → setClass ops
 * as gdom elements materialize and mutate.
 *
 * The sheet covers `.card`, `.card:hover`, `div.badge`, `#title` — the window
 * should show a dark card that brightens on hover, a blue badge, and a bright
 * title. A click toggles `.selected` (dynamic setClass re-emit → border swap).
 *
 * Run: bun src/probe-styled.ts
 * Until the Rust stylesheet ops land, `stylesheet.register`/`setClass` fail
 * as unknown ops — the failed batch is retried once then dropped, so the
 * tree still mounts and only the sheet styling is missing.
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
renderer.init({ title: 'native-css probe — .card / :hover / div.badge / #title', width: W, height: H });

// ── sheet registration through the helper (same contract build.ts emits) ──
const { rules, warnings } = parseStylesheet(`
.card {
	display: flex; flex-direction: column; gap: 12px;
	margin: 32px; padding: 24px;
	background-color: #1f2937; border-radius: 12px;
	border-width: 1px; border-color: #374151;
}
.card:hover { background-color: #374151; border-color: #60a5fa }
.card.selected { border-color: #f59e0b }
div.badge {
	align-self: flex-start; color: #ffffff; background-color: #2563eb;
	border-radius: 6px; padding: 4px 10px; font-size: 12px;
}
#title { color: #f9fafb; font-size: 22px }
`);
for (const w of warnings) console.log('[native-css]', w);
registerSheet('probe-styled', rules);
// Isolate the sheet ops in their own batch: on an unaware native side this
// flush fails and drops just the register/setClass prefix, so the element
// ops below still land and the window mounts.
flush();

// ── gdom-authored tree, same shape as main-buttons.ts ──
const target = doc.createElement('div');
target.setAttribute('style', 'display:flex;flex-direction:column;width:100%;height:100%;background-color:#09090b');
doc.body.appendChild(target);
materializeRoot(target);

const card = doc.createElement('div');
card.className = 'card';

const title = doc.createElement('div');
title.setAttribute('id', 'title');
title.appendChild(doc.createTextNode('native stylesheet probe'));

const badge = doc.createElement('div');
badge.className = 'badge';
badge.appendChild(doc.createTextNode('div.badge — click card to toggle .selected'));

card.appendChild(title);
card.appendChild(badge);
target.appendChild(card);

// dynamic class mutation → a fresh setClass op carries 'card selected'
card.addEventListener('click', () => {
	card.classList.toggle('selected');
	console.log(`[probe] card class="${card.className}"`);
});

flush();
console.log(`[probe] mounted: sheet 'probe-styled' (${rules.length} rules), card/badge/#title built`);

// ── window loop + automation-tree dump for visual verification ──
let frames = 0;
const loop = () => {
	const running = renderer.tick();
	drainAfterRender();
	if (++frames === 30) {
		console.log('--- automation tree ---');
		try {
			const tree = renderer.getAutomationTree();
			if (tree === 'null') {
				console.log('null — a batch carrying an unknown op was dropped (pre-Rust build)');
			} else {
				console.log(JSON.stringify(JSON.parse(tree), null, 2));
			}
		} catch {
			console.log(renderer.getAutomationTree());
		}
		console.log('--- verify: card bg should be #1f2937 (#374151 on hover), badge #2563eb, title bright ---');
	}
	if (running) setImmediate(loop);
};
loop();
