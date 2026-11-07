import { GpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot, setViewport } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';

installGlobals();
const renderer = new GpuixRenderer((err: any, payload: any) => { if (!err) dispatchPayload(payload); });
setRenderer(renderer);
renderer.init({ title: 'focus dbg', width: 500, height: 300 });
setViewport(500, 300);

const target = doc.createElement('div');
target.setAttribute('style', 'display:flex;flex-direction:column;width:100%;height:100%');
doc.body.appendChild(target);
materializeRoot(target);

const a = doc.createElement('div');
a.setAttribute('tabindex', '0');
a.setAttribute('style', 'padding:20px;background-color:#333');
a.textContent = 'focus-a';
const b = doc.createElement('div');
b.setAttribute('tabindex', '0');
b.setAttribute('style', 'padding:20px;background-color:#553');
b.textContent = 'focus-b';
target.appendChild(a);
target.appendChild(b);

let hits: string[] = [];
a.addEventListener('mousedown', () => hits.push('a-mdown'));
a.addEventListener('click', () => hits.push('a-click'));
a.addEventListener('focus', () => hits.push('a-focus'));
b.addEventListener('mousedown', () => hits.push('b-mdown'));
b.addEventListener('click', () => hits.push('b-click'));
b.addEventListener('focus', () => hits.push('b-focus'));
doc.addEventListener('focus', () => hits.push('doc-focus'), true as any);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pump = async (n = 6) => { for (let i = 0; i < n; i++) { renderer.tick(16); flush(); drainAfterRender(); await sleep(20); } };
await pump(10);

console.log('a id', a.nativeId, 'b id', b.nativeId);
console.log('a bounds', JSON.stringify(renderer.getElementBounds(a.nativeId)));
console.log('tree', renderer.getAutomationTree().slice(0, 600));
renderer.simulateClick(30, 30, 0, null, 0);
await pump(6);
console.log('hits:', hits.join(','), '| focused:', renderer.getFocusedElementId());
process.exit(0);
