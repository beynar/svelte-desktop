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

// find elements whose text contains a word; print bounds + styleprops
const tree = JSON.parse((renderer as any).getAutomationTree());
function walk(n: any, depth: number): any {
	if (n.text?.includes('Overview') || n.text?.includes('gpuix')) {
		const el: any = nodeForNativeId(n.id);
		console.log(`id=${n.id} b=${JSON.stringify(n.bounds)} text="${n.text?.slice(0,30)}"`);
		if (el?.mergedStyleProps) {
			const merged = Object.fromEntries(el.mergedStyleProps());
			console.log('  merged:', JSON.stringify(merged).slice(0, 400));
		}
	}
	for (const c of n.children ?? []) walk(c, depth + 1);
}
walk(tree, 0);
