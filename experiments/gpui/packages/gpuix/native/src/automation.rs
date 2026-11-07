//! Shared automation host: paint bounds and a controllable motion clock.
//!
//! Record bounds during **paint**, not prepaint. The frame reset canvas
//! clears the map in paint, and GPUI prepaint runs for the whole tree
//! before any paint. A prepaint recorder would be wiped by the reset.
//!
//! TestGpuixRenderer and GpuixRenderer both use this so locators, screenshots,
//! and clock control do not fork between headless tests and a live window.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gpui::{
    canvas, point, px, App, Bounds, InputEvent, IntoElement, KeyDownEvent, KeyUpEvent, Keystroke,
    Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Styled, Window,
};
use web_time::Instant;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ElementBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl ElementBounds {
    fn from_gpui(bounds: Bounds<Pixels>) -> Self {
        Self {
            x: f64::from(f32::from(bounds.origin.x)),
            y: f64::from(f32::from(bounds.origin.y)),
            width: f64::from(f32::from(bounds.size.width)),
            height: f64::from(f32::from(bounds.size.height)),
        }
    }

    pub fn to_gpui(self) -> Bounds<Pixels> {
        Bounds {
            origin: point(px(self.x as f32), px(self.y as f32)),
            size: gpui::size(px(self.width as f32), px(self.height as f32)),
        }
    }
}

/// One recorded box plus the element's parent, so a moved or vanished child
/// can bump its parent's layout epoch at the frame reset.
#[derive(Clone, Copy)]
struct BoundsRec {
    bounds: ElementBounds,
    parent: Option<u64>,
    /// Owning window. Element ids are globally unique, but each view's
    /// frame reset must only drain its own rows — a shared map keyed by id
    /// alone would let alternating renders erase each other's boxes.
    window_id: u32,
}

thread_local! {
    /// Window whose view is mid-frame. Set at the top of every
    /// `GpuixView::render` / headless paint pass; `record_bounds` tags each
    /// row with it so the shared `BOUNDS`/`PREV_BOUNDS` maps stay
    /// per-window partitionable without threading the id through every
    /// build ctx. A view only ever paints elements of its own tree, so one
    /// cell is exact — there is no interleaved paint from another window
    /// inside a single frame.
    static PAINT_WINDOW: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// Mark the window about to paint. Call once per frame from the view's
/// render entry point, before any element build or paint closure runs.
pub(crate) fn set_paint_window(window_id: u32) {
    PAINT_WINDOW.with(|cell| cell.set(window_id));
}

pub(crate) fn paint_window_id() -> u32 {
    PAINT_WINDOW.with(|cell| cell.get())
}

thread_local! {
    static BOUNDS: RefCell<HashMap<u64, BoundsRec>> = RefCell::new(HashMap::new());
    /// Last frame's boxes. A subtree painted from the GPUI cache never runs its
    /// paint closures, so its boxes have to be re-registered from here.
    static PREV_BOUNDS: RefCell<HashMap<u64, BoundsRec>> =
        RefCell::new(HashMap::new());
    /// Per-parent counter bumped when a child's painted box changed **size**,
    /// appeared, or vanished. Pure translations don't bump it: a pinned leaf
    /// only fixes its size, and taffy still positions it every frame — a
    /// scrolled or reflow-shifted subtree replays correctly at its new origin.
    static LAYOUT_EPOCH: RefCell<HashMap<u64, u64>> = RefCell::new(HashMap::new());
}

/// Zero-size canvas. Keep it ahead of the app subtree under the root.
///
/// Everything here is recorded during **paint**, never prepaint: gpui's
/// `List::prepaint` speculatively prepaints a row range and can roll the window
/// back and prepaint a different one, so a prepaint-recorded box can belong to a
/// row that never reached the screen.
/// `window_id` scopes the reset to one view: `BOUNDS`/`PREV_BOUNDS` are shared
/// process-wide but every row is window-tagged, so this window's swap leaves
/// the neighbor's rows (and their epoch bookkeeping) untouched.
pub fn bounds_frame_reset(window_id: u32) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |_, _, _, _| {
            BOUNDS.with(|current| {
                PREV_BOUNDS.with(|prev| {
                    LAYOUT_EPOCH.with(|epochs| {
                        // Drain only this window's freshly-painted rows.
                        let finished: HashMap<u64, BoundsRec> = {
                            let mut current = current.borrow_mut();
                            let ids: Vec<u64> = current
                                .iter()
                                .filter(|(_, rec)| rec.window_id == window_id)
                                .map(|(id, _)| *id)
                                .collect();
                            ids.iter()
                                .filter_map(|id| current.remove(id).map(|rec| (*id, rec)))
                                .collect()
                        };
                        let mut prev = prev.borrow_mut();
                        let mut epochs = epochs.borrow_mut();
                        for (id, rec) in &finished {
                            let geometry_changed = match prev.get(id) {
                                Some(old) => {
                                    old.bounds.width != rec.bounds.width
                                        || old.bounds.height != rec.bounds.height
                                        || old.parent != rec.parent
                                }
                                None => true,
                            };
                            if geometry_changed {
                                if let Some(parent) = rec.parent {
                                    *epochs.entry(parent).or_insert(0) += 1;
                                }
                            }
                        }
                        for (id, old) in prev.iter() {
                            if !finished.contains_key(id) && old.window_id == window_id {
                                if let Some(parent) = old.parent {
                                    *epochs.entry(parent).or_insert(0) += 1;
                                }
                            }
                        }
                        // Swap only this window's slice of prev — other
                        // windows' rows stay until their own frame resets.
                        prev.retain(|_, old| old.window_id != window_id);
                        prev.extend(finished);
                    });
                });
            });
        },
    )
    .absolute()
    .w(px(0.0))
    .h(px(0.0))
}

