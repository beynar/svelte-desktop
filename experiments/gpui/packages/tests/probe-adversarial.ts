/**
 * Adversarial regression probe — exercises the post-review fixes end-to-end
 * through the REAL bridge (gdom → native .node):
 *
 *   F-ctx    data-color attr + style()/resolveTokens ctxColor bridge → color prop
 *   F-stale  scoped theme/color prop change re-resolves stored styles
 *   F-hex8   bg-primary/20 + raised keeps the alpha-suffixed background
 *   F-stomp  raised guards authored boxShadow/border; bogus level = no-op
 *   F-empty  color="" falls back to defaultColor, doesn't poison the subtree
 *   F-attr   removeAttribute('tabindex') clears the native prop
 *   F-repar  reparenting re-resolves inherited theme
 *   F-vocab  aspect-square, ms-/me-, underline/line-through/decoration-*,
 *            italic, focus-visible/focus-within/focus buckets, w-fit/h-fit,
 *            ring default currentColor, theme-only color names pass through
 *   F-wedge  a poisoned batch drops after one retry — later ops still apply
 */
import { TestGpuixRenderer } from '@gpuix/native';

// rebuild gen/nkit/ so the probe runs current sources (same as conformance)
await import('@svelte-desktop/svelte/build.ts');

import { installGlobals, doc, materializeRoot, applyNativeStyle } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush } from '@svelte-desktop/gpuix/native';
const { resolveTokens } = await import('@svelte-desktop/gpuix/gen/nkit/tokens.js');
const { style } = await import('@svelte-desktop/gpuix/gen/nkit/style.js');

installGlobals();
const renderer = new TestGpuixRenderer(600, 500);
setRenderer(renderer as any);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pump = async () => { flush(); renderer.flush(); await sleep(30); };

const styles = () => {
	const out: any[] = [];
	const walk = (n: any) => { out.push(n); n.children?.forEach(walk); };
	walk(JSON.parse(renderer.getTreeJson()));
	return out;
};

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
	if (cond) { pass++; console.log(`✅ ${name}`); }
	else { fail++; console.log(`❌ ${name} ${extra}`); }
};

const root = doc.createElement('div');
doc.body.appendChild(root);
materializeRoot(root);

const mk = (tokens: string, parent: any) => {
	const el = doc.createElement('div');
	applyNativeStyle(el, resolveTokens(tokens));
	parent.appendChild(el);
	return el;
};

// ── F-ctx: data-color attr maps to the native `color` prop ──────────
const ctxHost = doc.createElement('div');
ctxHost.setAttribute('data-color', 'danger');
root.appendChild(ctxHost);
mk('text-color-readable h-8 w-full', ctxHost);

// ctxColor bridge: style() with ctx pins the subtree like svelai's data-color
const ctxStyleHost = doc.createElement('div');
applyNativeStyle(ctxStyleHost, style({ bg: 'color-muted' }, { color: 'info' }));
mk('text-color-readable h-8 w-full', ctxStyleHost);
root.appendChild(ctxStyleHost);

// ── F-empty: color="" must not poison — falls back to defaultColor ──
const emptyCtx = doc.createElement('div');
emptyCtx.setCustomProp('color', '');
root.appendChild(emptyCtx);
mk('text-color-readable h-8 w-full', emptyCtx);

// ── F-hex8: bg-primary/20 + raised keeps the alpha background ───────
mk('bg-primary/20 raised-md h-8 w-full', root);

// ── F-stomp: authored border survives raised; bogus level is a no-op ─
mk('raised-md border-4 border-danger h-8 w-full', root);
const bogus = doc.createElement('div');
applyNativeStyle(bogus, style({ raised: 'bogus', borderW: 4, shadow: { offsetX: 0, offsetY: 9, blurRadius: 9, spreadRadius: 0, color: '#00ff00' } }));
root.appendChild(bogus);

// ── F-vocab: aspect-square, logical margins, decoration, italic ─────
mk('aspect-square w-8', root);
mk('ms-4 me-2 h-8 w-full', root);
mk('underline decoration-primary italic h-8 w-full', root);
mk('line-through h-8 w-full', root);
mk('w-fit h-fit', root);
mk('focus-visible:ring-2 focus-visible:ring-color/50 h-8 w-full', root);
mk('focus-within:bg-primary/10 focus:bg-danger/20 h-8 w-full', root);

// ring default = currentColor → resolves against the element's own color
mk('ring-2 text-danger h-8 w-full', root);

