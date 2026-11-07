/**
 * Probe: transition: (bidirectional) must reverse mid-flight — toggling open
 * during an outro continues the intro from the CURRENT opacity, not from 0.
 * Svelte reads `counterpart.t()` off the running animation's currentTime and
 * re-samples css(t1→t2) with a proportionally shortened duration; without a
 * live currentTime the intro replays t:0→1 and the element snaps out first.
 */
import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';

installGlobals();
const renderer = new TestGpuixRenderer(640, 600);
setRenderer(renderer as any);
const { mount } = await import('@svelte-desktop/svelte/svelte-client.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function clickText(text: string) {
	const tree = JSON.parse(renderer.getAutomationTree());
	let hit: { x: number; y: number } | null = null;
	const walk = (n: any) => {
		if (hit) return;
		if (n.type === 'text' && typeof n.text === 'string' && n.text.includes(text)) {
			hit = { x: n.bounds.x + n.bounds.width / 2, y: n.bounds.y + n.bounds.height / 2 };
		}
		n.children?.forEach(walk);
	};
	walk(tree);
	if (!hit) throw new Error(`no "${text}"`);
	renderer.simulateClick(hit.x, hit.y);
}

async function pumpOnce() {
	for (const ev of renderer.drainEvents()) dispatchPayload(ev);
	await sleep(0);
	flush();
	renderer.flush();
	drainAfterRender();
}

