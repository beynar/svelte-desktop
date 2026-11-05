//! `style_props` — the native StyleProps → StyleDesc-field mapping.
//!
//! This is the Rust port of `gpuix-poc/src/nkit/style.js`'s `applyProps`: the
//! props lane's vocabulary lives here so JS only ever sends raw style payloads
//! or variant choices. Output is a *symbolic* field map — token names cross
//! verbatim and `TokenTheme::resolve_style` owns value resolution, exactly
//! like a `setStyle` payload.
//!
//! Conflict semantics are StyleX application-order, not fixed property order:
//! shorthand members expand to their longhand fields in authored key order
//! (`preserve_order` keeps it across the wire), so `{px, p}` and `{p, px}`
//! resolve differently — last write wins per expanded field.

use serde_json::{Map, Value};

/// Pseudo buckets that have a native refinement channel.
const BUCKETS: [&str; 5] = ["hover", "active", "focus", "focusWithin", "focusVisible"];

/// Shorthand → longhand *vocab* keys. Expansion happens before mapping so
/// every emitted field is a leaf property; merge order then decides conflicts
/// the same way on every layer (props, recipe fragments, ad-hoc payloads).
/// `border` is value-dependent (bool → width group, string → color) and is
/// handled inline, not here.
fn expand(key: &str) -> Option<&'static [&'static str]> {
    match key {
        "p" | "padding" => Some(&["pt", "pr", "pb", "pl"]),
        "m" | "margin" => Some(&["mt", "mr", "mb", "ml"]),
        "overflow" => Some(&["overflowX", "overflowY"]),
        "borderW" | "borderWidth" => Some(&["borderT", "borderR", "borderB", "borderL"]),
        _ => None,
    }
}

// Named-scale gates — the same tables style.js validates against. Values still
// cross as names; `resolve_style` is the value authority. These gates only
// decide "plausible token" vs "audit drop".
const SPACING_NAMES: [&str; 12] = [
    "0",
    "micro",
    "xs",
    "sm",
    "md",
    "lg",
    "xl",
    "layout-sm",
    "layout-md",
    "layout-lg",
    "layout-xl",
    "px",
];
const RADIUS_NAMES: [&str; 10] = [
    "none", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl", "full",
];
const FONT_SIZE_NAMES: [&str; 13] = [
    "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl",
];
const FONT_W_NAMES: [&str; 4] = ["normal", "medium", "semibold", "bold"];
const GEOMETRY_KINDS: [&str; 5] = ["control", "row", "icon", "hit", "indent"];
const GEOMETRY_SIZES: [&str; 5] = ["xs", "sm", "md", "lg", "xl"];

fn is_numeric_str(s: &str) -> bool {
    let mut chars = s.chars().peekable();
    if chars.peek() == Some(&'-') {
        chars.next();
    }
    let mut digits = 0;
    let mut dots = 0;
    for c in chars {
        if c.is_ascii_digit() {
            digits += 1;
        } else if c == '.' {
            dots += 1;
        } else {
            return false;
        }
    }
    digits > 0 && dots <= 1
}

fn is_geometry_name(s: &str) -> bool {
    let Some((kind, size)) = s.split_once('-') else {
        return false;
    };
    GEOMETRY_KINDS.contains(&kind) && GEOMETRY_SIZES.contains(&size)
}

fn is_indent_name(s: &str) -> bool {
    s.strip_prefix("indent-")
        .is_some_and(|size| GEOMETRY_SIZES.contains(&size))
}

/// spacing-lane value: number, `px`, named scale, or numeric string.
fn space_value(v: &Value) -> Option<Value> {
    if v.is_number() {
        return Some(v.clone());
    }
    let s = v.as_str()?;
    if s == "px" {
        return Some(Value::from(1));
    }
    if SPACING_NAMES.contains(&s) || is_numeric_str(s) {
        return Some(v.clone());
    }
    None
}

/// dim-lane value: number, `fit`→`auto`, `full`/`auto`, `N%`/`Npx`, named
/// scale, or a geometry token like `control-md`.
fn dim_value(v: &Value) -> Option<Value> {
    if v.is_number() {
        return Some(v.clone());
    }
    let s = v.as_str()?;
    if s == "fit" {
        return Some(Value::from("auto"));
    }
    if s == "full" || s == "auto" {
        return Some(v.clone());
    }
    if s.ends_with('%') || s.ends_with("px") {
        let num = &s[..s.len() - if s.ends_with('%') { 1 } else { 2 }];
        if is_numeric_str(num) {
            return Some(v.clone());
        }
    }
    if SPACING_NAMES.contains(&s) || is_numeric_str(s) || is_geometry_name(s) {
        return Some(v.clone());
    }
    None
}

/// flex-basis lane: number, `N/M` fraction → `N%`, or a dim-lane value
/// (`auto`, `full`, named scale…). `field_kind("flexBasis")` is Dimension, so
/// the symbolic value still resolves through the theme layer afterward.
fn basis_value(v: &Value) -> Option<Value> {
    if let Some(s) = v.as_str() {
        if let Some((n, d)) = s.split_once('/') {
            if let (Ok(n), Ok(d)) = (n.parse::<f64>(), d.parse::<f64>()) {
                if d != 0.0 && n >= 0.0 {
                    return Some(Value::from(format!("{}%", n / d * 100.0)));
                }
            }
            return None;
        }
    }
    dim_value(v)
}

