/// `<x-button>` — nkit's button as ONE native element.
///
/// The JS composite equivalent is a styled `div` + `text` child + listeners
/// (≈6 ops per button, and the label lives in a separate retained node). Here
/// the element owns its own appearance and semantics: one retained node, one
/// render dispatch, native hover/active/disabled states, `Role::Button`
/// materialized without the JS implicit-role map, and a native tab stop.
///
/// The recipe is svelai's `button.theme.ts` ported 1/1 to the token language:
/// variant encodes *shape* (solid/outline/soft/ghost/link), `color` is the ctx
/// prop that `color-*` refs resolve through, and `state-layer` becomes a
/// real currentColor overlay painted at the theme's hover/pressed opacities.
/// The wire carries only prop names; tokens resolve in Rust against the
/// inherited `TokenTheme` (a `theme` prop on any ancestor restyles it).
use std::collections::{HashMap, HashSet};

use gpui::prelude::*;
use gpui::AnimationExt;

use crate::recipe::{variant_token, Recipe};

use super::{custom_surface, CustomElement, CustomElementFactory, CustomRenderContext};

pub struct XButtonFactory;

impl CustomElementFactory for XButtonFactory {
    fn element_type(&self) -> &str {
        "x-button"
    }

    fn create(&self, _id: u64) -> Box<dyn CustomElement> {
        Box::new(XButtonElement {
            recipe: recipe(),
            variant_props: HashMap::new(),
            ctx_color: None,
        })
    }
}

/// svelai's `button.theme.ts`, in declaration order (size → variant → boolean
/// gates), authored in the token language. `stateLayer` resolves out of the
/// merged style into `ResolvedStyle::state_layer` — the overlay is painted by
/// the element, not the style engine. svelai's dead `color` variant axis is
/// the ctx prop here; the neutral-outline compound still matches on it.
fn recipe() -> Recipe {
    Recipe::from_json(&serde_json::json!({
        "base": {
            "display": "flex",
            "flexShrink": 0,
            "alignItems": "center",
            "justifyContent": "center",
            "whiteSpace": "nowrap",
            "position": "relative",
            "overflow": "hidden",
            "cursor": "pointer",
            "userSelect": "none",
            "borderRadius": "md",
            "borderWidth": 1,
            "borderColor": "transparent",
            "fontWeight": 500,
            "fontSize": "sm"
            // svelai's `active:translate-y-px` is intentionally NOT ported:
            // gpui has no transform, and `inset.top` *replaces* positioning —
            // an absolute `top:60` button teleported to `top:1` mid-press and
            // the click fell outside the hitbox. The state-layer overlay
            // carries the press affordance instead.
        },
        "variants": {
            "size": {
                "small": {
                    "height": "control-sm", "paddingLeft": "md",
                    "paddingRight": "md", "gap": "sm", "fontSize": "xs"
                },
                "normal": {
                    "height": "control-md", "paddingLeft": "lg",
                    "paddingRight": "lg", "gap": "md", "fontSize": "sm"
                },
                "large": {
                    "height": "control-lg", "paddingLeft": "xl",
                    "paddingRight": "xl", "gap": "md", "fontSize": "sm"
                }
            },
            "variant": {
                "solid": {
                    "stateLayer": true,
                    "backgroundColor": "color", "color": "color-contrast"
                },
                "outline": {
                    "stateLayer": true,
                    "backgroundColor": "color/0", "borderColor": "color",
                    "color": "color-readable"
                },
                "soft": {
                    "stateLayer": true,
                    "backgroundColor": "color-muted",
                    "color": "color-muted-readable"
                },
                "ghost": {
                    "stateLayer": true,
                    "backgroundColor": "color/0", "color": "color-readable"
                },
                "link": {
                    "backgroundColor": "transparent", "color": "color-readable",
                    "hover": { "textDecoration": "underline" }
                }
            },
            "loading": {
                "true": { "cursor": "default", "pointerEvents": "none" },
                "false": null
            },
            "disabled": {
                "true": {
                    "opacity": 0.5, "cursor": "not-allowed",
                    "pointerEvents": "none"
                },
                "false": null
            },
            // svelai `aspect-square !px-0` verbatim — aspect-ratio computes
            // the width from the height for any size.
            "squared": {
                "true": { "aspectRatio": 1, "paddingLeft": 0, "paddingRight": 0 },
                "false": null
            },
            "fullWidth": {
                "true": { "width": "full", "maxWidth": "full" },
                "false": null
            }
        },
        "compoundVariants": [
            // svelai: outline + neutral → border-neutral-muted
            { "color": "neutral", "variant": "outline",
              "style": { "borderColor": "neutral-muted" } }
        ],
        "defaultVariants": { "variant": "solid", "size": "normal" }
    }))
    .expect("x-button recipe is valid")
}

