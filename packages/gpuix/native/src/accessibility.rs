//! GPUI accessibility props from React custom_props.
//!
//! A node reaches AccessKit only with both an `.id(...)` and a `.role(...)`.
//! GPUIX already sets the id. This module sets the role and ARIA fields.
//! Prop names match React DOM: `aria-label`, not `ariaLabel`.

use std::collections::HashMap;

use gpui::prelude::*;
use gpui::{AccessibleAction, Orientation, Role, Toggled};

use crate::element_tree::EventPayload;
use crate::renderer::{emit_event_full, EventCallback};

/// Apply `role` and `aria-*` from React, plus a default role when the app
/// did not set one. `none` / `presentation` produce no node.
pub(crate) fn apply_accessibility<E>(
    mut el: E,
    props: &HashMap<String, serde_json::Value>,
    default_role: Option<Role>,
) -> E
where
    E: StatefulInteractiveElement,
{
    let explicit = props.get("role").and_then(|value| value.as_str());
    if matches!(explicit, Some("none" | "presentation")) {
        return el;
    }

    let role = explicit
        .and_then(role_from_aria)
        .or(default_role)
        .filter(|role| *role != Role::GenericContainer);
    let Some(role) = role else {
        return el;
    };
    el = el.role(role);

    if let Some(id) = string_prop(props, "aria-id") {
        el = el.accessibility_id(id);
    }
    if let Some(label) = string_prop(props, "aria-label") {
        el = el.aria_label(label);
    }
    if let Some(description) = string_prop(props, "aria-description") {
        el = el.aria_description(description);
    }
    if let Some(value) = string_prop(props, "aria-valuetext") {
        el = el.aria_value(value);
    }
    if let Some(expanded) = bool_prop(props, "aria-expanded") {
        el = el.aria_expanded(expanded);
    }
    if let Some(selected) = bool_prop(props, "aria-selected") {
        el = el.aria_selected(selected);
    }
    if let Some(level) = usize_prop(props, "aria-level") {
        el = el.aria_level(level);
    }
    if let Some(keyshortcuts) = string_prop(props, "aria-keyshortcuts") {
        el = el.aria_keyshortcuts(keyshortcuts);
    }
    // aria-pressed is a tristate: true / false / mixed.
    match props.get("aria-pressed") {
        Some(serde_json::Value::Bool(true)) => el = el.aria_toggled(Toggled::True),
        Some(serde_json::Value::Bool(false)) => el = el.aria_toggled(Toggled::False),
        Some(serde_json::Value::String(s)) if s == "mixed" => el = el.aria_toggled(Toggled::Mixed),
        _ => {}
    }
    // aria-checked is the same tristate — what checkbox/switch/radio emit.
    match props.get("aria-checked") {
        Some(serde_json::Value::Bool(true)) => el = el.aria_toggled(Toggled::True),
        Some(serde_json::Value::Bool(false)) => el = el.aria_toggled(Toggled::False),
        Some(serde_json::Value::String(s)) if s == "mixed" => el = el.aria_toggled(Toggled::Mixed),
        _ => {}
    }
    if let Some(value) = f64_prop(props, "aria-valuenow") {
        el = el.aria_numeric_value(value);
    }
    if let Some(value) = f64_prop(props, "aria-valuemin") {
        el = el.aria_min_numeric_value(value);
    }
    if let Some(value) = f64_prop(props, "aria-valuemax") {
        el = el.aria_max_numeric_value(value);
    }
    if let Some(placeholder) = string_prop(props, "aria-placeholder") {
        el = el.aria_placeholder(placeholder);
    }
    match string_prop(props, "aria-orientation").as_deref() {
        Some("horizontal") => el = el.aria_orientation(Orientation::Horizontal),
        Some("vertical") => el = el.aria_orientation(Orientation::Vertical),
        _ => {}
    }
    if let Some(position) = usize_prop(props, "aria-posinset") {
        el = el.aria_position_in_set(position);
    }
    if let Some(size) = usize_prop(props, "aria-setsize") {
        el = el.aria_size_of_set(size);
    }
    if let Some(index) = usize_prop(props, "aria-rowindex") {
        el = el.aria_row_index(index);
    }
    if let Some(index) = usize_prop(props, "aria-colindex") {
        el = el.aria_column_index(index);
    }
    if let Some(count) = usize_prop(props, "aria-rowcount") {
        el = el.aria_row_count(count);
    }
    if let Some(count) = usize_prop(props, "aria-colcount") {
        el = el.aria_column_count(count);
    }
    if let Some(disabled) = bool_prop(props, "aria-disabled") {
        el = el.aria_disabled(disabled);
    }
    if let Some(busy) = bool_prop(props, "aria-busy") {
        el = el.aria_busy(busy);
    }
    if let Some(hidden) = bool_prop(props, "aria-hidden") {
        el = el.aria_hidden(hidden);
    }
    if let Some(modal) = bool_prop(props, "aria-modal") {
        el = el.aria_modal(modal);
    }
    if let Some(read_only) = bool_prop(props, "aria-readonly") {
        el = el.aria_read_only(read_only);
    }
    if let Some(required) = bool_prop(props, "aria-required") {
        el = el.aria_required(required);
    }
    if let Some(description) = string_prop(props, "aria-roledescription") {
        el = el.aria_role_description(description);
    }
    match string_prop(props, "aria-live").as_deref() {
        Some("off") => el = el.aria_live(gpui::accesskit::Live::Off),
        Some("polite") => el = el.aria_live(gpui::accesskit::Live::Polite),
        Some("assertive") => el = el.aria_live(gpui::accesskit::Live::Assertive),
        _ => {}
    }
    match string_prop(props, "aria-invalid").as_deref() {
        Some("true") => el = el.aria_invalid(gpui::accesskit::Invalid::True),
        Some("grammar") => el = el.aria_invalid(gpui::accesskit::Invalid::Grammar),
        Some("spelling") => el = el.aria_invalid(gpui::accesskit::Invalid::Spelling),
        _ => {}
    }
    // `aria-haspopup="true"` is the ARIA 1.2 alias for "menu".
    match string_prop(props, "aria-haspopup").as_deref() {
        Some("menu" | "true") => el = el.aria_has_popup(gpui::accesskit::HasPopup::Menu),
        Some("listbox") => el = el.aria_has_popup(gpui::accesskit::HasPopup::Listbox),
        Some("tree") => el = el.aria_has_popup(gpui::accesskit::HasPopup::Tree),
        Some("grid") => el = el.aria_has_popup(gpui::accesskit::HasPopup::Grid),
        Some("dialog") => el = el.aria_has_popup(gpui::accesskit::HasPopup::Dialog),
        _ => {}
    }
    // Reference attrs need author_id → NodeId resolution that accesskit does
    // not provide at node-build time: aria-controls, aria-owns,
    // aria-describedby, aria-details.
    el
}

