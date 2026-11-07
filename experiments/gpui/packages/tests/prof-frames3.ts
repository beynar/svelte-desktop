import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, materializeRoot } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush, drainAfterRender } from '@svelte-desktop/gpuix/native';
installGlobals();
const { default: themeCss } = await import('./gen/theme-css.js');
const st = doc.createElement('style'); st.textContent = themeCss; doc.head.appendChild(st);
const renderer = new TestGpuixRenderer(1180, 800);
setRenderer(renderer as any);
const { applyNativeStyle } = await import('@svelte-desktop/gpuix/gdom');
const { style } = await import('@svelte-desktop/gpuix/gen/nkit/style.js');
const root = doc.createElement('div');
doc.body.appendChild(root);
materializeRoot(root as any);
const btns: any[] = [];
const sA = style({ p: 'md', bg: 'primary', radius: 'md', w: 'full', h: 32 });
const sB = style({ p: 'md', bg: 'danger', radius: 'md', w: 'full', h: 32 });
const withText = process.env.TEXT !== '0';
for (let i = 0; i < 500; i++) {
  const b = doc.createElement('button');
  applyNativeStyle(b, sA);
  if (withText) { const t = doc.createElement('span'); t.textContent = `row ${i}`; b.appendChild(t); }
  root.appendChild(b); btns.push(b);
}
flush(); (renderer as any).flush(); drainAfterRender();
(renderer as any).resetDebugFrameOverlayStats();
for (let f = 0; f < 200; f++) {
  applyNativeStyle(btns[f % 500], f % 2 ? sB : sA);
  flush(); (renderer as any).flush(); drainAfterRender();
}
console.log(withText ? 'with-text' : 'no-text', JSON.stringify((renderer as any).getDebugFrameOverlayStats()));