/// inset-lane value: number, named scale, numeric string, `indent-*`.
fn inset_value(v: &Value) -> Option<Value> {
    if v.is_number() {
        return Some(v.clone());
    }
    let s = v.as_str()?;
    if SPACING_NAMES.contains(&s) || is_numeric_str(s) || is_indent_name(s) {
        return Some(v.clone());
    }
    None
}

/// Color refs cross verbatim when they're plausible — palette membership is
/// `resolve_color`'s business (scoped palettes, ctx `color-*`, literals).
/// This gate only keeps malformed noise out of the wire grammar.
fn plausible_color(v: &Value) -> bool {
    let Some(s) = v.as_str() else {
        return false;
    };
    let base = s.split('/').next().unwrap_or(s);
    if base.is_empty() {
        return false;
    }
    // literal: #hex, rgb(), hsl(), oklch(), var()…
    if base.starts_with('#') || base.contains('(') {
        return true;
    }
    // name or name-variant chain: alpha word chars and dashes
    base.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && base
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn map_direction(v: &str) -> &str {
    match v {
        "col" | "column" => "column",
        "col-reverse" | "column-reverse" => "column-reverse",
        other => other,
    }
}

fn map_align(v: &str) -> &str {
    match v {
        "start" => "flex-start",
        "end" => "flex-end",
        other => other,
    }
}

fn map_justify(v: &str) -> &str {
    match v {
        "start" => "flex-start",
        "end" => "flex-end",
        "between" => "space-between",
        "around" => "space-around",
        "evenly" => "space-evenly",
        other => other,
    }
}

/// svelai's named box-shadow table (tokens.js `SHADOWS`) — literal objects,
/// not elevation levels (`raised-*` is the elevation lane).
fn named_shadow(name: &str) -> Option<Value> {
    let (dy, blur, spread, alpha) = match name {
        "xs" => (1.0, 2.0, 0.0, 0.35),
        "sm" => (1.0, 3.0, 0.0, 0.4),
        "md" => (4.0, 8.0, -1.0, 0.45),
        "lg" => (8.0, 16.0, -2.0, 0.5),
        _ => return None,
    };
    Some(serde_json::json!({
        "offsetX": 0, "offsetY": dy, "blurRadius": blur, "spreadRadius": spread,
        "color": format!("rgba(0,0,0,{alpha})"),
    }))
}

fn ring_shadow(w: &Value, color: Option<&str>, inset: bool) -> Value {
    let mut member = serde_json::json!({
        "offsetX": 0, "offsetY": 0, "blurRadius": 0,
        "spreadRadius": w, "color": color.unwrap_or("currentColor"), "ring": true,
    });
    if inset {
        member["inset"] = Value::Bool(true);
    }
    member
}

#[derive(Default)]
struct RingState {
    w: Option<Value>,
    c: Option<String>,
    inset: bool,
}

fn pad_fields(key: &str) -> &'static [&'static str] {
    match key {
        "px" => &["paddingLeft", "paddingRight"],
        "py" => &["paddingTop", "paddingBottom"],
        "pt" => &["paddingTop"],
        "pr" => &["paddingRight"],
        "pb" => &["paddingBottom"],
        "pl" | "ps" => &["paddingLeft"],
        _ => &["paddingRight"], // pe
    }
}

fn mar_fields(key: &str) -> &'static [&'static str] {
    match key {
        "mx" => &["marginLeft", "marginRight"],
        "my" => &["marginTop", "marginBottom"],
        "mt" => &["marginTop"],
        "mr" => &["marginRight"],
        "mb" => &["marginBottom"],
        "ml" | "ms" => &["marginLeft"],
        _ => &["marginRight"], // me
    }
}