// theme-only color name — `brand` exists only in a scoped theme prop
const scopedTheme = doc.createElement('div');
scopedTheme.setCustomProp('theme', { colors: { brand: '#123456' } });
root.appendChild(scopedTheme);
mk('bg-brand h-8 w-full', scopedTheme);

await pump();

const all = styles();
const bg = (el: any) => el?.style?.backgroundColor;
// indices: 0 root, 1 ctxHost, 2 danger-text, 3 ctxStyleHost, 4 info-text,
//          5 emptyCtx, 6 empty-text, 7 raised-alpha, 8 raised+border,
//          9 bogus, 10 aspect, 11 ms/me, 12 underline, 13 line-through,
//          14 fit, 15 focus-visible ring, 16 focus buckets, 17 ring currentColor,
//          18 scopedTheme, 19 brand
check('F-ctx data-color=danger → color-readable (dark #ff7466)',
	all[2]?.style?.color === '#ff7466', JSON.stringify(all[2]?.style));
check('F-ctx style() ctxColor bridge → info readable (dark #6ab0ff)',
	all[4]?.style?.color === '#6ab0ff', JSON.stringify(all[4]?.style));
check('F-ctx ctxStyleHost own bg resolved via info-muted (#0f1e3b)',
	bg(all[3]) === '#0f1e3b', JSON.stringify(all[3]?.style));
check('F-empty color="" → defaultColor readable (neutral dark #b7b7b7)',
	all[6]?.style?.color === '#b7b7b7', JSON.stringify(all[6]?.style));

