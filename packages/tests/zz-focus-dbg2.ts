import { GpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, dispatchPayload, materializeRoot, setViewport } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';

installGlobals();
const renderer = new GpuixRenderer((err: any, payload: any) => { if (!err) dispatchPayload(payload); });
setRenderer(renderer);
renderer.init({ title: 'nodrag probe', width: 700, height: 400, titlebarTransparent: true, appOwnsTitlebarDrag: true });
setViewport(700, 400);

const target = doc.createElement('div');
target.setAttribute('style', 'display:flex;flex-direction:column;width:100%;height:100%');
doc.body.appendChild(target);
materializeRoot(target);

const bar = doc.createElement('div');
bar.setAttribute('style', 'display:flex;flex-direction:row;align-items:center;height:38px;padding-left:84px;background-color:#26262d');
bar.setAttribute('data-window-drag', '');
const title = doc.createElement('div');
title.setAttribute('style', 'flex:1;text-align:center;font-size:12px');
title.textContent = 'probe-title';
const btn = doc.createElement('div');
btn.setAttribute('style', 'padding:4px 10px;background-color:#0a84ff;color:#fff;font-size:12px');
btn.textContent = 'count: 0';
const input = doc.createElement('input');
input.setAttribute('style', 'width:90px;margin-left:8px;font-size:12px');
const tbFocus = doc.createElement('div');
tbFocus.setAttribute('tabindex', '0');
tbFocus.setAttribute('style', 'margin-left:8px;padding:2px 6px;background-color:#3a3a42;font-size:12px');
tbFocus.textContent = 'tb-focus';
const del = doc.createElement('div');
del.setAttribute('style', 'margin-left:8px;padding:2px 6px;background-color:#3a3a42;font-size:12px');
del.textContent = 'delegated';
bar.appendChild(title); bar.appendChild(btn); bar.appendChild(input); bar.appendChild(tbFocus); bar.appendChild(del);
target.appendChild(bar);
const bodyFocus = doc.createElement('div');
bodyFocus.setAttribute('tabindex', '0');
bodyFocus.setAttribute('style', 'margin:24px;padding:12px;background-color:#1c1c22;font-size:12px');
bodyFocus.textContent = 'body-focus';
target.appendChild(bodyFocus);

let hits: string[] = [];
for (const [n, el] of [['btn', btn], ['input', input], ['tbFocus', tbFocus], ['del', del], ['bodyFocus', bodyFocus], ['title', title], ['bar', bar]] as const) {
	el.addEventListener('mousedown', () => hits.push(`${n}-mdown`));
	el.addEventListener('focus', () => hits.push(`${n}-focus`));
	el.addEventListener('blur', () => hits.push(`${n}-blur`));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pump = async (n = 6) => { for (let i = 0; i < n; i++) { renderer.tick(16); flush(); drainAfterRender(); await sleep(20); } };
function axFrame() {
	const r = Bun.spawnSync(['swift', '-e', `
import Cocoa
let all = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as! [[String: Any]]
var best: [String: CGFloat]?; var area: CGFloat = 0
for w in all {
  guard (w[kCGWindowOwnerPID as String] as? Int) == ${process.pid},
        (w[kCGWindowLayer as String] as? Int) == 0,
        let b = w[kCGWindowBounds as String] as? [String: CGFloat],
        let h = b["Height"], let wd = b["Width"], h * wd > area, h > 100 else { continue }
  best = b; area = h * wd
}
if let b = best { print("\\(Int(b["X"]!)) \\(Int(b["Y"]!)) \\(Int(b["Width"]!)) \\(Int(b["Height"]!))") } else { print("none") }
`]);
	return new TextDecoder().decode(r.stdout).trim().split(' ').map(Number);
}
const clickEl = (el: any, name: string, kind = 'click') => {
	const bd = renderer.getElementBounds(el.nativeId);
	const f = axFrame();
	const x = Math.round(f[0] + bd.x + bd.width / 2), y = Math.round(f[1] + bd.y + bd.height / 2);
	console.log(`${kind} ${name}@(${x},${y}) bounds=${JSON.stringify(bd)}`);
	Bun.spawnSync(['swift', 'bin/cge.swift', kind, String(x), String(y)]);
};

await pump(10);
console.log('frame', axFrame(), 'btn', btn.nativeId, 'input', input.nativeId, 'tbFocus', tbFocus.nativeId, 'del', del.nativeId, 'bodyFocus', bodyFocus.nativeId);
console.log('tree', renderer.getAutomationTree().slice(0, 1400));
clickEl(input, 'input');
await pump(10);
console.log('after input click — hits:', hits.join(','), '| focused:', renderer.getFocusedElementId());
hits = [];
clickEl(tbFocus, 'tbFocus');
await pump(10);
console.log('after tbFocus click — hits:', hits.join(','), '| focused:', renderer.getFocusedElementId());
hits = [];
clickEl(tbFocus, 'tbFocus', 'dbl');
await pump(10);
console.log('after tbFocus dbl — hits:', hits.join(','), '| focused:', renderer.getFocusedElementId());
hits = [];
clickEl(bodyFocus, 'bodyFocus');
await pump(10);
console.log('after bodyFocus click — hits:', hits.join(','), '| focused:', renderer.getFocusedElementId());
process.exit(0);
