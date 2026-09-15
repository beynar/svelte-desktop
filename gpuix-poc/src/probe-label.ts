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

// find the sidebar "Overview" text node, walk up parents
const tree = JSON.parse((renderer as any).getAutomationTree());
function find(n: any): any {
	if (n.text?.trim() === 'Overview' && n.bounds?.x < 300) return n;
	for (const c of n.children ?? []) { const f = find(c); if (f) return f; }
}
const t = find(tree);
let el: any = nodeForNativeId(t.id);
for (let i = 0; i < 5 && el; i++) {
	const mp = el.mergedStyleProps ? Object.fromEntries(el.mergedStyleProps()) : {};
	console.log(`<${el.tagName ?? 'text'}> cls="${(el._className ?? '').slice(0, 80)}"`);
	console.log(`   ${JSON.stringify(mp).slice(0, 360)}`);
	el = el.parentNode;
}