/// Every field a vocab key can write — `null` deletes them so a later
/// fragment unsets what an earlier one wrote. Theme-ladder levels ship as
/// separate fragments (unmerged), so this is the only delete channel left on
/// the wire: `mergeProps`' key-level null can't reach us. Field-level delete
/// is broader than vocab-level (`{px:'sm'}` + `{p:null}` clears the px too —
/// `p` owns all four paddings) and that is the intended semantics for
/// "unset this prop".
fn key_fields(key: &str) -> &'static [&'static str] {
    match key {
        "display" => &["display"],
        "flex" | "row" | "col" | "column" => &["display", "flexDirection"],
        "grid" => &["display"],
        "direction" | "flexDirection" => &["flexDirection"],
        "wrap" | "flexWrap" => &["flexWrap"],
        "grow" | "flexGrow" => &["flexGrow"],
        "flex1" => &["flexGrow", "flexShrink"],
        "shrink" | "flexShrink" => &["flexShrink"],
        "basis" | "flexBasis" => &["flexBasis"],
        "items" | "alignItems" => &["alignItems"],
        "self" | "alignSelf" => &["alignSelf"],
        "justify" | "justifyContent" => &["justifyContent"],
        "content" | "alignContent" => &["alignContent"],
        "gap" => &["rowGap", "columnGap"],
        "rowGap" => &["rowGap"],
        "columnGap" => &["columnGap"],
        "gridCols" | "gridTemplateColumns" => &["gridTemplateColumns"],
        "gridRows" | "gridTemplateRows" => &["gridTemplateRows"],
        "p" | "padding" => &["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"],
        "m" | "margin" => &["marginTop", "marginRight", "marginBottom", "marginLeft"],
        // shorthand nulls arrive already expanded (expand() runs first), so
        // the longhand vocab keys need entries too.
        "px" | "py" | "pt" | "pr" | "pb" | "pl" | "ps" | "pe" => pad_fields(key),
        "mx" | "my" | "mt" | "mr" | "mb" | "ml" | "ms" | "me" => mar_fields(key),
        "control" => &["height"],
        "icon" => &["width", "height"],
        "w" | "width" => &["width"],
        "h" | "height" => &["height"],
        "minW" | "minWidth" => &["minWidth"],
        "minH" | "minHeight" => &["minHeight"],
        "maxW" | "maxWidth" => &["maxWidth"],
        "maxH" | "maxHeight" => &["maxHeight"],
        "aspect" | "aspectRatio" => &["aspectRatio"],
        "bg" | "backgroundColor" => &["backgroundColor"],
        "background" => &["background"],
        "fg" | "color" => &["color"],
        // `border` is value-dependent: bool → the four widths, string →
        // color. Null owns both — "unset border" means all of it.
        "border" => &[
            "borderColor",
            "borderTopWidth",
            "borderRightWidth",
            "borderBottomWidth",
            "borderLeftWidth",
        ],
        "borderColor" => &["borderColor"],
        "borderW" | "borderWidth" => &[
            "borderTopWidth",
            "borderRightWidth",
            "borderBottomWidth",
            "borderLeftWidth",
        ],
        "borderT" => &["borderTopWidth"],
        "borderR" => &["borderRightWidth"],
        "borderB" => &["borderBottomWidth"],
        "borderL" => &["borderLeftWidth"],
        "radius" | "borderRadius" => &["borderRadius"],
        "radiusTl" | "borderTopLeftRadius" => &["borderTopLeftRadius"],
        "radiusTr" | "borderTopRightRadius" => &["borderTopRightRadius"],
        "radiusBl" | "borderBottomLeftRadius" => &["borderBottomLeftRadius"],
        "radiusBr" | "borderBottomRightRadius" => &["borderBottomRightRadius"],
        "radiusT" => &["borderTopLeftRadius", "borderTopRightRadius"],
        "radiusB" => &["borderBottomLeftRadius", "borderBottomRightRadius"],
        "radiusL" => &["borderTopLeftRadius", "borderBottomLeftRadius"],
        "radiusR" => &["borderTopRightRadius", "borderBottomRightRadius"],
        // ring/shadow both own boxShadow; the ring accumulator is reset by
        // the caller (null on `ring`/`ringColor`/`ringInset` reaches us as
        // the key name, handled before this table is consulted).
        "shadow" | "boxShadow" => &["boxShadow"],
        "opacity" => &["opacity"],
        "overflow" => &["overflowX", "overflowY"],
        "overflowX" => &["overflowX"],
        "overflowY" => &["overflowY"],
        "visibility" => &["visibility"],
        "text" | "fontSize" => &["fontSize"],
        "fontW" | "fontWeight" => &["fontWeight"],
        "font" | "fontFamily" => &["fontFamily"],
        "align" | "textAlign" => &["textAlign"],
        "tracking" | "letterSpacing" => &["letterSpacing"],
        "lineHeight" => &["lineHeight"],
        "leading" | "lineHeightScale" => &["lineHeightScale"],
        "fontFeatures" => &["fontFeatures"],
        "textTransform" | "case" => &["textTransform"],
        "whitespace" | "whiteSpace" => &["whiteSpace"],
        "ellipsis" | "truncate" => &["whiteSpace", "textOverflow", "overflowX"],
        "lineClamp" => &["lineClamp"],
        "underline" | "textDecoration" | "lineThrough" => &["textDecoration"],
        "decoration" | "textDecorationColor" => &["textDecorationColor"],
        "italic" | "fontStyle" => &["fontStyle"],
        "absolute" | "fixed" | "position" => &["position"],
        "top" => &["top"],
        "right" => &["right"],
        "bottom" => &["bottom"],
        "left" => &["left"],
        "inset" => &["top", "right", "bottom", "left"],
        "cursor" => &["cursor"],
        "select" | "userSelect" => &["userSelect"],
        "pointerEvents" => &["pointerEvents"],
        "selectionColor" => &["selectionColor"],
        "stateLayer" => &["stateLayer"],
        "raised" => &["raised"],
        "lift" => &["lift"],
        // pseudo buckets: null drops the whole accumulated bucket.
        "hover" => &["hover"],
        "active" => &["active"],
        "focus" => &["focus"],
        "focusWithin" => &["focusWithin"],
        "focusVisible" => &["focusVisible"],
        _ => &[],
    }
}