/// `aria-label`, or `alt` when that is empty. Used by `<img>`.
pub(crate) fn apply_image_label<E>(
    el: E,
    props: &HashMap<String, serde_json::Value>,
    alt: &str,
) -> E
where
    E: StatefulInteractiveElement,
{
    if props.get("aria-label").is_some() || alt.is_empty() {
        return el;
    }
    el.aria_label(alt.to_string())
}

/// VoiceOver Press. GPUI auto-adds Click only for `.on_click()`. GPUIX
/// click is `on_mouse_up`, so register the action by hand and emit the
/// same JS `click` event.
pub(crate) fn apply_a11y_click<E>(
    el: E,
    wants_click: bool,
    element_id: u64,
    callback: &Option<EventCallback>,
) -> E
where
    E: StatefulInteractiveElement,
{
    if !wants_click {
        return el;
    }
    let callback = callback.clone();
    el.on_a11y_action(AccessibleAction::Click, move |_data, _window, _cx| {
        emit_event_full(
            &callback,
            element_id,
            "click",
            |payload: &mut EventPayload| {
                payload.button = Some(0);
                payload.click_count = Some(1);
                payload.is_right_click = Some(false);
            },
        );
    })
}

fn string_prop(props: &HashMap<String, serde_json::Value>, key: &str) -> Option<String> {
    props
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .filter(|value| !value.is_empty())
}

fn bool_prop(props: &HashMap<String, serde_json::Value>, key: &str) -> Option<bool> {
    props.get(key).and_then(|value| value.as_bool())
}

fn f64_prop(props: &HashMap<String, serde_json::Value>, key: &str) -> Option<f64> {
    props
        .get(key)
        .and_then(|value| value.as_f64())
        .filter(|value| value.is_finite())
}

