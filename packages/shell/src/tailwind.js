// Tailwind CSS plugin (v4): the shell's native materials as utilities.
//
//   @plugin '@svelte-desktop/shell/tailwind';
//
//   <aside class="material-sidebar bg-surface">           the material in the app, bg-surface in a browser
//   <div class="material-glass material-tint-primary/20 rounded-xl">
//   <div class="material-hud material-active">            stays vivid while the window is inactive
//   <div class="bg-surface material:bg-surface/40">       material: = where the shell draws materials
//
// `material-*` sets `--desktop-material` (src/host/materials.ts reads it) and, where the shell
// draws materials (html[data-desktop-materials]), a transparent background: elsewhere — a
// browser, Linux, Windows — the element keeps its own.
const MATERIALS = {
  sidebar: "sidebar",
  titlebar: "titlebar",
  header: "header",
  content: "content",
  window: "window",
  "under-window": "underWindow",
  "under-page": "underPage",
  menu: "menu",
  popover: "popover",
  sheet: "sheet",
  hud: "hud",
  tooltip: "tooltip",
  "fullscreen-ui": "fullscreenUI",
  selection: "selection",
  glass: "glass",
  "glass-clear": "glass-clear",
};

// Inside the app: `.material-x:is(html[data-desktop-materials] *)` — one class more specific than
// `bg-*`, so the transparent background wins over the element's own in the app.
const IN_APP = "&:is(html[data-desktop-materials] *)";

/** theme('colors') is nested ({ red: { 500: … } }): `red-500`, `primary`… */
function flatten(colors, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(colors ?? {})) {
    const name = key === "DEFAULT" ? prefix.replace(/-$/, "") : `${prefix}${key}`;
    if (value && typeof value === "object") flatten(value, `${name}-`, out);
    else if (typeof value === "string" || typeof value === "function") out[name] = value;
  }
  return out;
}

export default {
  handler({ addUtilities, matchUtilities, addVariant, theme }) {
    const utilities = { ".material-none": { "--desktop-material": "none" } };
    for (const [name, material] of Object.entries(MATERIALS))
      utilities[`.material-${name}`] = { "--desktop-material": material, [IN_APP]: { "background-color": "transparent", "background-image": "none" } };
    utilities[".material-active"] = { "--desktop-material-state": "active" };
    utilities[".material-inactive"] = { "--desktop-material-state": "inactive" };
    addUtilities(utilities);

    // A tint over the glass (any CSS color; /20 for its strength).
    matchUtilities({ "material-tint": (value) => ({ "--desktop-material-tint": value }) }, { values: flatten(theme("colors")), type: "color" });

    // Where the shell draws materials: a veil over one (`material:bg-white/30`), a layout of its own.
    addVariant("material", "html[data-desktop-materials] &");
  },
};
