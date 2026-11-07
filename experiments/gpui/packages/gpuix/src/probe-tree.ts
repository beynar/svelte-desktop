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
function walk(n: any, depth: number) {
	const b = n.bounds;
	const el: any = nodeForNativeId(n.id);
	const cls = (el?._className ?? '').slice(0, 60);
	const mp = el?.mergedStyleProps ? Object.fromEntries(el.mergedStyleProps()) : {};
	const st = ['position','top','bottom','left','right','height','width','transform','translate','marginTop','marginBottom','display','overflow','flexDirection','flexGrow','flexShrink','flexBasis','alignItems','justifyContent','minHeight','maxHeight']
		.filter(k => mp[k] !== undefined).map(k => `${k}=${JSON.stringify(mp[k])}`).join(' ');
	if (b) console.log(`${'  '.repeat(Math.min(depth,10))}id=${n.id} ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)} ${cls} | ${st.slice(0,180)}`);
	for (const c of n.children ?? []) walk(c, depth + 1);
}
walk(tree, 0);
