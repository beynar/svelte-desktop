# Accessibility: manual test plan

For a person, with a screen reader. `test/docker/a11y.test.ts` covers what a machine can check on Linux; this covers what it can't: what's announced, in what order, and what can be reached. Nobody has run it yet.

Takes about an hour per system. A failure in a page's own content belongs to the example, not the framework: note it apart.

## Setup

Build the two examples, then open the built app (`bun install && bunx --bun vite build` in each):

- `examples/panes`: `<WindowTabs split>`, every tab in its own web view.
- `examples/dashboard`, started with `VITE_TABS_SPLIT=0`: tabs in the title bar, a kept-alive route (`/activity`), popovers.

| Screen reader | System | Start | Read next / activate | Notes |
| --- | --- | --- | --- | --- |
| VoiceOver | macOS | ⌘F5 | VO+→ / VO+Space (VO is ⌃⌥) | Also try with System Settings > Keyboard > Keyboard navigation on and off |
| NVDA | Windows | Ctrl+Alt+N | ↓ in browse mode / Enter | NVDA+Space toggles browse and focus modes. Note the mode on entering a tab list |
| Orca | Linux (GNOME, X11 and Wayland) | Super+Alt+S | Orca+↓ / Enter | Unset `NO_AT_BRIDGE` if you launch from a test shell |

Note the OS and engine version with your results. Pressing a key below means with the screen reader passing it through.

## A. Tab bar (both examples)

1. Move to the bar with Tab, or press F6. *Expect: the tab's title, "tab", selected, its position ("1 of 3"), the list's name ("Open pages"). Not "Close …".*
2. ← and →. *Expect: each tab announced as it's selected, and its content shown.*
3. Does the screen reader offer a way to learn Delete closes the tab (`aria-keyshortcuts`)? *Record what's said.*
4. ⇧→ on a tab. *Expect: focus stays, its new position is announced. If nothing's announced, that's a failure: a live region would be needed.*
5. Delete. *Expect: the next tab is announced at once. Focus isn't lost to the top of the page.*
6. Delete on a pinned tab, or the only tab of the main window. *Expect: nothing closes, focus stays.*
7. Reach the + button: Tab from the active tab. *Expect: "New tab, button", outside the list. A press opens a tab and something announces it: record what.*
8. With the VO cursor or browse mode, go through a tab's content. *Expect: the × isn't offered. The tab is one item.*

## B. Panels and content

1. Dashboard: Enter on a route tab. *Expect: focus in the page, the next Tab reaches the page's first control, and nothing is drawn around the page.*
2. Dashboard: open the kept-alive tab, then Enter on its tab. *Expect: focus in its page, its content read.*
3. F6 from there. *Expect: back on its tab, announced. F6 again: back in the page, where you were in it.*
4. From a web view, press Tab repeatedly past the last control. *Record where focus goes: this isn't known on any system. Check that you can't get stuck: F6 must always work.*
5. Hidden tabs: while another tab is shown, can the VO cursor or browse mode reach a kept-alive tab's page? *Expect: no.*
6. Is the empty panel in the window's page announced? *Record what's said, and whether moving past it reaches the view.*

## C. Panes (`examples/panes`)

1. ⌥→ on a tab in a pane with several. *Expect: a new pane, focus still on the tab, in its new bar, announced with its position.*
2. ⌥PageUp to move it back. *Expect: same, the empty pane gone.*
3. Open three panes, in different orders. Go through the window with the VO cursor or browse mode. *Record the order. Does it match the screen? Are the bars and the pages' content where you'd expect?*
4. Each pane: is it announced as a group named after its active tab?
5. Close a pane's last tab with Delete. *Expect: focus on the active tab of a remaining pane, announced.*
6. ⌘⌥] to change panes while in a view. *Expect: the new pane's page gets focus and something says so: record what.*
7. Tab to the line between two panes. *Expect: "Resize panes", separator, orientation, a value. Arrows change the value and it's announced. Enter makes the two equal.*
8. Sighted check: is the ring on the line visible, in light and dark, and over a page with a dark or a white background?

## D. Popovers and sheets (`examples/dashboard`, Native page)

1. Open a popover with the keyboard. *Expect: focus in the popover, its content announced. Record how it's announced: a dialog, a window, nothing?*
2. Escape. *Expect: closed, and focus back on the control that opened it. The code doesn't restore this explicitly: check it.*
3. A `style="panel"` popover from its global shortcut, with another app in front. *Expect: focus in it. Closed: focus back in the other app.*
4. A status item (macOS, tray elsewhere), with an icon and no label. *Record what it's called.* Then with a `tooltip`.
5. macOS sheets, each style. *Expect: focus in the sheet. Can the VO cursor leave it for the window behind? Record for each: `sheet`, attached, dialog.*

## E. Title bar and window

1. With a hidden or inset title bar: are the window's controls reachable (macOS)?
2. Windows and Linux, frameless: move and resize the window with the keyboard (Alt+Space).
3. Are the empty parts of the bar, which drag the window, skipped by the reading order?
4. Is the window's title the active tab's, in the panes example too?

## F. System settings (no screen reader needed)

Turn each on and off **while the app runs**. Show `host.system.accessibility` on a page or read it in the inspector.

| Setting | macOS | Windows | Linux | Expect |
| --- | --- | --- | --- | --- |
| Reduce motion | Display > Reduce motion | Animation effects off | GNOME: Animations off | `reduceMotion` follows at once. A popover and a dragged-out tab's window don't move. Note: macOS sheets still do |
| Contrast | Increase contrast | A contrast theme | High contrast | `highContrast` follows. Forced colors: tabs, ring, lines all visible |
| Transparency | Reduce transparency | Transparency effects off | — | `reduceTransparency` follows, materials go opaque |
| Differentiate without color | Yes | — | — | The value follows only on `host.system.init()`: known |

## Results

Copy for each run. A failure gets an issue, with what was said and what was expected.

| Date | System and engine | Screen reader, version | Section | Step | Result | What was said |
| --- | --- | --- | --- | --- | --- | --- |
