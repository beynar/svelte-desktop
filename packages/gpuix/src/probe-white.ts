import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, materializeRoot } from './gdom';
import { setRenderer, flush, drainAfterRender, nodeForNativeId } from './native';
installGlobals();
const { default: themeCss } = await import('./gen/theme-css.js');
const renderer = new TestGpuixRenderer(1180, 800);
setRenderer(renderer as any);
const st = doc.createElement('style');
st.textContent = themeCss;
doc.head.appendChild(st);
doc.documentElement.classList.add('dark');
const { mount } = await import('../node_modules/svelte/src/index-client.js');
const { default: Dashboard } = await import('./gen/dashboard/Dashboard.js');
const target = doc.createElement('div');
target.setAttribute('style', 'display:flex;flex-direction:column;width:1180px;height:780px');
doc.body.appendChild(target);
materializeRoot(target as any);
mount(Dashboard, { target: target as any });
flush(); renderer.flush(); drainAfterRender();
const tree = JSON.parse((renderer as any).getAutomationTree());
// print every element with a background prop
let n_ = 0;
function walk(n: any) {
	const el: any = nodeForNativeId(n.id);
	const mp = el?.mergedStyleProps ? Object.fromEntries(el.mergedStyleProps()) : {};
	const bg = mp.backgroundColor ?? mp.background;
	const b = n.bounds;
	if (bg && b && b.width > 200 && b.height > 10 && n_++ < 12) {
		console.log(`id=${n.id} <${el?.tagName}> ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)} cls="${(el?._className ?? '').slice(0, 70)}" bg=${bg}`);
	}
	for (const c of n.children ?? []) walk(c);
}
walk(tree, 0);

console.log('=== cards/content ===');
function walk2(n: any, d: number) {
	const el: any = nodeForNativeId(n.id);
	const cls = el?._className ?? '';
	if (d < 9 && (cls.includes('cn-card') || cls.includes('content') || cls.includes('cards') || cls.includes('stat') || cls.includes('inset') || cls.includes('md-'))) {
		const b = n.bounds;
		const mp = el?.mergedStyleProps ? Object.fromEntries(el.mergedStyleProps()) : {};
		console.log(`${'  '.repeat(d)}id=${n.id} ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)} "${cls.slice(0, 55)}"`);
		const keep = ['display','flexDirection','flexGrow','flexBasis','width','height','background','backgroundColor','borderRadius','overflow','padding','gap'];
		console.log(`${'  '.repeat(d)}   ${keep.filter(k=>mp[k]!==undefined).map(k=>`${k}=${JSON.stringify(mp[k])}`).join(' ').slice(0,200)}`);
	}
	for (const c of n.children ?? []) walk2(c, d + 1);
}
walk2(tree, 0);

console.log('=== .cards parent ===');
function walk3(n: any) {
	const el: any = nodeForNativeId(n.id);
	const cls = el?._className ?? '';
	if (cls.includes('cards') || cls.includes('content')) {
		const mp = el?.mergedStyleProps ? Object.fromEntries(el.mergedStyleProps()) : {};
		console.log(`id=${n.id} cls="${cls}" → ${JSON.stringify(mp).slice(0, 250)}`);
	}
	for (const c of n.children ?? []) walk3(c);
}
walk3(tree, 0);

console.log('=== rule check ===');
const gdom = await import('./gdom.js');
const rules = (gdom as any).classRules ?? [];
console.log('total classRules:', rules.length);
const cardRules = rules.filter((r: any) => r.required?.includes('cards') || r.required?.includes('logo'));
console.log('cards/logo rules:', JSON.stringify(cardRules.map((r: any) => ({req: r.required, props: Object.fromEntries(r.props ?? [])}))).slice(0, 600));
// does the .logo element have its color?
function findCls(n: any, needle: string): any {
	const el: any = nodeForNativeId(n.id);
	if ((el?._className ?? '').includes(needle)) return el;
	for (const c of n.children ?? []) { const f = findCls(c, needle); if (f) return f; }
}
const logo = findCls(tree, 'logo');
console.log('logo _classProps:', logo ? JSON.stringify(Object.fromEntries(logo._classProps ?? new Map())) : 'not found');

console.log('=== re-apply test ===');
const cardsEl = findCls(tree, 'cards svelte');
if (cardsEl) {
	cardsEl.className = cardsEl._className; // re-trigger applyClassStyles
	console.log('after re-set:', JSON.stringify(Object.fromEntries(cardsEl._classProps ?? new Map())).slice(0, 200));
}
