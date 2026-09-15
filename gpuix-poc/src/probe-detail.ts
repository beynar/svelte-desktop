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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await sleep(400); flush(); renderer.flush(); drainAfterRender();

const tree = JSON.parse((renderer as any).getAutomationTree());
let shown = 0;
function walk(n: any, depth: number) {
	const el: any = nodeForNativeId(n.id);
	const t = (n.text ?? '').trim();
	if ((t === 'Overview' || t === 'Settings' || t.includes('Every DOM')) && shown++ < 8) {
		const b = n.bounds;
		const mp = el?.mergedStyleProps ? Object.fromEntries(el.mergedStyleProps()) : {};
		console.log(`id=${n.id} ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)} "${t.slice(0, 30)}"`);
		console.log(`  cls="${(el?._className ?? '').slice(0, 90)}" tag=${el?.tagName}`);
		console.log(`  ${JSON.stringify(mp).slice(0, 420)}`);
	}
	for (const c of n.children ?? []) walk(c, depth + 1);
}
walk(tree, 0);
