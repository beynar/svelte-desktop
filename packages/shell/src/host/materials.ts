// Native materials from CSS (macOS): an element that declares one gets the system's material, or
// Liquid Glass, drawn behind it by the shell.
//
//   .sidebar { --desktop-material: sidebar; }                      (or data-desktop-material="sidebar")
//   .toolbar { --desktop-material: glass; --desktop-material-tint: #5f62ef30; }
//   .panel   { --desktop-material: hud; --desktop-material-state: active; border-radius: 12px; }
//
// The shell's page script registers the three properties as not inherited and sets
// html[data-desktop-materials] where they work. Here: find the elements that declare one (again
// when the DOM, the classes or the media change), and send their rects each frame they move, with
// their border radius and tint, to window.setMaterialRegions — native/platform_window.mm puts an
// effect view behind the web view at each place. The element (and what's under it in the page)
// must paint no background there, or it covers the material.
import { callPlatform } from "../platform/bus.ts";

interface Region {
  id: number;
  material: string;
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  tint?: string;
  state?: string;
}

const ids = new WeakMap<Element, number>();
let nextId = 1;
const idOf = (el: Element) => {
  let id = ids.get(el);
  if (!id) ids.set(el, (id = nextId++));
  return id;
};

/** A CSS color as #rrggbbaa (sRGB): what the native side reads. A canvas does the conversion
 *  (oklch, color-mix, named colors…). */
let ctx: CanvasRenderingContext2D | null | undefined;
const tints = new Map<string, string | undefined>();
function hexColor(css: string): string | undefined {
  if (tints.has(css)) return tints.get(css);
  ctx ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  let out: string | undefined;
  if (ctx) {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#00000000";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const px = ctx.getImageData(0, 0, 1, 1).data; // not premultiplied
    if (px[3]) out = `#${[...px].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }
  tints.set(css, out);
  return out;
}

const materialOf = (el: Element, style?: CSSStyleDeclaration): string => {
  const attr = el.getAttribute("data-desktop-material");
  if (attr) return attr.trim();
  const v = (style ?? getComputedStyle(el)).getPropertyValue("--desktop-material").trim();
  return v === "none" ? "" : v;
};

let installed = false;

export function installMaterials() {
  const root = document.documentElement;
  // The shell's page script sets the attribute once the document has its root element, which can
  // come after this module runs: look again then.
  if (!root.hasAttribute("data-desktop-materials")) {
    if (document.readyState !== "complete") {
      const again = () => !installed && root.hasAttribute("data-desktop-materials") && installMaterials();
      addEventListener("DOMContentLoaded", again, { once: true });
      addEventListener("load", again, { once: true });
    }
    return;
  }
  if (installed) return;
  installed = true;
  // A kept-alive tab's own web view: the shell draws materials behind the window's page only.
  if ("__desktopView" in globalThis) return void root.removeAttribute("data-desktop-materials");

  let elements: Element[] = [];
  let last = "";
  let shown = new Set<Element>();
  let rectsQueued = false;
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  const resize = new ResizeObserver(() => queueRects());

  // The elements that declare a material: their own value, not one inherited from a parent
  // (WebKit without @property inherits custom properties).
  function scan() {
    scanTimer = undefined;
    const found: Element[] = [];
    const visit = (el: Element, parent: string) => {
      const style = getComputedStyle(el);
      if (style.display === "none") return;
      const own = materialOf(el, style);
      if (own && own !== parent) found.push(el);
      for (let c = el.firstElementChild; c; c = c.nextElementSibling) visit(c, own);
    };
    visit(root, "");
    const changed = found.length !== elements.length || found.some((el, i) => el !== elements[i]);
    if (changed) {
      resize.disconnect();
      resize.observe(root);
      for (const el of found) resize.observe(el);
      elements = found;
    }
    queueRects();
  }
  const queueScan = (delay = 120) => {
    if (scanTimer === undefined) scanTimer = setTimeout(scan, delay);
  };

  function rects() {
    rectsQueued = false;
    const vw = root.clientWidth || innerWidth;
    const vh = innerHeight;
    const regions: Region[] = [];
    const drawn = new Set<Element>();
    for (const el of elements) {
      if (!el.isConnected) continue;
      const style = getComputedStyle(el);
      const material = materialOf(el, style);
      if (!material || style.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      const x = Math.max(0, r.left);
      const y = Math.max(0, r.top);
      const width = Math.min(vw, r.right) - x;
      const height = Math.min(vh, r.bottom) - y;
      if (width <= 0 || height <= 0) continue;
      const rawRadius = style.borderTopLeftRadius;
      const radius = rawRadius.endsWith("%") ? (Math.min(r.width, r.height) * parseFloat(rawRadius)) / 100 : parseFloat(rawRadius) || 0;
      const tintCss = style.getPropertyValue("--desktop-material-tint").trim();
      const state = style.getPropertyValue("--desktop-material-state").trim();
      drawn.add(el);
      regions.push({
        id: idOf(el),
        material,
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        width: Math.round(width * 100) / 100,
        height: Math.round(height * 100) / 100,
        radius: Math.min(radius, r.width / 2, r.height / 2),
        ...(tintCss && tintCss !== "none" ? { tint: hexColor(tintCss) } : {}),
        ...(state ? { state } : {}),
      });
    }
    // html[data-desktop-materials] [data-desktop-material-on]: drawn by the shell right now.
    for (const el of shown) if (!drawn.has(el)) el.removeAttribute("data-desktop-material-on");
    for (const el of drawn) if (!shown.has(el)) el.setAttribute("data-desktop-material-on", "");
    shown = drawn;
    const json = JSON.stringify(regions);
    if (json === last) return;
    last = json;
    callPlatform("window", "setMaterialRegions", { regions }).catch((e: { code?: string; message?: string }) => {
      if (e?.code === "unknown" || e?.code === "unsupported") root.removeAttribute("data-desktop-materials");
      else console.warn(`[desktop] --desktop-material: ${e?.message ?? e}`);
    });
  }
  // Next frame — or soon, when WebKit holds frames back (a window covered by others).
  function queueRects() {
    if (rectsQueued) return;
    rectsQueued = true;
    const run = () => rectsQueued && rects();
    requestAnimationFrame(run);
    setTimeout(run, 100);
  }

  // Elements, classes, styles and media change what declares a material; scrolling and
  // resizing move them.
  new MutationObserver(() => queueScan()).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "data-desktop-material", "data-theme", "hidden", "open"] });
  for (const q of ["(prefers-color-scheme: dark)", "(prefers-reduced-transparency: reduce)"]) matchMedia(q).addEventListener("change", () => queueScan(0));
  addEventListener("scroll", queueRects, { capture: true, passive: true });
  addEventListener("resize", queueRects);
  // While CSS transitions and animations run, elements can move without resizing: their rects
  // each frame until they end.
  let running = 0;
  const follow = () => {
    if (running <= 0) return;
    rects();
    requestAnimationFrame(follow);
  };
  const started = () => void (running++ === 0 && requestAnimationFrame(follow));
  const ended = () => {
    running = Math.max(0, running - 1);
    queueRects(); // where it ended
  };
  for (const type of ["transitionrun", "animationstart"]) addEventListener(type, started, true);
  for (const type of ["transitionend", "transitioncancel", "animationend", "animationcancel"]) addEventListener(type, ended, true);
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", () => scan(), { once: true });
  else scan();
  addEventListener("load", () => queueScan(0), { once: true });
}
