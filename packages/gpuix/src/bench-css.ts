import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, materializeRoot, setViewport } from '/Users/arnaud/code/svelte-desktop/gpuix-poc/src/gdom';
import { setRenderer, flush, drainAfterRender } from '/Users/arnaud/code/svelte-desktop/gpuix-poc/src/native';
installGlobals();
const { default: themeCss } = await import('/Users/arnaud/code/svelte-desktop/gpuix-poc/src/gen/theme-css.js');
const renderer = new TestGpuixRenderer(1180, 800);
setRenderer(renderer as any); setViewport(1180, 780);

// 1. theme parse cost (260KB css → classRules)
let t = performance.now();
const st = doc.createElement('style');
st.textContent = themeCss;
doc.head.appendChild(st);
const parseMs = performance.now() - t;

doc.documentElement.classList.add('dark');
const { mount } = await import('/Users/arnaud/code/svelte-desktop/gpuix-poc/node_modules/svelte/src/index-client.js');
const { default: Dashboard } = await import('/Users/arnaud/code/svelte-desktop/gpuix-poc/src/gen/dashboard/Dashboard.js');
const target = doc.createElement('div');
target.setAttribute('style', 'display:flex;flex-direction:column;width:1180px;height:780px');
doc.body.appendChild(target);
materializeRoot(target as any);

// 2. mount cost — includes materialize + applyClassStyles + styleObject per el
t = performance.now();
mount(Dashboard, { target: target as any });
await new Promise(r => setTimeout(r, 60));
flush(); renderer.flush(); drainAfterRender();
const mountMs = performance.now() - t;

// count elements in tree
let elCount = 0;
const walk = (n: any) => { if (n.nodeType === 1) elCount++; (n.childNodes ?? []).forEach(walk); };
walk(doc.documentElement);

// 3. re-application cost — a re-parse re-walks the whole tree calling
// applyClassStyles on every element (the hover path does this per element)
const st2 = doc.createElement('style');
st2.textContent = '.bench-noop { color: red }';
t = performance.now();
doc.head.appendChild(st2); // triggers parse + full-tree rewalk
const rewalkMs = performance.now() - t;

// 4. per-element match cost — applyClassStyles scans ALL rules per element
//    (approximate: rewalkMs / elCount), plus styleObject conversion in push
console.log(`theme parse:        ${parseMs.toFixed(1)} ms  (${themeCss.length} bytes)`);
console.log(`elements:           ${elCount}`);
console.log(`dashboard mount:    ${mountMs.toFixed(1)} ms`);
console.log(`full re-apply walk: ${rewalkMs.toFixed(1)} ms  (~${(rewalkMs/elCount*1000).toFixed(0)} µs/el)`);
