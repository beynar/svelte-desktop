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
// dump every element with bounds, depth-limited, x>250
function walk(n: any, d: number) {
	const b = n.bounds;
	if (b && b.x > 250 && d < 7) {
		const el: any = nodeForNativeId(n.id);
		const mp = el?.mergedStyleProps ? Object.fromEntries(el.mergedStyleProps()) : {};
		const cs = Object.entries(mp).filter(([k]) => /color|background|border|radius|shadow/i.test(k)).map(([k,v])=>`${k}=${v}`).join(' ');
		console.log(`${'  '.repeat(d)}id=${n.id} <${el?.tagName ?? '?'}> ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)} "${(el?._className ?? '').slice(0,45)}" ${cs.slice(0,150)}`);
	}
	for (const c of n.children ?? []) walk(c, d + 1);
}
walk(tree, 0);