/// Record this element's own painted box, with no extra element in the tree.
///
/// `bounds_tracker` needs a positioned parent and one canvas child, which a leaf
/// such as `gpui::img` cannot have. Wrapping the leaf in a div instead would
/// move the layout box: the wrapper would become the flex item and the image
/// would lose intrinsic sizing and corner clipping.
pub fn track_own_bounds<E: gpui::InteractiveElement>(el: E, id: u64, parent: Option<u64>) -> E {
    el.on_painted(move |bounds, window, _| {
        record_bounds(
            id,
            parent,
            window.element_transformation().apply_bounds(bounds),
        )
    })
}

pub fn record_bounds(id: u64, parent: Option<u64>, bounds: Bounds<Pixels>) {
    BOUNDS.with(|cell| {
        cell.borrow_mut().insert(
            id,
            BoundsRec {
                bounds: ElementBounds::from_gpui(bounds),
                parent,
                window_id: paint_window_id(),
            },
        );
    });
}

pub fn get_bounds(id: u64) -> Option<ElementBounds> {
    BOUNDS.with(|cell| cell.borrow().get(&id).map(|rec| rec.bounds))
}

/// Last frame's box for `id`, before the current reset.
pub(crate) fn prev_bounds(id: u64) -> Option<ElementBounds> {
    PREV_BOUNDS.with(|cell| cell.borrow().get(&id).map(|rec| rec.bounds))
}

/// How many times `id`'s children have resized, appeared, or vanished at
/// paint. Read by the memo key: a pin is only trustworthy while this stands
/// still. Position-only moves (scroll, reflow shifts) don't count.
pub(crate) fn layout_epoch(id: u64) -> u64 {
    LAYOUT_EPOCH.with(|cell| cell.borrow().get(&id).copied().unwrap_or(0))
}

/// Re-register last frame's boxes for a subtree whose paint was replayed from
/// the GPUI element cache: the cached elements never ran their paint closures,
/// so without this `get_bounds` loses every member for the whole frame.
/// `members` is `(id, parent)` in document order.
pub(crate) fn replay_bounds(members: &[(u64, Option<u64>)]) {
    BOUNDS.with(|current| {
        PREV_BOUNDS.with(|prev| {
            let prev = prev.borrow();
            let mut current = current.borrow_mut();
            for &(id, parent) in members {
                if let Some(rec) = prev.get(&id) {
                    current.insert(
                        id,
                        BoundsRec {
                            bounds: rec.bounds,
                            parent,
                            window_id: rec.window_id,
                        },
                    );
                }
            }
        });
    });
}

pub fn all_bounds() -> HashMap<u64, ElementBounds> {
    BOUNDS.with(|cell| {
        cell.borrow()
            .iter()
            .map(|(id, rec)| (*id, rec.bounds))
            .collect()
    })
}

/// Drop every bounds row a closed window owned. Called from the view's
/// `Drop` — without it a dead window's boxes would sit in the shared maps
/// forever. `LAYOUT_EPOCH` rows are parent-id keyed and unreachable once the
/// elements die, so they need no drain.
#[cfg(target_os = "macos")]
pub(crate) fn drop_window_bounds(window_id: u32) {
    BOUNDS
        .try_with(|cell| {
            cell.borrow_mut()
                .retain(|_, rec| rec.window_id != window_id)
        })
        .ok();
    PREV_BOUNDS
        .try_with(|cell| {
            cell.borrow_mut()
                .retain(|_, rec| rec.window_id != window_id)
        })
        .ok();
}

