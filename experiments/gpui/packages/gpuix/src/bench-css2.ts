import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, materializeRoot, setViewport, dispatchPayload } from './gdom';
import { setRenderer, flush, drainAfterRender } from './native';
installGlobals();
const { default: themeCss } = await import('./gen/theme-css.js');
const renderer = new TestGpuixRenderer(1180, 800);
setRenderer(renderer as any); setViewport(1180, 780);
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
await new Promise(r => setTimeout(r, 80));
flush(); renderer.flush(); drainAfterRender();

const all: any[] = [];
const walk = (n: any) => { if (n.nodeType === 1) all.push(n); (n.childNodes ?? []).forEach(walk); };
walk(doc.documentElement);
walk(target); // mounted children live under target subtree
const uniq = [...new Set(all)];
console.log('elements found:', uniq.length);

const btn = uniq.find(e => e.tagName === 'BUTTON' && e._className?.includes('menu-button'));
// hot loop: re-set className → applyClassStyles (full rule scan) each time
const N = 2000;
let t = performance.now();
for (let i = 0; i < N; i++) btn.className = btn._className;
const perApply = (performance.now() - t) / N * 1000;
console.log(`applyClassStyles: ${perApply.toFixed(1)} µs/call (${N} calls on menu button)`);

// hover toggle: state change → applyClassStyles + style push
t = performance.now();
for (let i = 0; i < N; i++) { btn._hovered = !btn._hovered; dispatchPayload({ elementId: btn.nativeId, eventType: btn._hovered ? 'mouseEnter' : 'mouseLeave' }); }
const perHover = (performance.now() - t) / N * 1000;
console.log(`hover state flip: ${perHover.toFixed(1)} µs/call`);

// rule table size
const anyGdom = await import('./gdom');
console.log('tree els:', uniq.length, '| btn rules scanned per applyClassStyles: all classRules');
