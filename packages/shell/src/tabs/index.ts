// <WindowTabs>: the window's tabs, SvelteKit routes in the title bar, configured by its props and
// drawn with snippets.
//   import { WindowTabs, embedded } from '@svelte-desktop/shell/tabs';
export { default as WindowTabs } from "./WindowTabs.svelte";
export { embedded, routeMatcher, type TabGroup, type TabLike, type TabRender } from "./tabs.svelte.ts";
export type { PaneDrop, PaneLayout, PaneLeaf, PaneNode, PaneSplit, PaneZone } from "./panes.svelte.ts";
