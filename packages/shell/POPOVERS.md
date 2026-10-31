# Popovers & menu-bar apps

A popover is **a route of your SvelteKit app** shown in a native macOS popover
(with the arrow) or in a borderless translucent panel (Spotlight-style). It runs
in its own WKWebView — same server, same session cookie, same remote functions,
same platform API and stores as the main window.

## 1. Author the content as a route

Put popover routes in their own group so they don't inherit the window chrome:

```
src/routes/
  +layout.svelte          {@render children()}   ← bare root
  (app)/+layout.svelte    nav, app.css, <StatusItem/>
  (app)/+page.svelte
  (popover)/+layout.svelte  popover.css (transparent, system font, light/dark)
  (popover)/quick/+page.svelte
```

```svelte
<!-- (popover)/quick/+page.svelte -->
<script lang="ts">
  import PopoverContent from '@svelte-desktop/shell/platform/PopoverContent.svelte';
  import { broadcast, closePopover } from '@svelte-desktop/shell/platform';
  import { addNote, getState } from '$lib/data.remote';
</script>

<PopoverContent>          <!-- transparent page + sizes the popover to this content -->
  <h3>Quick note</h3>
  <form {...addNote.enhance(async ({ submit }) => { await submit(); await broadcast('notes-changed'); })}>
    <input {...addNote.fields.text.as('text')} />
  </form>
  <button onclick={closePopover}>Done</button>
</PopoverContent>
```

`<PopoverContent fit="height|both|none" padding="12px">` — `height` (default)
keeps the width you gave and follows the content height; `both` uses
`max-content` width too.

## 2. Open it

**From the menu bar** — the app's status item:

```svelte
<StatusItem icon="note.text" tooltip="Quick note" popover="/quick" />
<StatusItem icon="note.text" popover={{ route: '/quick', width: 320 }} bind:open />
<StatusItem icon="bolt" style="panel" popover="/palette" position="tray" />
<StatusItem icon="bolt" style="panel" popover="/palette"
  position={({ width, height, displays }) => ({ x: displays[0].workArea.width / 2 - width / 2, y: 120 })} />
<StatusItem icon="note.text" items={[{ label: 'Quit', role: 'quit' }]} />   <!-- menu instead -->
<StatusItem icon="note.text" onClick={() => …} />                           <!-- plain click -->
```

Clicks toggle the popover **natively** (no round trip through the page), and a
click that dismissed a transient popover never reopens it.

**Anchored to an element of the page** (arrow points at it):

```svelte
<button bind:this={btn} onclick={() => (open = !open)}>😀</button>
<Popover route="/emoji" anchor={btn} bind:open width={260} height={120} edge="bottom" />
```

**Spotlight-style panel on a global hotkey** (works while the app is in the background):

```svelte
<Popover route="/palette" style="panel" position="center" shortcut="Ctrl+Alt+Space" width={520} />
```

**From code** (page or server):

```ts
import { popover } from '@svelte-desktop/shell/platform';
await popover.create({ id: 'quick', route: '/quick', width: 320, tray: true });
await popover.show('quick', { anchor: 'tray' | 'cursor' | { x, y, width, height } | { screen: {…} } });
await popover.toggle('quick'); await popover.hide('quick');
popover.onShown(({ id }) => …); popover.onHidden(…); popover.onResized(…);
```

## 3. Talk between the popover and the windows

Each popover is a separate page (separate JS context). Share state through:

- **the server** — remote functions/queries hit the same Bun process and database;
- **the stores** — every page receives native events (`theme.dark`, `window.*`, …);
- **broadcast** — `broadcast('channel', data)` / `onBroadcast('channel', fn)`
  reaches every window, every popover and server code (`from` tells who sent it).

```ts
// main window
onBroadcast('notes-changed', () => getState().refresh());
```

Inside a popover: `currentPopover()` → `{ id }`, `closePopover()`, and every
`popover.*` op defaults to the current popover.

## Behavior built in

| | |
|---|---|
| instant first open | the web view is created and loaded at `create`, kept warm in an invisible staging window (WKWebView doesn't paint while detached) |
| sized to content | `<PopoverContent>` reports its size; the popover and the warm view follow |
| no white flash | transparent page; the native material shows through |
| light dismiss | transient popovers close on outside click; panels on outside click, on another window taking focus, or on losing key |
| Escape | closes the focused popover (`closeOnEscape: false` to opt out) |
| keyboard | the app activates on show so inputs take keystrokes |
| reload-safe | deterministic ids: a page reload replaces the popover, never leaks a web view |
| security | the page bridge only answers the app origin's main frame; navigation policy as in windows |

Options: `style` popover|panel · `width` · `height` · `behavior`
transient|semitransient|manual · `edge` · `position` (panel) · `closeOnEscape` ·
`activate` · `transparent` · `animate` · `cornerRadius` · `debug` (Web Inspector).

Menu-bar-only app: adapter option `trayOnly: true` (no Dock icon) and
`window: { visible: false }` for a hidden main window.

## Tested

- `test/platform/popover.ts`: 31 native checks (create, warm load, injected id, bridge from the popover,
  `events.emit`, anchors, setSize, toggle, tray binding open/close, panel placement, destroy).
- The in-app e2e (`NOTES_E2E=1`) checks the real `<StatusItem>` popover: pre-warmed, renders `/quick` with server data,
  transparent page, auto-sized, and a tray click opens it. That's 14/14 checks on the stable and `--aot --trim` builds.
- Needs a human: Escape/click-outside on the arrow popover. Focus-based panel dismissal is skipped when macOS refuses activation
  (cooperative activation, app launched without user input).