pub fn bounds_tracker(
    id: u64,
    parent: Option<u64>,
    selection_start: Option<bool>,
) -> impl IntoElement {
    canvas(
        |bounds, _, _| bounds,
        move |bounds, _, window, _| {
            // getBoundingClientRect answers in painted space — under an
            // element transform that's the transformed rect, like the DOM.
            let bounds = window.element_transformation().apply_bounds(bounds);
            record_bounds(id, parent, bounds);
            if let Some(selectable) = selection_start {
                crate::text::record_start_region(bounds, selectable);
            }
        },
    )
    .absolute()
    .size_full()
}

enum ClockMode {
    Live,
    Frozen { now: Instant },
}

struct ClockInner {
    origin: Instant,
    mode: ClockMode,
}

#[derive(Clone)]
pub struct AutomationClock {
    inner: Arc<Mutex<ClockInner>>,
}

impl Default for AutomationClock {
    fn default() -> Self {
        Self::new()
    }
}

impl AutomationClock {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(ClockInner {
                origin: Instant::now(),
                mode: ClockMode::Live,
            })),
        }
    }

    pub fn now(&self) -> Instant {
        let inner = self.inner.lock().unwrap();
        match inner.mode {
            ClockMode::Live => Instant::now(),
            ClockMode::Frozen { now } => now,
        }
    }

    #[allow(dead_code)]
    pub fn now_ms(&self) -> f64 {
        let inner = self.inner.lock().unwrap();
        current_instant(&inner)
            .saturating_duration_since(inner.origin)
            .as_secs_f64()
            * 1000.0
    }

    pub fn pause(&self) -> f64 {
        let mut inner = self.inner.lock().unwrap();
        let now = current_instant(&inner);
        inner.mode = ClockMode::Frozen { now };
        now.saturating_duration_since(inner.origin).as_secs_f64() * 1000.0
    }

    pub fn set_ms(&self, now_ms: f64) -> f64 {
        let mut inner = self.inner.lock().unwrap();
        let now = inner.origin + duration_ms(now_ms);
        inner.mode = ClockMode::Frozen { now };
        now_ms
    }

    pub fn fast_forward_ms(&self, delta_ms: f64) -> f64 {
        let mut inner = self.inner.lock().unwrap();
        let now = current_instant(&inner) + duration_ms(delta_ms);
        inner.mode = ClockMode::Frozen { now };
        now.saturating_duration_since(inner.origin).as_secs_f64() * 1000.0
    }

    pub fn resume(&self) -> f64 {
        let mut inner = self.inner.lock().unwrap();
        let elapsed = current_instant(&inner).saturating_duration_since(inner.origin);
        inner.origin = Instant::now() - elapsed;
        inner.mode = ClockMode::Live;
        elapsed.as_secs_f64() * 1000.0
    }
}

fn current_instant(inner: &ClockInner) -> Instant {
    match inner.mode {
        ClockMode::Live => Instant::now(),
        ClockMode::Frozen { now } => now,
    }
}

fn duration_ms(ms: f64) -> Duration {
    Duration::from_secs_f64((ms / 1000.0).max(0.0))
}

pub fn mouse_button(button: u32) -> MouseButton {
    match button {
        1 => MouseButton::Middle,
        2 => MouseButton::Right,
        _ => MouseButton::Left,
    }
}

/// Parse the held modifiers of a simulated mouse event from the same
/// hyphenated syntax `press("cmd-a")` already uses: `"cmd"`, `"cmd-shift"`,
/// `"alt"`. `None` and `""` mean no modifier. Unknown names are ignored, so a
/// typo weakens the gesture instead of failing the whole automation call.
///
/// A string, not an object, because the same value has to cross the napi, the
/// wasm and the stdio boundary, and only wasm makes objects awkward.
pub fn parse_modifiers(modifiers: Option<&str>) -> Modifiers {
    let mut parsed = Modifiers::default();
    let Some(text) = modifiers else {
        return parsed;
    };
    for part in text.split('-') {
        match part.trim().to_ascii_lowercase().as_str() {
            "cmd" | "meta" | "super" | "win" | "platform" => parsed.platform = true,
            "ctrl" | "control" => parsed.control = true,
            "alt" | "option" => parsed.alt = true,
            "shift" => parsed.shift = true,
            "fn" | "function" => parsed.function = true,
            _ => {}
        }
    }
    parsed
}