// F-hex8: bg survives as an 8-digit alpha hex — not deleted
const raisedBg = bg(all[7]);
check('F-hex8 bg-primary/20 + raised keeps alpha bg', typeof raisedBg === 'string' && /^#5f62ef/i.test(raisedBg ?? ''), JSON.stringify(all[7]?.style));
check('F-hex8 raised shadow list emitted (tint + stack)',
	Array.isArray(all[7]?.style?.boxShadow) && all[7].style.boxShadow.length >= 2,
	JSON.stringify(all[7]?.style?.boxShadow));

// F-stomp
check('F-stomp authored border-4 survives raised-md',
	all[8]?.style?.borderWidth === 4, JSON.stringify(all[8]?.style));
check('F-stomp authored border-danger survives raised-md',
	all[8]?.style?.borderColor === '#dc2626', JSON.stringify(all[8]?.style?.borderColor));
// `borderW` expands to the four side fields natively (application-order
// shorthand semantics) — the authored border still wins over raised:bogus.
check('F-stomp raised:bogus → authored border+shadow untouched',
	all[9]?.style?.borderTopWidth === 4 && all[9]?.style?.borderLeftWidth === 4
	&& all[9]?.style?.boxShadow?.[0]?.offsetY === 9,
	JSON.stringify(all[9]?.style));

// find-by-shape — absolute indices drift when the tree gains internal nodes;
// returns the node's `style` object directly.
const find = (pred: (s: any) => boolean) => all.find((n: any) => n.style && pred(n.style))?.style;

// F-vocab
const aspect = find((s) => s.aspectRatio === 1);
check('F-vocab aspect-square → aspectRatio 1', !!aspect);
const margins = find((s) => s.marginLeft === 16);
check('F-vocab ms-4 → marginLeft 16', margins?.marginLeft === 16);
check('F-vocab me-2 → marginRight 8', margins?.marginRight === 8, JSON.stringify(margins));
const underlined = find((s) => s.textDecoration === 'underline');
check('F-vocab underline', !!underlined);
check('F-vocab decoration-primary → #5f62ef', underlined?.textDecorationColor === '#5f62ef', JSON.stringify(underlined));
check('F-vocab italic', underlined?.fontStyle === 'italic', JSON.stringify(underlined));
check('F-vocab line-through', !!find((s) => s.textDecoration === 'line-through'));
const fitEl = find((s) => s.alignSelf === 'flex-start' && s.width == null && s.aspectRatio == null);
check('F-vocab w-fit/h-fit → auto (absent)', !!fitEl, JSON.stringify(fitEl));
const fvRing = find((s) => s.focusVisible?.boxShadow != null);
check('F-vocab focusVisible ring bucket', fvRing?.focusVisible?.boxShadow?.[0]?.spreadRadius === 2
	&& /^#/.test(fvRing?.focusVisible?.boxShadow?.[0]?.color ?? ''),
	JSON.stringify(fvRing?.focusVisible));
const focusBuckets = find((s) => s.focus?.backgroundColor != null);
check('F-vocab focusWithin bucket', /^#5f62ef/.test(focusBuckets?.focusWithin?.backgroundColor ?? ''), JSON.stringify(focusBuckets?.focusWithin));
check('F-vocab focus bucket', /^#dc2626/.test(focusBuckets?.focus?.backgroundColor ?? ''), JSON.stringify(focusBuckets?.focus));

// ring default → currentColor → element's resolved text color (danger #dc2626)
const ringEl = find((s) => s.color === '#dc2626' && s.boxShadow?.[0]?.ring !== false && s.boxShadow?.[0]?.spreadRadius === 2);
check('F-vocab ring default = currentColor → resolved fg #dc2626',
	/^#dc2626/i.test(ringEl?.boxShadow?.[0]?.color ?? ''),
	JSON.stringify(ringEl?.boxShadow));

// theme-only name: `bg-brand` is dropped by no palette entry upstream; the
// scoped theme prop gives it a home
check('F-theme bg-brand resolves via scoped theme → #123456', bg(all[19]) === '#123456', JSON.stringify(all[19]?.style));

// ── F-attr: tabindex removal uses the native name ────────────────────
const tabbable = doc.createElement('div');
tabbable.setAttribute('tabindex', '3');
root.appendChild(tabbable);
await pump();
tabbable.removeAttribute('tabindex');
await pump();
const afterRemove = styles().find((n: any) => n.props?.tabIndex !== undefined);
check('F-attr removeAttribute(tabindex) clears native tabIndex', !afterRemove || afterRemove.props?.tabIndex !== 3);

// ── F-stale: scoped theme change re-resolves stored styles ───────────
const flipHost = doc.createElement('div');
flipHost.setCustomProp('theme', { mode: 'light' });
root.appendChild(flipHost);
mk('bg-secondary h-8 w-full', flipHost);
await pump();
const before = styles().at(-1)?.style?.backgroundColor;
flipHost.setCustomProp('theme', { mode: 'dark' });
await pump();
const after = styles().at(-1)?.style?.backgroundColor;
check('F-stale scoped theme light→dark re-resolves interned style',
	before === '#e4e4e7' && after === '#27272a', `${before} → ${after}`);

// scoped color prop change — same re-resolution path
const colorHost = doc.createElement('div');
colorHost.setCustomProp('color', 'neutral');
root.appendChild(colorHost);
mk('text-color-readable h-8 w-full', colorHost);
await pump();
const cBefore = styles().at(-1)?.style?.color;
colorHost.setCustomProp('color', 'success');
await pump();
const cAfter = styles().at(-1)?.style?.color;
check('F-stale color ctx neutral→success re-resolves', cBefore === '#b7b7b7' && cAfter === '#71d088', `${cBefore} → ${cAfter}`);

// ── F-repar: reparenting re-resolves inherited theme ─────────────────
const lightHost = doc.createElement('div');
lightHost.setCustomProp('theme', { mode: 'light' });
root.appendChild(lightHost);
const movee = doc.createElement('div');
applyNativeStyle(movee, resolveTokens('bg-secondary h-8 w-full'));
root.appendChild(movee);
await pump();
const repBefore = styles().at(-1)?.style?.backgroundColor;
lightHost.appendChild(movee); // reparent under the light scope
await pump();
const repAfter = styles().at(-1)?.style?.backgroundColor;
check('F-repar reparent dark→light re-resolves', repBefore === '#27272a' && repAfter === '#e4e4e7', `${repBefore} → ${repAfter}`);

// ── F-wedge: a poisoned batch fails once, drops, doesn't block ───────
// A setStyle with a malformed payload (array instead of object) fails
// phase-2 validation — the WHOLE batch is rejected atomically. The next
// flush must still apply fresh ops.
try {
	(renderer as any).applyBatch(JSON.stringify([['setStyle', 999999, [1, 2, 3]]]));
} catch { /* expected — malformed payload */ }
const postWedge = doc.createElement('div');
applyNativeStyle(postWedge, resolveTokens('bg-success h-8 w-full'));
root.appendChild(postWedge);
await pump();
const wedgeCheck = styles().at(-1)?.style?.backgroundColor;
check('F-wedge poisoned batch dropped, later ops apply', wedgeCheck === '#15803d', String(wedgeCheck));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
