import { TestGpuixRenderer } from '@gpuix/native';
import { installGlobals, doc, materializeRoot } from '@svelte-desktop/gpuix/gdom';
import { setRenderer, flush } from '@svelte-desktop/gpuix/native';
installGlobals();
const { default: themeCss } = await import('./gen/theme-css.js');
const st = doc.createElement('style'); st.textContent = themeCss; doc.head.appendChild(st);
const renderer = new TestGpuixRenderer(1180, 800);
setRenderer(renderer as any);
const ROW = 'cn-sidebar-menu-button peer/menu-button flex w-full items-center overflow-hidden outline-hidden cn-sidebar-menu-button-variant-default cn-sidebar-menu-button-size-lg';
for (let round = 0; round < 5; round++) {
  const root = doc.createElement('div');
  doc.body.appendChild(root);
  materializeRoot(root as any);
  for (let i = 0; i < 500; i++) {
    const d = doc.createElement('div');
    d.className = ROW;
    const s = doc.createElement('span');
    s.className = 'bench-cell';
    s.textContent = `row ${i}`;
    d.appendChild(s);
    root.appendChild(d);
  }
  flush(); renderer.flush();
  root.remove();
}