/// One (key, value) → symbolic field entries into `out`. `origin` labels drops
/// with the authored key when a shorthand expanded.
fn apply_one(
    key: &str,
    v: &Value,
    origin: &str,
    out: &mut Map<String, Value>,
    dropped: &mut Vec<String>,
    ring: &mut RingState,
) {
    // null deletes the fields this key owns — the wire-level "unset" that
    // replaces mergeProps' vocab-level delete now that ladder levels ship
    // unmerged. false stays a skip (conditional-prop idiom).
    if v.is_null() {
        match key {
            // ring writes boxShadow only at stream end — null cancels the
            // pending accumulator but leaves an explicit `shadow` field.
            "ring" => ring.w = None,
            "ringColor" => ring.c = None,
            "ringInset" => ring.inset = false,
            _ => {
                for field in key_fields(key) {
                    out.shift_remove(*field);
                }
            }
        }
        return;
    }
    if v.as_bool() == Some(false) {
        return;
    }
    let s = v.as_str();
    // JS drop labels use string concat: `v` renders bare for strings.
    let v_label;
    macro_rules! drop_key {
        () => {{
            v_label = v
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| v.to_string());
            dropped.push(format!("{origin}:{v_label}"));
        }};
    }
    match key {
        // ── layout ──
        "display" => {
            if let Some(s) = s {
                out.insert("display".into(), s.into());
            }
        }
        "flex" => {
            out.insert("display".into(), "flex".into());
            out.entry(String::from("flexDirection"))
                .or_insert("row".into());
        }
        "grid" => {
            out.insert("display".into(), "grid".into());
        }
        "direction" | "flexDirection" => {
            if let Some(s) = s {
                out.insert("flexDirection".into(), map_direction(s).into());
            }
        }
        "row" => {
            out.insert("display".into(), "flex".into());
            out.insert("flexDirection".into(), "row".into());
        }
        "col" | "column" => {
            out.insert("display".into(), "flex".into());
            out.insert("flexDirection".into(), "column".into());
        }
        "wrap" | "flexWrap" => {
            match s {
                Some(s) => {
                    out.insert("flexWrap".into(), s.into());
                }
                // a bare `wrap: true` is not a value — record, don't leak a
                // bool into the StyleDesc String slot (it would fail the
                // whole desc parse)
                None => drop_key!(),
            }
        }
        "grow" | "flexGrow" => {
            out.insert(
                "flexGrow".into(),
                if v.is_number() {
                    v.clone()
                } else {
                    Value::from(1)
                },
            );
        }
        "flex1" => {
            out.insert("flexGrow".into(), 1.into());
            out.insert("flexShrink".into(), 1.into());
        }
        "shrink" | "flexShrink" => {
            out.insert(
                "flexShrink".into(),
                if v.is_number() {
                    v.clone()
                } else {
                    Value::from(1)
                },
            );
        }
        "basis" | "flexBasis" => {
            // `N/M` fractions normalize to percent strings — a raw '1/2'
            // would reach the desc unclassified (field_kind has no basis
            // lane) and fail `flex_basis: DimensionValue` wholesale.
            match basis_value(v) {
                Some(x) => {
                    out.insert("flexBasis".into(), x);
                }
                None => drop_key!(),
            }
        }
        "items" | "alignItems" => {
            if let Some(s) = s {
                out.insert("alignItems".into(), map_align(s).into());
            }
        }
        "self" | "alignSelf" => {
            if let Some(s) = s {
                out.insert("alignSelf".into(), map_align(s).into());
            }
        }
        "justify" | "justifyContent" => {
            if let Some(s) = s {
                out.insert("justifyContent".into(), map_justify(s).into());
            }
        }
        "content" | "alignContent" => {
            if let Some(s) = s {
                out.insert("alignContent".into(), map_justify(s).into());
            }
        }
        "gap" => match space_value(v) {
            Some(x) => {
                out.insert("rowGap".into(), x.clone());
                out.insert("columnGap".into(), x);
            }
            None => drop_key!(),
        },
        "rowGap" | "columnGap" => match space_value(v) {
            Some(x) => {
                out.insert(key.into(), x);
            }
            None => drop_key!(),
        },
        "gridCols" | "gridTemplateColumns" => {
            if v.is_number() {
                out.insert("gridTemplateColumns".into(), v.clone());
            } else {
                drop_key!();
            }
        }
        "gridRows" | "gridTemplateRows" => {
            if v.is_number() {
                out.insert("gridTemplateRows".into(), v.clone());
            } else {
                drop_key!();
            }
        }
        // ── spacing longhands (shorthands already expanded) ──
        "pt" | "pr" | "pb" | "pl" | "px" | "py" | "ps" | "pe" => match space_value(v) {
            Some(x) => {
                for field in pad_fields(key) {
                    out.insert((*field).into(), x.clone());
                }
            }
            None => drop_key!(),
        },
        "mt" | "mr" | "mb" | "ml" | "mx" | "my" | "ms" | "me" => match space_value(v) {
            Some(x) => {
                for field in mar_fields(key) {
                    out.insert((*field).into(), x.clone());
                }
            }
            None => drop_key!(),
        },
        // ── sizing ──
        "control" => {
            let x = if v.is_number() {
                Some(v.clone())
            } else if s.is_some_and(|n| matches!(n, "sm" | "md" | "lg")) {
                Some(Value::from(format!("control-{}", s.unwrap())))
            } else {
                None
            };
            match x {
                Some(x) => {
                    out.insert("height".into(), x);
                }
                None => drop_key!(),
            }
        }
        "icon" => {
            let x = if v.is_number() {
                Some(v.clone())
            } else if s.is_some_and(|n| GEOMETRY_SIZES.contains(&n)) {
                Some(Value::from(format!("icon-{}", s.unwrap())))
            } else {
                None
            };
            match x {
                Some(x) => {
                    out.insert("width".into(), x.clone());
                    out.insert("height".into(), x);
                }
                None => drop_key!(),
            }
        }
        "w" | "width" | "h" | "height" | "minW" | "minWidth" | "minH" | "minHeight" | "maxW"
        | "maxWidth" | "maxH" | "maxHeight" => {
            let field = match key {
                "w" => "width",
                "h" => "height",
                "minW" => "minWidth",
                "minH" => "minHeight",
                "maxW" => "maxWidth",
                "maxH" => "maxHeight",
                other => other,
            };
            match dim_value(v) {
                Some(x) => {
                    out.insert(field.into(), x);
                }
                None => drop_key!(),
            }
        }
        "aspect" | "aspectRatio" => {
            let x = if v.is_number() {
                v.as_f64()
            } else if let Some(s) = s {
                s.split_once('/').and_then(|(a, b)| {
                    let (a, b) = (a.parse::<f64>().ok()?, b.parse::<f64>().ok()?);
                    (b != 0.0).then_some(a / b)
                })
            } else {
                None
            };
            match x.filter(|n| n.is_finite() && *n > 0.0) {
                Some(n) => {
                    out.insert("aspectRatio".into(), Value::from(n));
                }
                None => drop_key!(),
            }
        }
        // ── box ──
        "bg" | "backgroundColor" => {
            if plausible_color(v) {
                out.insert("backgroundColor".into(), v.clone());
            } else {
                drop_key!();
            }
        }
        "background" => {
            out.insert("background".into(), v.clone());
        }
        "fg" | "color" => {
            if plausible_color(v) {
                out.insert("color".into(), v.clone());
            } else {
                drop_key!();
            }
        }
        "border" | "borderColor" => {
            if plausible_color(v) {
                out.insert("borderColor".into(), v.clone());
            } else {
                drop_key!();
            }
        }
        "borderT" | "borderR" | "borderB" | "borderL" => {
            let field = match key {
                "borderT" => "borderTopWidth",
                "borderR" => "borderRightWidth",
                "borderB" => "borderBottomWidth",
                _ => "borderLeftWidth",
            };
            out.insert(
                field.into(),
                if v.as_bool() == Some(true) {
                    Value::from(1)
                } else {
                    v.clone()
                },
            );
        }
        "radius" | "borderRadius" => {
            if v.is_number() || s.is_some_and(|n| RADIUS_NAMES.contains(&n)) {
                out.insert("borderRadius".into(), v.clone());
            } else {
                drop_key!();
            }
        }
        "radiusTl" | "radiusTr" | "radiusBl" | "radiusBr" | "radiusT" | "radiusB" | "radiusL"
        | "radiusR" | "borderTopLeftRadius" | "borderTopRightRadius"
        | "borderBottomLeftRadius" | "borderBottomRightRadius" => {
            if v.is_number() || s.is_some_and(|n| RADIUS_NAMES.contains(&n)) {
                for field in key_fields(key) {
                    out.insert((*field).into(), v.clone());
                }
            } else {
                drop_key!();
            }
        }
        "ring" => {
            ring.w = Some(if v.as_bool() == Some(true) {
                Value::from(1)
            } else {
                v.clone()
            });
        }
        "ringColor" => {
            if plausible_color(v) {
                ring.c = s.map(str::to_string);
            } else {
                drop_key!();
            }
        }
        "ringInset" => {
            if v.as_bool() == Some(true) {
                ring.inset = true;
            }
        }
        "shadow" | "boxShadow" => {
            let x = if v.is_object() {
                Some(v.clone())
            } else {
                s.and_then(named_shadow)
            };
            match x {
                Some(x) => {
                    out.insert("boxShadow".into(), x);
                }
                None => drop_key!(),
            }
        }
        "opacity" => {
            out.insert("opacity".into(), v.clone());
        }
        "overflowX" | "overflowY" => {
            if let Some(s) = s {
                out.insert(
                    key.into(),
                    if s == "auto" {
                        "scroll".into()
                    } else {
                        s.into()
                    },
                );
            }
        }
        "visibility" => {
            if let Some(s) = s {
                out.insert("visibility".into(), s.into());
            }
        }
        // ── text ──
        "text" | "fontSize" => {
            if v.is_number() || s.is_some_and(|n| FONT_SIZE_NAMES.contains(&n)) {
                out.insert("fontSize".into(), v.clone());
            } else {
                drop_key!();
            }
        }
        "fontW" | "fontWeight" => {
            if v.is_number() || s.is_some_and(|n| FONT_W_NAMES.contains(&n)) {
                out.insert("fontWeight".into(), v.clone());
            } else {
                drop_key!();
            }
        }
        "font" | "fontFamily" => {
            out.insert("fontFamily".into(), v.clone());
        }
        "align" | "textAlign" => {
            out.insert("textAlign".into(), v.clone());
        }
        // letter-spacing rides the gpui-fork TextStyle.letter_spacing →
        // kCTKernAttributeName lane. Numbers are px; named tracking scale
        // arrives already resolved to px by the token layer.
        "tracking" | "letterSpacing" => {
            if v.is_number() {
                out.insert("letterSpacing".into(), v.clone());
            } else {
                drop_key!();
            }
        }
        "lineHeight" => {
            out.insert("lineHeight".into(), v.clone());
        }
        "leading" | "lineHeightScale" => {
            if v.is_number() {
                out.insert("lineHeightScale".into(), v.clone());
            } else {
                drop_key!();
            }
        }
        "fontFeatures" => {
            if v.is_object() {
                out.insert("fontFeatures".into(), v.clone());
            } else {
                drop_key!();
            }
        }
        "textTransform" | "case" => {
            match s {
                Some("uppercase" | "lowercase" | "capitalize" | "none") => {
                    out.insert("textTransform".into(), s.unwrap().into());
                }
                _ => drop_key!(),
            }
        }
        "whitespace" | "whiteSpace" => {
            out.insert("whiteSpace".into(), v.clone());
        }
        "ellipsis" | "truncate" => {
            out.insert("whiteSpace".into(), "nowrap".into());
            out.insert("textOverflow".into(), "ellipsis".into());
            out.insert("overflowX".into(), "hidden".into());
        }
        "lineClamp" => {
            out.insert("lineClamp".into(), v.clone());
        }
        "underline" | "textDecoration" => {
            let d = if v.as_bool() == Some(true) {
                "underline"
            } else {
                s.unwrap_or("underline")
            };
            out.insert("textDecoration".into(), d.into());
        }
        "lineThrough" => {
            out.insert("textDecoration".into(), "line-through".into());
        }
        "decoration" | "textDecorationColor" => {
            if plausible_color(v) {
                out.insert("textDecorationColor".into(), v.clone());
            } else {
                drop_key!();
            }
        }
        "italic" | "fontStyle" => {
            let x = if v.as_bool() == Some(true) {
                "italic"
            } else if v.as_bool() == Some(false) {
                "normal"
            } else {
                s.unwrap_or("italic")
            };
            out.insert("fontStyle".into(), x.into());
        }
        // ── position ──
        "absolute" | "fixed" => {
            out.insert("position".into(), key.into());
        }
        "position" => {
            out.insert("position".into(), v.clone());
        }
        "top" | "right" | "bottom" | "left" => match inset_value(v) {
            Some(x) => {
                out.insert(key.into(), x);
            }
            None => drop_key!(),
        },
        "inset" => match inset_value(v) {
            Some(x) => {
                for field in ["top", "right", "bottom", "left"] {
                    out.insert(field.into(), x.clone());
                }
            }
            None => drop_key!(),
        },
        // ── behavior ──
        "cursor" => {
            if let Some(s) = s {
                out.insert("cursor".into(), s.into());
            }
        }
        "select" | "userSelect" => {
            let x = if v.as_bool() == Some(true) {
                "none"
            } else {
                s.unwrap_or("none")
            };
            out.insert("userSelect".into(), x.into());
        }
        "pointerEvents" => {
            out.insert("pointerEvents".into(), v.clone());
        }
        "selectionColor" => {
            out.insert("selectionColor".into(), v.clone());
        }
        // stateLayer is a flag on the wire — resolve_style hoists it and the
        // element path bakes (generics) or overlays (x-*).
        "stateLayer" => {
            if v.as_bool() == Some(true) {
                out.insert("stateLayer".into(), Value::Bool(true));
            }
        }
        "raised" | "lift" => {
            out.insert(
                key.into(),
                if v.as_bool() == Some(true) {
                    Value::from("")
                } else {
                    v.clone()
                },
            );
        }
        // ── pseudo buckets ──
        "hover" | "active" | "focus" | "focusWithin" | "focusVisible" => {
            if !v.is_object() {
                dropped.push(format!("{origin} (bucket)"));
                return;
            }
            // seed from the accumulated bucket so fragments merge key-wise
            // (`{hover:{bg}}` + `{hover:{fg}}` compose, not replace).
            let mut bucket = match out.shift_remove(key) {
                Some(Value::Object(m)) => m,
                _ => Map::new(),
            };
            let mut sub_ring = RingState::default();
            apply_style_props(v.as_object().unwrap(), &mut bucket, dropped, &mut sub_ring);
            if let Some(w) = sub_ring.w {
                let inherited = sub_ring
                    .c
                    .as_deref()
                    .or(ring.c.as_deref())
                    .or_else(|| out.get("borderColor").and_then(|c| c.as_str()))
                    .map(str::to_string);
                bucket.insert(
                    "boxShadow".into(),
                    ring_shadow(&w, inherited.as_deref(), sub_ring.inset),
                );
            }
            out.insert(key.into(), Value::Object(bucket));
        }
        // ── gdom-owned / marker keys: never reach the wire ──
        "ctxColor" => {}
        _ => dropped.push(origin.to_string()),
    }
}