pub struct XButtonElement {
    recipe: Recipe,
    /// Current variant values: "variant" → "soft", "disabled" → "true"…
    variant_props: HashMap<String, String>,
    /// The `color` ctx prop — a palette name that `color-*` refs resolve
    /// through. `None` → inherited ctx, then the theme's `defaultColor`.
    ctx_color: Option<String>,
}

impl CustomElement for XButtonElement {
    fn render(
        &mut self,
        ctx: CustomRenderContext,
        _window: &mut gpui::Window,
        _cx: &mut gpui::Context<crate::renderer::GpuixView>,
    ) -> gpui::AnyElement {
        // svelai Button semantics: `href` makes it a link, the `label`/
        // `pressed`/`selected`/`expanded` props write their aria-* attrs, and
        // explicit aria-*/role props always win.
        let mut props_storage;
        let ctx = {
            let is_link = ctx
                .props
                .get("href")
                .and_then(|v| v.as_str())
                .is_some_and(|href| !href.is_empty());
            let needs = !ctx.props.contains_key("role")
                || (ctx.props.contains_key("label") && !ctx.props.contains_key("aria-label"))
                || (ctx.props.contains_key("pressed") && !ctx.props.contains_key("aria-pressed"))
                || (ctx.props.contains_key("selected") && !ctx.props.contains_key("aria-selected"))
                || (ctx.props.contains_key("expanded") && !ctx.props.contains_key("aria-expanded"));
            if !needs {
                ctx
            } else {
                props_storage = ctx.props.clone();
                if !props_storage.contains_key("role") {
                    props_storage.insert(
                        "role".to_string(),
                        serde_json::json!(if is_link { "link" } else { "button" }),
                    );
                }
                let alias =
                    |storage: &mut HashMap<String, serde_json::Value>, prop: &str, aria: &str| {
                        if !storage.contains_key(aria) {
                            if let Some(value) = storage.get(prop).cloned() {
                                storage.insert(aria.to_string(), value);
                            }
                        }
                    };
                alias(&mut props_storage, "label", "aria-label");
                alias(&mut props_storage, "pressed", "aria-pressed");
                alias(&mut props_storage, "selected", "aria-selected");
                alias(&mut props_storage, "expanded", "aria-expanded");
                CustomRenderContext {
                    props: &props_storage,
                    ..ctx
                }
            }
        };

        // `disabled` and `loading` are inert in svelai — no events, no
        // hover/active feedback, no tab stop. Truthy like the HTML attr:
        // anything but `false`/`""`/`null` counts.
        let inert = ["disabled", "loading"].iter().any(|key| {
            self.variant_props
                .get(*key)
                .is_some_and(|v| !v.is_empty() && v != "false")
        });
        let empty_events: HashSet<String> = HashSet::new();
        let ctx = if inert {
            CustomRenderContext {
                events: &empty_events,
                ..ctx
            }
        } else {
            ctx
        };

        let effective_color = self.ctx_color.as_deref().or(ctx.ctx_color);
        let resolved = self
            .recipe
            .style(&self.variant_props, ctx.tokens, effective_color);

        // Inert elements strip interactive substyles — pointer-events:none in
        // svelai means the element never enters :hover/:active, and it never
        // receives focus so the focus buckets go too.
        let mut stripped;
        let style = if inert {
            stripped = (*resolved.style).clone();
            stripped.hover = None;
            stripped.active = None;
            stripped.focus = None;
            stripped.focus_within = None;
            stripped.focus_visible = None;
            &stripped
        } else {
            &*resolved.style
        };

        let group = gpui::SharedString::from(format!("xbutton-{}", ctx.id));
        let mut el = crate::renderer::apply_interactive_styles(
            gpui::div()
                .id(gpui::SharedString::from(format!(
                    "__gpuix_xbutton_{}",
                    ctx.id
                )))
                .group(group.clone()),
            style,
        );

        // Native focus: the renderer allocates this element a FocusHandle
        // (tab stop) — focus-visible paints svelai's `ring-2 ring-color/50`.
        // An inert button keeps its handle but never tracks it, so it drops
        // out of the tab order like svelai's `tabindex=-1`.
        if !inert {
            if let Some(handle) = ctx.focus_handle {
                let ring = ctx
                    .tokens
                    .resolve_color("color/50", effective_color)
                    .and_then(|hex| crate::color::parse_color_rgba(&hex));
                el = el.track_focus(handle).focus_visible(move |mut refinement| {
                    if let Some(color) = ring {
                        refinement.box_shadow = Some(vec![gpui::BoxShadow::new(
                            gpui::px(0.),
                            gpui::px(0.),
                            color.into(),
                        )
                        .spread_radius(gpui::px(2.))]);
                    }
                    refinement
                });
            }

            // svelai's native <button>: Enter fires click on keydown, Space
            // on keyup. Declared keyDown/keyUp listeners still see the raw
            // event first.
            {
                let id = ctx.id;
                let emit_keys = ctx.events.contains("keyDown");
                let callback = ctx.event_callback.clone();
                el = el.on_key_down(move |key_event, _window, _cx| {
                    if emit_keys {
                        crate::renderer::emit_event_full(&callback, id, "keyDown", |p| {
                            p.key = Some(key_event.keystroke.key.clone());
                            p.key_char = key_event.keystroke.key_char.clone();
                            p.is_held = Some(key_event.is_held);
                            p.modifiers = Some(key_event.keystroke.modifiers.into());
                        });
                    }
                    if !key_event.is_held && key_event.keystroke.key == "enter" {
                        crate::renderer::emit_event_full(&callback, id, "click", |p| {
                            p.button = Some(0);
                            p.click_count = Some(1);
                            p.is_right_click = Some(false);
                        });
                    }
                });
                let emit_keys = ctx.events.contains("keyUp");
                let callback = ctx.event_callback.clone();
                el = el.on_key_up(move |key_event, _window, _cx| {
                    if emit_keys {
                        crate::renderer::emit_event_full(&callback, id, "keyUp", |p| {
                            p.key = Some(key_event.keystroke.key.clone());
                            p.key_char = key_event.keystroke.key_char.clone();
                            p.modifiers = Some(key_event.keystroke.modifiers.into());
                        });
                    }
                    if matches!(key_event.keystroke.key.as_str(), "space" | " ") {
                        crate::renderer::emit_event_full(&callback, id, "click", |p| {
                            p.button = Some(0);
                            p.click_count = Some(1);
                            p.is_right_click = Some(false);
                        });
                    }
                });
            }
        }

        // state-layer: a currentColor wash at the theme's hover/pressed
        // opacities. Painted under the children like svelai's ::before.
        if resolved.state_layer && !inert {
            if let Some(text) = style
                .color
                .as_deref()
                .and_then(crate::color::parse_color_rgba)
            {
                let hover = ctx.tokens.state_hover_opacity as f32;
                let pressed = ctx.tokens.state_pressed_opacity as f32;
                let radius = style.border_radius.unwrap_or(0.) as f32;
                el = el.child(
                    gpui::div()
                        .id(gpui::SharedString::from(format!(
                            "xbutton-layer-{}",
                            ctx.id
                        )))
                        .absolute()
                        .inset_0()
                        .rounded(gpui::px(radius))
                        .bg(text)
                        .opacity(0.)
                        .group_hover(group.clone(), move |s| s.opacity(hover))
                        .group_active(group.clone(), move |s| s.opacity(pressed)),
                );
            }
        }

        // svelai `spinnerOverlay`: while `loading`, a `bg-surface/85` overlay
        // covers the label with a spinner on top. gpui has no transform to
        // rotate a glyph, so the indicator pulses instead (gpui's animation
        // honors the OS reduce-motion setting automatically).
        let loading = self
            .variant_props
            .get("loading")
            .is_some_and(|v| !v.is_empty() && v != "false");
        if loading {
            let radius = style.border_radius.unwrap_or(0.) as f32;
            let surface = ctx
                .tokens
                .resolve_color("surface/85", effective_color)
                .and_then(|hex| crate::color::parse_color_rgba(&hex))
                .map(gpui::Hsla::from);
            let dot = ctx
                .tokens
                .resolve_color("color-readable", effective_color)
                .and_then(|hex| crate::color::parse_color_rgba(&hex))
                .map(gpui::Hsla::from);
            let mut overlay = gpui::div()
                .id(gpui::SharedString::from(format!(
                    "xbutton-loading-{}",
                    ctx.id
                )))
                .absolute()
                .inset_0()
                .rounded(gpui::px(radius))
                .flex()
                .items_center()
                .justify_center();
            if let Some(surface) = surface {
                overlay = overlay.bg(surface);
            }
            if let Some(dot) = dot {
                overlay = overlay.child(
                    gpui::div()
                        .size(gpui::px(12.))
                        .rounded_full()
                        .bg(dot)
                        .with_animation(
                            gpui::ElementId::Name(format!("xbutton-spin-{}", ctx.id).into()),
                            gpui::Animation::new(std::time::Duration::from_secs(1))
                                .repeat()
                                .with_easing(gpui::pulsating_between(0.25, 1.0)),
                            |el, delta| el.opacity(delta),
                        ),
                );
            }
            el = el.child(overlay);
        }

        el = custom_surface(el, &ctx);
        el.children(ctx.children).into_any_element()
    }

    fn set_prop(&mut self, key: &str, value: serde_json::Value) {
        if key == "color" {
            self.ctx_color = value.as_str().map(str::to_string);
            return;
        }
        if self.recipe.handles(key) {
            if value.is_null() {
                self.variant_props.remove(key);
            } else {
                let mut token = variant_token(&value);
                // A bare boolean prop arrives as `""` — HTML-presence
                // semantics say that means `true` (`<x-button disabled>`).
                if token.is_empty() && self.recipe.is_bool_axis(key) {
                    token = "true".to_string();
                }
                self.variant_props.insert(key.to_string(), token);
            }
        }
    }

    fn supported_props(&self) -> &'static [&'static str] {
        &[
            "variant",
            "size",
            "color",
            "disabled",
            "loading",
            "squared",
            "fullWidth",
            // Anchor + a11y props — translated in render().
            "href",
            "label",
            "pressed",
            "selected",
            "expanded",
            "haspopup",
            "controls",
        ]
    }

    fn supported_events(&self) -> &'static [&'static str] {
        &[
            "click",
            "mouseEnter",
            "mouseLeave",
            "focus",
            "blur",
            "keyDown",
            "keyUp",
        ]
    }

    fn destroy(&mut self) {}
}