fn usize_prop(props: &HashMap<String, serde_json::Value>, key: &str) -> Option<usize> {
    props
        .get(key)
        .and_then(|value| value.as_u64())
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
}

/// ARIA token → AccessKit role. Unknown tokens are ignored, like a bad style.
fn role_from_aria(token: &str) -> Option<Role> {
    Some(match token {
        "alert" => Role::Alert,
        "alertdialog" => Role::AlertDialog,
        "application" => Role::Application,
        "article" => Role::Article,
        "banner" => Role::Banner,
        "blockquote" => Role::Blockquote,
        "button" => Role::Button,
        "caption" => Role::Caption,
        "cell" => Role::Cell,
        "checkbox" => Role::CheckBox,
        "code" => Role::Code,
        "columnheader" => Role::ColumnHeader,
        "combobox" => Role::ComboBox,
        "complementary" => Role::Complementary,
        "contentinfo" => Role::ContentInfo,
        "definition" => Role::Definition,
        "deletion" => Role::ContentDeletion,
        "dialog" => Role::Dialog,
        "document" => Role::Document,
        "emphasis" => Role::Emphasis,
        "feed" => Role::Feed,
        "figure" => Role::Figure,
        "form" => Role::Form,
        "generic" => Role::GenericContainer,
        "grid" => Role::Grid,
        "gridcell" => Role::GridCell,
        "group" => Role::Group,
        "heading" => Role::Heading,
        "img" => Role::Image,
        "insertion" => Role::ContentInsertion,
        "link" => Role::Link,
        "list" => Role::List,
        "listbox" => Role::ListBox,
        "listitem" => Role::ListItem,
        "log" => Role::Log,
        "main" => Role::Main,
        "marquee" => Role::Marquee,
        "math" => Role::Math,
        "menu" => Role::Menu,
        "menubar" => Role::MenuBar,
        "menuitem" => Role::MenuItem,
        "menuitemcheckbox" => Role::MenuItemCheckBox,
        "menuitemradio" => Role::MenuItemRadio,
        "meter" => Role::Meter,
        "navigation" => Role::Navigation,
        "none" | "presentation" => Role::GenericContainer,
        "note" => Role::Note,
        "option" => Role::ListBoxOption,
        "paragraph" => Role::Paragraph,
        "progressbar" => Role::ProgressIndicator,
        "radio" => Role::RadioButton,
        "radiogroup" => Role::RadioGroup,
        "region" => Role::Region,
        "row" => Role::Row,
        "rowgroup" => Role::RowGroup,
        "rowheader" => Role::RowHeader,
        "scrollbar" => Role::ScrollBar,
        "search" => Role::Search,
        "searchbox" => Role::SearchInput,
        "separator" => Role::Splitter,
        "slider" => Role::Slider,
        "spinbutton" => Role::SpinButton,
        "status" => Role::Status,
        "strong" => Role::Strong,
        "subscript" => Role::GenericContainer,
        "superscript" => Role::GenericContainer,
        "switch" => Role::Switch,
        "tab" => Role::Tab,
        "table" => Role::Table,
        "tablist" => Role::TabList,
        "tabpanel" => Role::TabPanel,
        "term" => Role::Term,
        "textbox" => Role::TextInput,
        "time" => Role::Time,
        "timer" => Role::Timer,
        "toolbar" => Role::Toolbar,
        "tooltip" => Role::Tooltip,
        "tree" => Role::Tree,
        "treegrid" => Role::TreeGrid,
        "treeitem" => Role::TreeItem,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::role_from_aria;
    use gpui::Role;

    #[test]
    fn maps_common_aria_tokens() {
        assert_eq!(role_from_aria("button"), Some(Role::Button));
        assert_eq!(role_from_aria("heading"), Some(Role::Heading));
        assert_eq!(role_from_aria("textbox"), Some(Role::TextInput));
        assert_eq!(role_from_aria("img"), Some(Role::Image));
        assert_eq!(role_from_aria("option"), Some(Role::ListBoxOption));
        assert_eq!(role_from_aria("none"), Some(Role::GenericContainer));
        assert_eq!(role_from_aria("presentation"), Some(Role::GenericContainer));
        assert_eq!(role_from_aria("Button"), None);
        assert_eq!(role_from_aria("not-a-role"), None);
    }
}
