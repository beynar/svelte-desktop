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
const sA = style({ p: 'md', bg: 'primary', radius: 'md' });
const sB = style({ p: 'md', bg: 'danger', radius: 'md' });
for (let i = 0; i < 100; i++) {
  const b = doc.createElement('button');
  applyNativeStyle(b, sA);
  const t = doc.createElement('span'); t.textContent = `row ${i}`;
  b.appendChild(t); root.appendChild(b); btns.push(b);
}
flush(); (renderer as any).flush(); drainAfterRender();

(renderer as any).resetDebugFrameOverlayStats();
for (let f = 0; f < 200; f++) {
  // paint-only mutation: bg flip on 2 elements — no size/text/layout change
  applyNativeStyle(btns[f % 100], f % 2 ? sB : sA);
  applyNativeStyle(btns[(f * 7) % 100], f % 2 ? sA : sB);
  flush(); (renderer as any).flush(); drainAfterRender();
}
console.log('color-flip frames:', JSON.stringify((renderer as any).getDebugFrameOverlayStats()));