/// Walk one StyleProps object: expand shorthands in authored order, then map
/// each (key, value) to fields. Later writes overwrite earlier fields — the
/// StyleX application-order rule.
fn apply_style_props(
    props: &Map<String, Value>,
    out: &mut Map<String, Value>,
    dropped: &mut Vec<String>,
    ring: &mut RingState,
) {
    for (key, v) in props {
        // A `@desc` member carries a pre-mapped field map — the class lane's
        // `resolveTokens` output joins the ordered fragment stream this way
        // so a `class` override still wins over StyleProps fragments.
        if key == "@desc" {
            if let Value::Object(map) = v {
                merge_fields(out, map.clone());
            }
            continue;
        }
        // `border` splits by value: width group vs color.
        if key == "border" && (v.as_bool() == Some(true) || v.as_f64() == Some(1.0)) {
            for sub in ["borderT", "borderR", "borderB", "borderL"] {
                apply_one(sub, &Value::from(1), key, out, dropped, ring);
            }
            continue;
        }
        match expand(key) {
            Some(longhands) => {
                for sub in longhands {
                    apply_one(sub, v, key, out, dropped, ring);
                }
            }
            None => apply_one(key, v, key, out, dropped, ring),
        }
    }
}

/// Merge one resolved-fragment map into another: scalar fields last-win,
/// pseudo buckets merge key-wise (same as `mergeStyleDesc`).
fn merge_fields(out: &mut Map<String, Value>, frag: Map<String, Value>) {
    for (k, v) in frag {
        if BUCKETS.contains(&k.as_str())
            && v.is_object()
            && out.get(&k).is_some_and(|b| b.is_object())
        {
            let slot = out.get_mut(&k).unwrap().as_object_mut().unwrap();
            for (bk, bv) in v.as_object().unwrap() {
                slot.insert(bk.clone(), bv.clone());
            }
        } else {
            out.insert(k, v);
        }
    }
}