function elByText(text: string): any {
	let found: any = null;
	const walk = (n: any) => {
		if (found) return;
		if (n.nodeType === 3 && n.textContent === text) found = n.parentElement;
		for (const c of n.childNodes ?? []) walk(c);
	};
	walk(doc.documentElement);
	return found;
}
const opacityOf = () => {
	const el = elByText('fader');
	return el ? parseFloat(((globalThis as any).getComputedStyle(el) as any).opacity) : null;
};
// translateY of the flyer — 'translate(0px, -30px)' → -30; 'none' → 0
const flyY = () => {
	const el = elByText('flyer');
	if (!el) return null;
	const t = ((globalThis as any).getComputedStyle(el) as any).transform ?? 'none';
	const m = /translate\([^,]+,\s*(-?[\d.]+)px\)/.exec(t);
	return m ? parseFloat(m[1]) : 0;
};
// slide drives height + box paddings; sample the animated height channel
const slideH = () => {
	const el = elByText('slider');
	if (!el) return null;
	const h = ((globalThis as any).getComputedStyle(el) as any).height;
	const n = parseFloat(h ?? '');
	return Number.isFinite(n) ? n : null;
};
// scale drives transform: scale(t) — 'scale(0.5)' / 'none'
const scaleV = () => {
	const el = elByText('scaler');
	if (!el) return null;
	const t = ((globalThis as any).getComputedStyle(el) as any).transform ?? 'none';
	const m = /scale\(([\d.]+)/.exec(t);
	return m ? parseFloat(m[1]) : (t === 'none' ? 1 : null);
};

const target = doc.createElement('div');
doc.body.appendChild(target);
materializeRoot(target);
const { default: App } = await import('./gen/cases/reversetrans.js');
mount(App, { target });
await sleep(60);
await pumpOnce();

let pass = 0, fail = 0;
const check = (ok: boolean, label: string) => {
	console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
	ok ? pass++ : fail++;
};

// start the outro, sample opacity until mid-flight, then re-toggle open
clickText('toggle');
const trail: { o: number | null; mark?: boolean }[] = [];
const t0 = Date.now();
let interrupted = -1;
while (Date.now() - t0 < 900) {
	await pumpOnce();
	const o = opacityOf();
	if (interrupted < 0 && o !== null && o < 0.55 && o > 0.1) {
		interrupted = o;
		clickText('toggle');
		trail.push({ o, mark: true });
	} else {
		trail.push({ o });
	}
	await sleep(8);
}
console.log(
	'  trail:',
	trail.map((p) => `${p.mark ? '>' : ''}${p.o === null ? 'null' : p.o.toFixed(2)}`).join(' → '),
);
console.log('  interrupted at opacity:', interrupted.toFixed(2));

const idx = trail.findIndex((p) => p.mark);
const post = trail.slice(idx + 1).map((p) => p.o).filter((o): o is number => o !== null);
console.log('  post-toggle head:', post.slice(0, 6).map((o) => o.toFixed(2)).join(', '));

check(interrupted > 0, `outro was mid-flight when toggled (opacity ${interrupted.toFixed(2)})`);
check(post.length > 0, 'element still mounted after re-toggle');
// reversal: readings continue near the interrupted value — a full replay
// pins opacity≈0 immediately (fade css(0) → opacity 0), and a frozen
// currentTime makes t1≈t2 → delta≈0 → instant snap to the end state.
// Neither is distinguishable from a real reversal by ">0.05" alone —
// continuity is the actual signature.
const firstPost = post[0] ?? 0;
check(firstPost > 0.05, `intro resumed near interrupted value (got ${firstPost.toFixed(2)}, replay pins ~0)`);
check(
	Math.abs(firstPost - interrupted) < 0.2,
	`intro CONTINUED from the interrupt (|${firstPost.toFixed(2)} − ${interrupted.toFixed(2)}| < 0.2 — a snap to 1.0 means the clock was stale)`,
);
check(Math.max(...post) > 0.9, `intro completed to full opacity (peak ${Math.max(...post).toFixed(2)})`);
check(post[post.length - 1] === 1, `settled at opacity 1 (got ${post[post.length - 1]?.toFixed(2)})`);

// ── transition:fly — same reversal on the transform channel ──────────
// outro flies to y=-60; interrupt mid-flight → intro must continue from
// the current y, not snap to -60 and replay.
clickText('flytoggle');
const ftrail: { y: number | null; mark?: boolean }[] = [];
const ft0 = Date.now();
let fy = 999;
while (Date.now() - ft0 < 900) {
	await pumpOnce();
	const y = flyY();
	if (fy === 999 && y !== null && y < -20 && y > -55) {
		fy = y;
		clickText('flytoggle');
		ftrail.push({ y, mark: true });
	} else {
		ftrail.push({ y });
	}
	await sleep(8);
}
console.log(
	'  fly trail:',
	ftrail.map((p) => `${p.mark ? '>' : ''}${p.y === null ? 'null' : p.y.toFixed(1)}`).join(' → '),
);
console.log('  interrupted at y:', fy.toFixed(1));

const fidx = ftrail.findIndex((p) => p.mark);
const fpost = ftrail.slice(fidx + 1).map((p) => p.y).filter((y): y is number => y !== null);
console.log('  post-toggle head:', fpost.slice(0, 6).map((y) => y.toFixed(1)).join(', '));

check(fy !== 999, `fly outro was mid-flight when toggled (y ${fy.toFixed(1)})`);
check(fpost.length > 0, 'flyer still mounted after re-toggle');
const firstFy = fpost[0] ?? -999;
check(
	firstFy > -55,
	`fly intro resumed near interrupted y (got ${firstFy.toFixed(1)}, replay snaps to -60)`,
);
check(
	Math.abs(firstFy - fy) < 12,
	`fly intro CONTINUED from the interrupt (|${firstFy.toFixed(1)} − ${fy.toFixed(1)}| < 12 — a snap to 0 means the clock was stale)`,
);
check(
	fpost[fpost.length - 1] !== null && Math.abs(fpost[fpost.length - 1]) < 1,
	`flyer settled at y≈0 (got ${fpost[fpost.length - 1]?.toFixed(1)})`,
);

// ── transition:slide — reversal on the height-collapse channel ──────
// outro collapses height ~full→0; interrupt mid-flight → intro must
// regrow from the current height, not snap to 0 and replay.
await pumpOnce();
const openH = slideH();
clickText('slidetoggle');
const strail: { h: number | null; mark?: boolean }[] = [];
const st0 = Date.now();
let sh = -1;
while (Date.now() - st0 < 900) {
	await pumpOnce();
	const h = slideH();
	if (sh < 0 && h !== null && openH && h < openH * 0.6 && h > openH * 0.08) {
		sh = h;
		clickText('slidetoggle');
		strail.push({ h, mark: true });
	} else {
		strail.push({ h });
	}
	await sleep(8);
}
console.log(
	'  slide trail:',
	strail.map((p) => `${p.mark ? '>' : ''}${p.h === null ? 'null' : p.h.toFixed(1)}`).join(' → '),
);
console.log(`  open height: ${openH?.toFixed(1)}  interrupted at h: ${sh.toFixed(1)}`);

const sidx = strail.findIndex((p) => p.mark);
const spost = strail.slice(sidx + 1).map((p) => p.h).filter((h): h is number => h !== null);
console.log('  post-toggle head:', spost.slice(0, 6).map((h) => h.toFixed(1)).join(', '));

check(sh > 0, `slide outro was mid-flight when toggled (h ${sh.toFixed(1)} of ${openH?.toFixed(1)})`);
check(spost.length > 0, 'slider still mounted after re-toggle');
const firstSh = spost[0] ?? -1;
check(
	firstSh > 1,
	`slide intro resumed near interrupted height (got ${firstSh.toFixed(1)}, replay pins ~0)`,
);
check(
	openH !== null && Math.abs(firstSh - sh) < openH * 0.3,
	`slide intro CONTINUED from the interrupt (|${firstSh.toFixed(1)} − ${sh.toFixed(1)}| < ${(openH! * 0.3).toFixed(1)} — a snap to open height means the clock was stale)`,
);
check(
	spost.length > 0 && openH !== null && Math.abs((spost[spost.length - 1] ?? -1) - openH) < 2,
	`slider settled back at open height (got ${spost[spost.length - 1]?.toFixed(1)})`,
);

// ── transition:scale — reversal on the scale channel ────────────────
await pumpOnce();
clickText('scaletoggle');
const ctrail: { v: number | null; mark?: boolean }[] = [];
const ct0 = Date.now();
let cv = -1;
while (Date.now() - ct0 < 900) {
	await pumpOnce();
	const v = scaleV();
	if (cv < 0 && v !== null && v < 0.6 && v > 0.1) {
		cv = v;
		clickText('scaletoggle');
		ctrail.push({ v, mark: true });
	} else {
		ctrail.push({ v });
	}
	await sleep(8);
}
console.log(
	'  scale trail:',
	ctrail.map((p) => `${p.mark ? '>' : ''}${p.v === null ? 'null' : p.v.toFixed(2)}`).join(' → '),
);
console.log('  interrupted at scale:', cv.toFixed(2));

const cidx = ctrail.findIndex((p) => p.mark);
const cpost = ctrail.slice(cidx + 1).map((p) => p.v).filter((v): v is number => v !== null);
console.log('  post-toggle head:', cpost.slice(0, 6).map((v) => v.toFixed(2)).join(', '));

check(cv > 0, `scale outro was mid-flight when toggled (scale ${cv.toFixed(2)})`);
check(cpost.length > 0, 'scaler still mounted after re-toggle');
const firstCv = cpost[0] ?? -1;
check(
	firstCv > 0.02,
	`scale intro resumed near interrupted value (got ${firstCv.toFixed(2)}, replay pins ~0)`,
);
check(
	Math.abs(firstCv - cv) < 0.2,
	`scale intro CONTINUED from the interrupt (|${firstCv.toFixed(2)} − ${cv.toFixed(2)}| < 0.2 — a snap to 1.0 means the clock was stale)`,
);
check(
	cpost.length > 0 && Math.abs((cpost[cpost.length - 1] ?? -1) - 1) < 0.02,
	`scaler settled back at scale 1 (got ${cpost[cpost.length - 1]?.toFixed(2)})`,
);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
