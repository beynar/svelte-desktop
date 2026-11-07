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
// find first LI (menu-item) and dump subtree
function findLi(n: any): any {
	const el: any = nodeForNativeId(n.id);
	if (el?.tagName === 'LI' && (el._className ?? '').includes('menu-item')) return n;
	for (const c of n.children ?? []) { const f = findLi(c); if (f) return f; }
}
const li = findLi(tree);
function dump(n: any, d: number) {
	const el: any = nodeForNativeId(n.id);
	const b = n.bounds;
	const mp = el?.mergedStyleProps ? Object.fromEntries(el.mergedStyleProps()) : {};
	const h = ['display','height','minHeight','maxHeight','paddingTop','paddingBottom','marginTop','marginBottom','flexDirection','alignItems','lineHeight','fontSize','gap','rowGap','overflow','position','width','whiteSpace','textOverflow']
		.filter(k => mp[k] !== undefined).map(k => `${k}=${JSON.stringify(mp[k])}`).join(' ');
	console.log(`${'  '.repeat(d)}id=${n.id} <${el?.tagName ?? '?'}> ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)} "${(n.text??'').trim().slice(0,20)}" ${h.slice(0,200)}`);
	for (const c of n.children ?? []) dump(c, d + 1);
}
dump(li, 0);