/// StyleProps payload → (symbolic field map, dropped audit).
/// Accepts a single object or an ordered array of fragments — every fragment
/// applies into the same field map in array order, so nulls delete and
/// buckets merge across fragments. The ring accumulator spans the whole
/// stream and flushes once at the end, so `ring`/`ringColor` split across
/// ladder levels recombine exactly like the old merged-props path.
pub fn resolve_style_props(payload: &Value) -> (Map<String, Value>, Vec<String>) {
    let mut out = Map::new();
    let mut dropped = Vec::new();
    let mut ring = RingState::default();
    let fragments: Vec<&Map<String, Value>> = match payload {
        Value::Array(list) => list.iter().filter_map(|f| f.as_object()).collect(),
        Value::Object(map) => vec![map],
        _ => vec![],
    };
    for frag in fragments {
        apply_style_props(frag, &mut out, &mut dropped, &mut ring);
    }
    if let Some(w) = ring.w {
        let c = ring.c.or_else(|| {
            out.get("borderColor")
                .and_then(|c| c.as_str())
                .map(str::to_string)
        });
        out.insert(
            "boxShadow".into(),
            ring_shadow(&w, c.as_deref(), ring.inset),
        );
    }
    (out, dropped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn resolve(v: Value) -> Value {
        let (map, _) = resolve_style_props(&v);
        Value::Object(map)
    }

    #[test]
    fn shorthand_expands_to_longhands() {
        let out = resolve(json!({ "p": "lg" }));
        assert_eq!(out["paddingTop"], "lg");
        assert_eq!(out["paddingRight"], "lg");
        assert_eq!(out["paddingBottom"], "lg");
        assert_eq!(out["paddingLeft"], "lg");
        assert!(out.get("padding").is_none());
    }

    #[test]
    fn application_order_decides_shorthand_conflicts() {
        // p then px: px wins left/right.
        let out = resolve(json!({ "p": "lg", "px": "xl" }));
        assert_eq!(out["paddingTop"], "lg");
        assert_eq!(out["paddingLeft"], "xl");
        // px then p: p wins everything — the StyleX rule, not fixed order.
        let out = resolve(json!({ "px": "xl", "p": "lg" }));
        assert_eq!(out["paddingTop"], "lg");
        assert_eq!(out["paddingLeft"], "lg");
    }

    #[test]
    fn cross_fragment_order_is_array_order() {
        let out = resolve(json!([{ "px": "xl" }, { "p": "sm" }]));
        assert_eq!(out["paddingLeft"], "sm");
        let out = resolve(json!([{ "p": "sm" }, { "px": "xl" }]));
        assert_eq!(out["paddingLeft"], "xl");
        assert_eq!(out["paddingTop"], "sm");
    }

    #[test]
    fn margin_and_overflow_and_border_expand() {
        let out = resolve(json!({ "m": "sm", "overflow": "auto", "border": true }));
        assert_eq!(out["marginTop"], "sm");
        assert_eq!(out["overflowX"], "scroll"); // auto → scroll
        assert_eq!(out["borderTopWidth"], 1);
        assert_eq!(out["borderLeftWidth"], 1);
    }

    #[test]
    fn vocab_maps_to_fields() {
        let out = resolve(json!({
            "bg": "primary", "fg": "color-readable", "col": true,
            "items": "center", "control": "md", "radius": "lg",
        }));
        assert_eq!(out["backgroundColor"], "primary");
        assert_eq!(out["color"], "color-readable");
        assert_eq!(out["display"], "flex");
        assert_eq!(out["flexDirection"], "column");
        assert_eq!(out["alignItems"], "center");
        assert_eq!(out["height"], "control-md");
        assert_eq!(out["borderRadius"], "lg");
    }

    #[test]
    fn buckets_recurse_with_own_ring_state() {
        let out = resolve(json!({
            "ring": 2, "ringColor": "color/50",
            "hover": { "bg": "danger", "ring": 1 },
        }));
        assert_eq!(out["boxShadow"]["spreadRadius"], 2);
        assert_eq!(out["boxShadow"]["color"], "color/50");
        assert_eq!(out["hover"]["backgroundColor"], "danger");
        assert_eq!(out["hover"]["boxShadow"]["spreadRadius"], 1);
        // bucket ring color inherits the outer ringColor, then borderColor.
        assert_eq!(out["hover"]["boxShadow"]["color"], "color/50");
    }

    #[test]
    fn drops_report_authored_key() {
        let (_, dropped) = resolve_style_props(&json!({ "p": "bogus", "raduis": 2, "hover": 5 }));
        assert!(dropped.contains(&"p:bogus".to_string()));
        assert!(dropped.contains(&"raduis".to_string()));
        assert!(dropped.iter().any(|d| d.contains("bucket")));
    }

    #[test]
    fn state_layer_and_raised_pass_as_fields() {
        let out = resolve(json!({ "stateLayer": true, "raised": "2", "lift": true }));
        assert_eq!(out["stateLayer"], true);
        assert_eq!(out["raised"], "2");
        assert_eq!(out["lift"], "");
    }

    #[test]
    fn literal_colors_pass() {
        let out = resolve(json!({ "bg": "#ffffff" }));
        assert_eq!(out["backgroundColor"], "#ffffff");
    }

    #[test]
    fn null_deletes_the_keys_fields() {
        // null is the wire-level unset: theme-ladder levels ship unmerged so
        // a later level removes what an earlier one wrote. Field-level, not
        // vocab-level — `p:null` clears all four paddings whoever set them.
        let out = resolve(json!([{ "p": "md" }, { "p": null }]));
        assert!(out.get("paddingTop").is_none());
        assert!(out.get("paddingLeft").is_none());
        // …including a longhand set through a different vocab key.
        let out = resolve(json!([{ "px": "sm" }, { "p": null }]));
        assert!(out.get("paddingLeft").is_none());
        // …but a field the key doesn't own survives.
        let out = resolve(json!([{ "p": "md", "bg": "danger" }, { "p": null }]));
        assert!(out.get("paddingTop").is_none());
        assert_eq!(out["backgroundColor"], "danger");
        // inside a bucket, null removes the field and keeps the rest.
        let out = resolve(json!({ "hover": { "bg": "danger", "fg": "primary" } }));
        assert_eq!(out["hover"]["color"], "primary");
        let out = resolve(
            json!([{ "hover": { "bg": "danger", "fg": "primary" } }, { "hover": { "fg": null } }]),
        );
        assert_eq!(out["hover"]["backgroundColor"], "danger");
        assert!(out["hover"].get("color").is_none());
        // null on a bucket key drops the whole accumulated bucket.
        let out = resolve(json!([{ "hover": { "bg": "danger" } }, { "hover": null }]));
        assert!(out.get("hover").is_none());
        // false stays a skip — the conditional-prop idiom.
        let out = resolve(json!([{ "p": "md" }, { "p": false }]));
        assert_eq!(out["paddingTop"], "md");
    }

    #[test]
    fn ring_spans_the_fragment_stream() {
        // ring state accumulates across fragments and flushes once — a
        // theme level can set `ring` and an instance level `ringColor`,
        // recombining exactly like the old merged-props path.
        let out = resolve(json!([{ "ring": 2 }, { "ringColor": "danger" }]));
        assert_eq!(out["boxShadow"]["spreadRadius"], 2);
        assert_eq!(out["boxShadow"]["color"], "danger");
        // an explicit shadow later in the stream loses to the pending ring
        // flush — same as a merged object where ring closed last.
        let out = resolve(json!([{ "shadow": "lg" }, { "ring": 2 }]));
        assert_eq!(out["boxShadow"]["spreadRadius"], 2);
        // ring:null cancels the pending accumulator but spares an explicit
        // shadow an earlier fragment wrote.
        let out = resolve(json!([{ "shadow": "lg" }, { "ring": 2 }, { "ring": null }]));
        assert_eq!(out["boxShadow"]["blurRadius"].as_f64(), Some(16.0));
        let out = resolve(json!([{ "ring": 2 }, { "ring": null }]));
        assert!(out.get("boxShadow").is_none());
    }

    #[test]
    fn basis_fractions_normalize_to_percent() {
        let out = resolve(json!({ "basis": "1/2" }));
        assert_eq!(out["flexBasis"], "50%");
        let out = resolve(json!({ "basis": 24 }));
        assert_eq!(out["flexBasis"], 24);
        let (_, dropped) = resolve_style_props(&json!({ "basis": "1/0" }));
        assert!(dropped.iter().any(|d| d.starts_with("basis")));
    }

    #[test]
    fn wrap_and_tracking_drops_are_recorded() {
        let (_, dropped) = resolve_style_props(&json!({ "wrap": true, "tracking": "wide" }));
        assert!(dropped.iter().any(|d| d.starts_with("wrap")));
        assert!(dropped.iter().any(|d| d.starts_with("tracking")));
        // a real value still maps
        let out = resolve(json!({ "wrap": "wrap" }));
        assert_eq!(out["flexWrap"], "wrap");
    }
}