pub fn dispatch_keystrokes(
    window: &mut Window,
    cx: &mut App,
    keystrokes: &str,
) -> Result<(), String> {
    for keystroke in keystrokes.split(' ') {
        window.dispatch_keystroke(parse_keystroke(keystroke)?, cx);
    }
    Ok(())
}

pub fn dispatch_key_down(
    window: &mut Window,
    cx: &mut App,
    keystroke: &str,
    is_held: bool,
) -> Result<(), String> {
    window.dispatch_event(
        KeyDownEvent {
            keystroke: parse_keystroke(keystroke)?,
            is_held,
            prefer_character_input: false,
        }
        .to_platform_input(),
        cx,
    );
    Ok(())
}

pub fn dispatch_key_up(window: &mut Window, cx: &mut App, keystroke: &str) -> Result<(), String> {
    window.dispatch_event(
        KeyUpEvent {
            keystroke: parse_keystroke(keystroke)?,
        }
        .to_platform_input(),
        cx,
    );
    Ok(())
}

fn parse_keystroke(keystroke: &str) -> Result<Keystroke, String> {
    Keystroke::parse(keystroke).map_err(|error| format!("Invalid keystroke '{keystroke}': {error}"))
}

/// Every automation mouse dispatcher takes modifiers, so a test can drive
/// cmd-wheel zoom, shift-click range selection, or alt-drag duplication.
pub fn dispatch_click(
    window: &mut Window,
    cx: &mut App,
    x: f64,
    y: f64,
    button: u32,
    modifiers: Modifiers,
) {
    let position = point(px(x as f32), px(y as f32));
    let button = mouse_button(button);
    window.dispatch_event(
        MouseDownEvent {
            button,
            position,
            modifiers,
            click_count: 1,
            first_mouse: false,
        }
        .to_platform_input(),
        cx,
    );
    window.dispatch_event(
        MouseUpEvent {
            button,
            position,
            modifiers,
            click_count: 1,
        }
        .to_platform_input(),
        cx,
    );
}

pub fn dispatch_mouse_down(
    window: &mut Window,
    cx: &mut App,
    x: f64,
    y: f64,
    button: u32,
    modifiers: Modifiers,
) {
    window.dispatch_event(
        MouseDownEvent {
            button: mouse_button(button),
            position: point(px(x as f32), px(y as f32)),
            modifiers,
            click_count: 1,
            first_mouse: false,
        }
        .to_platform_input(),
        cx,
    );
}

pub fn dispatch_mouse_up(
    window: &mut Window,
    cx: &mut App,
    x: f64,
    y: f64,
    button: u32,
    modifiers: Modifiers,
) {
    window.dispatch_event(
        MouseUpEvent {
            button: mouse_button(button),
            position: point(px(x as f32), px(y as f32)),
            modifiers,
            click_count: 1,
        }
        .to_platform_input(),
        cx,
    );
}

pub fn dispatch_mouse_move(
    window: &mut Window,
    cx: &mut App,
    x: f64,
    y: f64,
    pressed_button: Option<u32>,
    modifiers: Modifiers,
) {
    window.dispatch_event(
        MouseMoveEvent {
            position: point(px(x as f32), px(y as f32)),
            pressed_button: pressed_button.map(mouse_button),
            modifiers,
        }
        .to_platform_input(),
        cx,
    );
}

pub fn dispatch_scroll_wheel(
    window: &mut Window,
    cx: &mut App,
    x: f64,
    y: f64,
    delta_x: f64,
    delta_y: f64,
    modifiers: Modifiers,
) {
    window.dispatch_event(
        gpui::ScrollWheelEvent {
            position: point(px(x as f32), px(y as f32)),
            delta: gpui::ScrollDelta::Pixels(point(px(delta_x as f32), px(delta_y as f32))),
            modifiers,
            touch_phase: gpui::TouchPhase::Moved,
        }
        .to_platform_input(),
        cx,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frozen_clock_holds_and_fast_forwards() {
        let clock = AutomationClock::new();
        clock.set_ms(0.0);
        assert!((clock.now_ms() - 0.0).abs() < 0.001);
        clock.fast_forward_ms(150.0);
        assert!((clock.now_ms() - 150.0).abs() < 0.001);
        let later = clock.now();
        clock.fast_forward_ms(150.0);
        assert_eq!(
            clock.now().saturating_duration_since(later),
            Duration::from_millis(150)
        );
    }
}
