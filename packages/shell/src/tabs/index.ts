// Tabs: <WindowTabs> (the window's tabs: SvelteKit routes in the title bar) and <Tabs> (tabs in a
// page, on your items). Each one is configured by its props and drawn with snippets.
//   import { WindowTabs, Tabs, embedded } from '@svelte-desktop/shell/tabs';
export { default as WindowTabs } from "./WindowTabs.svelte";
export { default as Tabs } from "./Tabs.svelte";
export { embedded, routeMatcher, type TabGroup, type TabItem, type TabLike, type TabRender } from "./tabs.svelte.ts";
