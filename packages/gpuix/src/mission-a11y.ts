import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, materializeRoot } from './gdom';
import { setRenderer, flush, drainAfterRender } from './native';
installGlobals();
const r = new TestGpuixRenderer(800, 600);
setRenderer(r as any);
const tree = () => JSON.parse(r.getTreeJson());

const b = doc.createElement('button');
b.textContent = 'hi';
const h2 = doc.createElement('h2');
const cb = doc.createElement('input'); cb.setAttribute('type', 'checkbox'); cb.setAttribute('aria-checked', 'true');
const sl = doc.createElement('div');
sl.setAttribute('role', 'slider'); sl.setAttribute('aria-valuenow', '42'); sl.setAttribute('aria-hidden', 'false');
const link = doc.createElement('a'); // no href → no implicit role
const link2 = doc.createElement('a'); link2.setAttribute('href', '/x');
const explicit = doc.createElement('div'); explicit.setAttribute('role', 'tab');
for (const el of [b, h2, cb, sl, link, link2, explicit]) doc.body.appendChild(el);
materializeRoot(doc.body);
flush(); r.flush(); drainAfterRender();
const kids = tree().children;
for (const [name, i] of [['button',0],['h2',1],['checkbox',2],['slider',3],['a-nohref',4],['a-href',5],['div-tab',6]]) {
	console.log(name.padEnd(10), JSON.stringify(kids[i]?.customProps));
}
// dynamic: set type after materialization
cb.setAttribute('type', 'range');
flush(); r.flush(); drainAfterRender();
console.log('cb→range ', JSON.stringify(tree().children[2].customProps));
// remove explicit role → implicit re-emitted? (div has no implicit → stays cleared)
explicit.removeAttribute('role');
flush(); r.flush(); drainAfterRender();
console.log('div role removed:', JSON.stringify(tree().children[6].customProps));
