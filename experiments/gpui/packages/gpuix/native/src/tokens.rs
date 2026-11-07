/// `TokenTheme` — the design-token language for native elements, a 1/1 port
/// of svelai's token system (`ai2/src/lib/tailwind/{colors,scales,geometry}.ts`
/// + `utils/cva`). The palette is not a hex snapshot: this file ports
/// `generateColorPalette` itself (colorizr math included), so `colors:` theme
/// overrides derive missing roles exactly the way svelai does — the default
/// dark/light tables are *generated*, with the generated hex pinned in tests.
///
/// Colors: `transparent | current | <name>[-<role>][/<alpha>]`
///   - `<name>` is a palette entry (`primary secondary danger success warning
///     info neutral`), `surface`, `elevation-tint-N`, or the `color` ctx
///     placeholder (element `color` prop → inherited ctx → `defaultColor`).
///   - `<role>` is everything after the first dash: `base dark light lighter
///     muted contrast readable muted-readable`; surface roles are
///     `base recessed canvas raised floating`.
///   - `/<alpha>` accepts 0–1 or 0–100; `0` resolves to `transparent`; a
///     non-numeric alpha leaves the whole ref unresolved (matches JS).
///
/// Sizes, resolved per field kind — all spacing-derived scales are multiples
/// of `--spacing` (4px × spacing factor), like svelai:
///   - spacing fields (padding/margin/gap/offsets): `0 micro xs sm md lg xl
///     layout-sm layout-md layout-lg layout-xl`; bare numbers mean ×`--spacing`
///     (svelai/tailwind semantics — `8` = 32px at factor 1, `"8px"` is the
///     literal-pixel escape).
///   - dimensions (width/height/min*/max*): `full fit auto control-* row-*
///     icon-* hit-* indent-*`, spacing names, same numeric rule.
///   - `fontSize`: `xs sm base lg xl 2xl 3xl 4xl 5xl 6xl 7xl 8xl 9xl` — the
///     fluid ramp (base resolved against `viewport`, ratio from `typeScale`).
///   - `borderRadius*`: `none xs sm md lg xl 2xl 3xl 4xl full` (radius factor).
///   - `fontWeight`: `normal medium semibold bold`.
///   - `boxShadow` string: `elevation-0..5`, `raised-xs..2xl`, `lift-*`.
///   - `stateLayer: true` (recipe key): the element paints a `currentColor`
///     overlay at `state-hover-opacity`/`state-pressed-opacity`.
///
/// Themes inherit through `Inherited::tokens`: any element may carry a
/// `theme` custom prop using svelai's `designTokens` vocabulary (`mode,
/// palette, colors, surface, defaultColor, spacing, spacingScale, radius,
/// typeScale, elevation, raisedWithBorder, motion, stateHoverOpacity,
/// statePressedOpacity, luminance, saturation, viewport`) which overrides
/// for itself and its subtree.
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn fresh_id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

// ──────────────────────────── color math (colorizr port) ──────────────────
// darken/lighten/saturate adjust HSL components; muted/readable/surface work
// in OKLCH with binary-search gamut mapping; contrast is WCAG luminance.

#[derive(Clone, Copy, Debug)]
struct Oklch {
    l: f64,
    c: f64,
    h: f64,
}

/// Any color svelai's colorizr accepts — `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa`,
/// `rgb()`/`hsl()`/`hwb()`/`lab()`/`lch()`/`oklab()`/`oklch()` functions, named
/// colors — parsed by csscolorparser. Returns 0–255 channels + alpha 0–1.
fn css_rgba(color: &str) -> Option<(f64, f64, f64, f64)> {
    let c = crate::color::parse_color_rgba(color)?;
    Some((
        c.r as f64 * 255.0,
        c.g as f64 * 255.0,
        c.b as f64 * 255.0,
        c.a as f64,
    ))
}

fn hex_to_rgb(hex: &str) -> Option<(f64, f64, f64)> {
    css_rgba(hex).map(|(r, g, b, _)| (r, g, b))
}

fn rgb_to_hex(r: f64, g: f64, b: f64) -> String {
    let c = |v: f64| (v.clamp(0.0, 255.0).round() as u32).min(255);
    format!("#{:02x}{:02x}{:02x}", c(r), c(g), c(b))
}

/// colorizr `hsl2hex`: appends the alpha byte when the source was translucent.
fn rgba_to_hex(r: f64, g: f64, b: f64, a: f64) -> String {
    let hex = rgb_to_hex(r, g, b);
    if a >= 1.0 {
        return hex;
    }
    let a = (a.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("{hex}{a:02x}")
}

/// colorizr `rgb2hsl` — h/s/l are 2-decimal-rounded, which matters: the
/// lighten/darken shifts run on the *rounded* values.
fn rgb_to_hsl(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let (r, g, b) = (r / 255.0, g / 255.0, b / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let d = max - min;
    let h = if d == 0.0 {
        0.0
    } else {
        let rate = if max == r {
            (g - b) / d
        } else if max == g {
            (b - r) / d + 2.0
        } else {
            (r - g) / d + 4.0
        };
        (60.0 * rate).rem_euclid(360.0)
    };
    let s = if min == max {
        0.0
    } else if l < 0.5 {
        d / (2.0 * l)
    } else {
        d / (2.0 - 2.0 * l)
    };
    let r2 = |v: f64| (v * 100.0).round() / 100.0;
    (r2(h.abs()), r2(s * 100.0), r2(l * 100.0))
}

fn hue2rgb(point: f64, chroma: f64, h: f64) -> f64 {
    let mut hue = h;
    if hue < 0.0 {
        hue += 1.0;
    }
    if hue > 1.0 {
        hue -= 1.0;
    }
    if hue < 1.0 / 6.0 {
        return point + (chroma - point) * 6.0 * hue;
    }
    if hue < 0.5 {
        return chroma;
    }
    if hue < 2.0 / 3.0 {
        return point + (chroma - point) * (2.0 / 3.0 - hue) * 6.0;
    }
    point
}

/// colorizr `hsl2rgb` — chroma/point form, channels rounded to integers.
fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (f64, f64, f64) {
    let h = h / 360.0;
    let s = s / 100.0;
    let l = l / 100.0;
    if s < 0.0001 {
        return (l * 255.0, l * 255.0, l * 255.0);
    }
    let chroma = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let point = 2.0 * l - chroma;
    (
        hue2rgb(point, chroma, h + 1.0 / 3.0) * 255.0,
        hue2rgb(point, chroma, h) * 255.0,
        hue2rgb(point, chroma, h - 1.0 / 3.0) * 255.0,
    )
}

/// colorizr `darken`/`lighten`/`saturate`: HSL component shift, clamp 0–100.
/// Alpha survives the shift (colorizr `hsl2hex` re-appends it); unparseable
/// input passes through like colorizr's own passthrough.
fn hsl_shift(hex: &str, key: char, delta: f64) -> String {
    let Some((r, g, b, a)) = css_rgba(hex) else {
        return hex.to_string();
    };
    let (h, s, l) = rgb_to_hsl(r, g, b);
    let (h, s, l) = match key {
        'l' => (h, s, (l + delta).clamp(0.0, 100.0)),
        's' => (h, (s + delta).clamp(0.0, 100.0), l),
        _ => (h, s, l),
    };
    let (r, g, b) = hsl_to_rgb(h, s, l);
    rgba_to_hex(r, g, b, a)
}

fn srgb_decode(v: f64) -> f64 {
    if v.abs() < 0.04045 {
        v / 12.92
    } else {
        ((v.abs() + 0.055) / 1.055).powf(2.4) * v.signum()
    }
}

fn srgb_encode(v: f64) -> f64 {
    if v.abs() > 0.0031308 {
        v.signum() * (v.abs().powf(1.0 / 2.4) * 1.055 - 0.055)
    } else {
        v * 12.92
    }
}

const LRGB_TO_LMS: [[f64; 3]; 3] = [
    [0.4122214708, 0.5363325363, 0.0514459929],
    [0.2119034982, 0.6806995451, 0.1073969566],
    [0.0883024619, 0.2817188376, 0.6299787005],
];
const CLMS_TO_OKLAB: [[f64; 3]; 3] = [
    [0.210454268309314, 0.7936177747023054, -0.0040720430116193],
    [1.9779985324311684, -2.4285922420485799, 0.450593709617411],
    [0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
];
const OKLAB_TO_CLMS: [[f64; 3]; 3] = [
    [1.0, 0.3963377773761749, 0.2158037573099136],
    [1.0, -0.1055613458156586, -0.0638541728258133],
    [1.0, -0.0894841775298119, -1.2914855480194092],
];
const LMS_TO_LRGB: [[f64; 3]; 3] = [
    [4.0767416621, -3.3077115913, 0.2309699292],
    [-1.2684380046, 2.6097574011, -0.3413193965],
    [-0.0041960863, -0.7034186147, 1.707614701],
];
const GAMUT_EPSILON: f64 = 0.000001;

fn mat3(m: &[[f64; 3]; 3], v: (f64, f64, f64)) -> (f64, f64, f64) {
    (
        m[0][0] * v.0 + m[0][1] * v.1 + m[0][2] * v.2,
        m[1][0] * v.0 + m[1][1] * v.1 + m[1][2] * v.2,
        m[2][0] * v.0 + m[2][1] * v.1 + m[2][2] * v.2,
    )
}

fn rgb_to_oklch(r: f64, g: f64, b: f64) -> Oklch {
    let lin = (
        srgb_decode(r / 255.0),
        srgb_decode(g / 255.0),
        srgb_decode(b / 255.0),
    );
    let lms = mat3(&LRGB_TO_LMS, lin);
    let clms = (lms.0.cbrt(), lms.1.cbrt(), lms.2.cbrt());
    let lab = mat3(&CLMS_TO_OKLAB, clms);
    let c = (lab.1 * lab.1 + lab.2 * lab.2).sqrt();
    let h = if c < 1e-6 {
        0.0
    } else {
        (lab.2.atan2(lab.1).to_degrees() + 360.0) % 360.0
    };
    Oklch { l: lab.0, c, h }
}

fn hex_to_oklch(hex: &str) -> Oklch {
    hex_to_rgb(hex)
        .map(|(r, g, b)| rgb_to_oklch(r, g, b))
        .unwrap_or(Oklch {
            l: 0.0,
            c: 0.0,
            h: 0.0,
        })
}

/// svelai `generateBaseColors`: a configured base passes through when it is a
/// hex literal, a Tailwind name resolves to its `500` step, anything else
/// stays verbatim (colorizr parses it at derivation time). Empty means unset.
fn normalize_color_input(value: &str) -> &str {
    if value.starts_with('#') {
        return value;
    }
    tailwind_500(value).unwrap_or(value)
}

/// svelai's `tailwindColors[name]['500']` — its table pins a custom indigo
/// (`#5f62ef`, the brand) and a bespoke `black` ramp.
fn tailwind_500(name: &str) -> Option<&'static str> {
    Some(match name {
        "slate" => "#64748b",
        "gray" => "#6b7280",
        "zinc" => "#71717a",
        "neutral" => "#737373",
        "stone" => "#78716c",
        "red" => "#ef4444",
        "orange" => "#f97316",
        "amber" => "#f59e0b",
        "yellow" => "#eab308",
        "lime" => "#84cc16",
        "green" => "#22c55e",
        "emerald" => "#10b981",
        "teal" => "#14b8a6",
        "cyan" => "#06b6d4",
        "sky" => "#0ea5e9",
        "blue" => "#3b82f6",
        "indigo" => "#5f62ef",
        "violet" => "#8b5cf6",
        "purple" => "#a855f7",
        "fuchsia" => "#d946ef",
        "pink" => "#ec4899",
        "rose" => "#f43f5e",
        "black" => "#555555",
        _ => return None,
    })
}

fn oklch_to_linear_rgb(l: f64, c: f64, h: f64) -> (f64, f64, f64) {
    let h = if h.is_nan() || h < 0.0 { 0.0 } else { h };
    let (a, b) = (c * h.to_radians().cos(), c * h.to_radians().sin());
    let clms = mat3(&OKLAB_TO_CLMS, (l, a, b));
    let lms = (
        clms.0 * clms.0 * clms.0,
        clms.1 * clms.1 * clms.1,
        clms.2 * clms.2 * clms.2,
    );
    mat3(&LMS_TO_LRGB, lms)
}

fn oklch_to_hex(l: f64, c: f64, h: f64) -> String {
    let (lr, lg, lb) = oklch_to_linear_rgb(l, c, h);
    rgb_to_hex(
        255.0 * srgb_encode(lr),
        255.0 * srgb_encode(lg),
        255.0 * srgb_encode(lb),
    )
}

fn in_gamut(lin: (f64, f64, f64)) -> bool {
    [lin.0, lin.1, lin.2]
        .iter()
        .all(|c| *c >= -GAMUT_EPSILON && *c <= 1.0 + GAMUT_EPSILON)
}

/// `formatCSS(..., 'oklch')` quantizes to 5 significant digits, and svelai
/// round-trips its derived colors through that string before `toGamut` —
/// the quantization is part of the result.
fn round_sig(x: f64, precision: i32) -> f64 {
    if x == 0.0 {
        return 0.0;
    }
    let integer = x.trunc();
    let digits = if integer != 0.0 {
        integer.abs().log10().floor() as i32 + 1
    } else {
        0
    };
    let factor = 10f64.powi(precision - digits);
    (x * factor + 0.5).floor() / factor
}

fn quantize_oklch(l: f64, c: f64, h: f64) -> (f64, f64, f64) {
    // l serializes as a percentage, c/h as plain numbers — all at precision 5.
    let l = round_sig(l * 100.0, 5) / 100.0;
    let c = round_sig(c, 5);
    // `c === 0` serializes h as `none` → parses back to 0.
    let h = if c == 0.0 { 0.0 } else { round_sig(h, 5) };
    (l, c, h)
}

/// colorizr `toGamut`: reduce OKLCH chroma by binary search until in sRGB.
fn to_gamut(l: f64, c: f64, h: f64) -> String {
    if l <= 0.0 {
        return "#000000".to_string();
    }
    if l >= 1.0 {
        return "#ffffff".to_string();
    }
    if in_gamut(oklch_to_linear_rgb(l, c, h)) {
        return oklch_to_hex(l, c, h);
    }
    let (mut low, mut high) = (0.0, c);
    while high - low > GAMUT_EPSILON {
        let mid = (low + high) / 2.0;
        if in_gamut(oklch_to_linear_rgb(l, mid, h)) {
            low = mid;
        } else {
            high = mid;
        }
    }
    oklch_to_hex(l, low, h)
}

/// colorizr `luminance`: WCAG relative luminance (rounded to 4 decimals).
fn luminance(hex: &str) -> f64 {
    let Some((r, g, b)) = hex_to_rgb(hex) else {
        return 0.0;
    };
    let v = 0.2126 * srgb_decode(r / 255.0)
        + 0.7152 * srgb_decode(g / 255.0)
        + 0.0722 * srgb_decode(b / 255.0);
    (v * 10000.0).round() / 10000.0
}

/// colorizr `contrast`: ratio rounded to 2 decimals.
fn contrast_ratio(a: &str, b: &str) -> f64 {
    let (la, lb) = (luminance(a), luminance(b));
    let ratio = if la >= lb {
        (la + 0.05) / (lb + 0.05)
    } else {
        (lb + 0.05) / (la + 0.05)
    };
    (ratio * 100.0).round() / 100.0
}

fn has_bad_contrast(foreground: &str, background: &str, threshold: f64) -> bool {
    contrast_ratio(foreground, background) < threshold
}

// ───────────────────── palette generation (generateColorPalette port) ─────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Dark,
    Light,
}

/// One palette color's authored input: base hex + explicit role overrides.
/// Mirrors svelai's flat `primary`, `primary-muted`, … theme keys.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ColorSpec {
    pub base: Option<String>,
    pub roles: HashMap<String, String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PaletteSpec {
    pub mode: Mode,
    pub surface: String,
    /// Explicit `surface-recessed/canvas/raised/floating` overrides.
    pub surface_roles: HashMap<String, String>,
    /// `primary` … `neutral` + any custom names.
    pub colors: BTreeMap<String, ColorSpec>,
    pub luminance: Option<f64>,
    pub saturation: Option<f64>,
    pub state_hover: Option<f64>,
    pub state_pressed: Option<f64>,
}

const SEMANTIC: [&str; 7] = [
    "primary",
    "secondary",
    "danger",
    "success",
    "warning",
    "info",
    "neutral",
];

impl PaletteSpec {
    /// svelai's canonical defaults (app.css blocks verbatim).
    pub fn dark() -> Self {
        Self {
            mode: Mode::Dark,
            surface: "#09090b".to_string(),
            surface_roles: HashMap::from([("floating".to_string(), "#27272a".to_string())]),
            colors: BTreeMap::from([
                (
                    "primary".to_string(),
                    ColorSpec {
                        base: Some("#5f62ef".into()),
                        ..Default::default()
                    },
                ),
                (
                    "secondary".to_string(),
                    ColorSpec {
                        base: Some("#27272a".into()),
                        ..Default::default()
                    },
                ),
                (
                    "danger".to_string(),
                    ColorSpec {
                        base: Some("#dc2626".into()),
                        ..Default::default()
                    },
                ),
                (
                    "success".to_string(),
                    ColorSpec {
                        base: Some("#15803d".into()),
                        ..Default::default()
                    },
                ),
                (
                    "warning".to_string(),
                    ColorSpec {
                        base: Some("#f59e0b".into()),
                        ..Default::default()
                    },
                ),
                (
                    "info".to_string(),
                    ColorSpec {
                        base: Some("#2563eb".into()),
                        ..Default::default()
                    },
                ),
                (
                    "neutral".to_string(),
                    ColorSpec {
                        base: Some("#fafafa".into()),
                        ..Default::default()
                    },
                ),
            ]),
            luminance: None,
            saturation: None,
            state_hover: None,
            state_pressed: None,
        }
    }

    pub fn light() -> Self {
        Self {
            mode: Mode::Light,
            surface: "#fafafa".to_string(),
            surface_roles: HashMap::new(),
            colors: BTreeMap::from([
                (
                    "primary".to_string(),
                    ColorSpec {
                        base: Some("#5f62ef".into()),
                        ..Default::default()
                    },
                ),
                (
                    "secondary".to_string(),
                    ColorSpec {
                        base: Some("#e4e4e7".into()),
                        ..Default::default()
                    },
                ),
                (
                    "danger".to_string(),
                    ColorSpec {
                        base: Some("#dc2626".into()),
                        ..Default::default()
                    },
                ),
                (
                    "success".to_string(),
                    ColorSpec {
                        base: Some("#15803d".into()),
                        ..Default::default()
                    },
                ),
                (
                    "warning".to_string(),
                    ColorSpec {
                        base: Some("#f59e0b".into()),
                        ..Default::default()
                    },
                ),
                (
                    "info".to_string(),
                    ColorSpec {
                        base: Some("#2563eb".into()),
                        ..Default::default()
                    },
                ),
                (
                    "neutral".to_string(),
                    ColorSpec {
                        base: Some("#18181b".into()),
                        ..Default::default()
                    },
                ),
            ]),
            luminance: None,
            saturation: None,
            state_hover: None,
            state_pressed: None,
        }
    }
}

/// `generateColorPalette` verbatim. Returns name → role → hex, including the
/// `surface` entry, plus the state-layer opacities.
fn generate_palette(spec: &PaletteSpec) -> (HashMap<String, HashMap<String, String>>, f64, f64) {
    let is_dark = spec.mode == Mode::Dark;
    let adjust = |color: &str| {
        let mut c = color.to_string();
        if let Some(l) = spec.luminance {
            c = hsl_shift(&c, 'l', l);
        }
        if let Some(s) = spec.saturation {
            c = hsl_shift(&c, 's', s);
        }
        c
    };
    let readable_on = |accent: &str, surface: &str| {
        let Oklch { c, h, .. } = hex_to_oklch(accent);
        let mut l = if is_dark {
            0.78
        } else if c < 0.03 {
            0.4
        } else {
            0.55
        };
        let mut text = oklch_to_hex(l, c, h);
        while has_bad_contrast(surface, &text, 4.75) && l > 0.15 && l < 0.95 {
            l += if is_dark { 0.02 } else { -0.02 };
            text = oklch_to_hex(l, c, h);
        }
        text
    };
    let surface_l = if is_dark {
        [0.18, 0.14, 0.16, 0.2, 0.24]
    } else {
        [0.985, 0.966, 0.976, 0.993, 1.0]
    };
    let set_l = |color: &str, l: f64| {
        let Oklch { c, h, .. } = hex_to_oklch(color);
        let (l, c, h) = quantize_oklch(l, c, h);
        to_gamut(l, c, h)
    };
    let surface_base = set_l(&spec.surface, surface_l[0]);
    let surface_roles = ["recessed", "canvas", "raised", "floating"];
    let mut surface_map = HashMap::from([("base".to_string(), surface_base.clone())]);
    for (i, name) in surface_roles.iter().enumerate() {
        let hex = spec
            .surface_roles
            .get(*name)
            .cloned()
            .unwrap_or_else(|| set_l(&spec.surface, surface_l[i + 1]));
        surface_map.insert(name.to_string(), hex);
    }

    let muted_on = |accent: &str, surface: &str| {
        let Oklch { l: sl, .. } = hex_to_oklch(surface);
        let Oklch { c, h, .. } = hex_to_oklch(accent);
        let l = if is_dark { sl + 0.06 } else { sl - 0.045 };
        let c = (c * 0.3).min(if is_dark { 0.06 } else { 0.045 });
        let (l, c, h) = quantize_oklch(l, c, h);
        to_gamut(l, c, h)
    };
    let contrast = |base: &str| {
        if has_bad_contrast("#ffffff", base, 4.5) {
            "#000000"
        } else {
            "#ffffff"
        }
    };
    let semantic = |input: &ColorSpec, default_base: &str, surface: &str| {
        let base = input
            .base
            .clone()
            .unwrap_or_else(|| default_base.to_string());
        let adjusted = adjust(&base);
        let get = |r: &str| input.roles.get(r).cloned();
        let muted = get("muted").unwrap_or_else(|| muted_on(&adjusted, surface));
        let mut roles = HashMap::from([
            ("base".to_string(), base.clone()),
            (
                "dark".to_string(),
                get("dark").unwrap_or_else(|| hsl_shift(&adjusted, 'l', -15.0)),
            ),
            (
                "light".to_string(),
                get("light").unwrap_or_else(|| hsl_shift(&adjusted, 'l', 15.0)),
            ),
            (
                "lighter".to_string(),
                get("lighter").unwrap_or_else(|| hsl_shift(&adjusted, 'l', 25.0)),
            ),
            ("muted".to_string(), muted.clone()),
            (
                "contrast".to_string(),
                get("contrast").unwrap_or_else(|| contrast(&adjusted).to_string()),
            ),
            // svelai's `variants` list ends at `contrast` — `readable` and
            // `muted-readable` are always derived from the *raw* base and the
            // surface they sit on; configured values for them are ignored.
            ("readable".to_string(), readable_on(&base, &surface_base)),
            ("muted-readable".to_string(), readable_on(&base, &muted)),
        ]);
        roles.shrink_to_fit();
        roles
    };
    let neutral = |input: &ColorSpec| {
        // Neutral derives from the surface unless explicitly configured, and
        // its DEFAULT emits the *adjusted/derived* value — not the authored
        // string like the semantic entries do.
        let base_color = if input.base.is_some() {
            adjust(input.base.as_ref().unwrap())
        } else {
            set_l(&spec.surface, if is_dark { 0.96 } else { 0.22 })
        };
        let get = |r: &str| input.roles.get(r).cloned();
        let muted = get("muted").unwrap_or_else(|| muted_on(&base_color, &surface_base));
        HashMap::from([
            ("base".to_string(), base_color.clone()),
            (
                "dark".to_string(),
                get("dark").unwrap_or_else(|| hsl_shift(&base_color, 'l', -2.0)),
            ),
            (
                "light".to_string(),
                get("light").unwrap_or_else(|| hsl_shift(&base_color, 'l', 5.0)),
            ),
            (
                "lighter".to_string(),
                get("lighter").unwrap_or_else(|| hsl_shift(&base_color, 'l', 15.0)),
            ),
            ("muted".to_string(), muted.clone()),
            (
                "contrast".to_string(),
                get("contrast").unwrap_or_else(|| contrast(&base_color).to_string()),
            ),
            (
                "readable".to_string(),
                readable_on(&base_color, &surface_base),
            ),
            (
                "muted-readable".to_string(),
                readable_on(&base_color, &muted),
            ),
        ])
    };

    let default_bases: HashMap<&str, &str> = if is_dark {
        HashMap::from([
            ("primary", "#5f62ef"),
            ("secondary", "#27272a"),
            ("danger", "#dc2626"),
            ("success", "#15803d"),
            ("warning", "#f59e0b"),
            ("info", "#2563eb"),
            ("neutral", "#fafafa"),
        ])
    } else {
        HashMap::from([
            ("primary", "#5f62ef"),
            ("secondary", "#e4e4e7"),
            ("danger", "#dc2626"),
            ("success", "#15803d"),
            ("warning", "#f59e0b"),
            ("info", "#2563eb"),
            ("neutral", "#18181b"),
        ])
    };

    let mut palette = HashMap::new();
    for name in SEMANTIC {
        let input = spec.colors.get(name).cloned().unwrap_or_default();
        palette.insert(
            name.to_string(),
            if name == "neutral" {
                neutral(&input)
            } else {
                semantic(&input, default_bases[name], &surface_base)
            },
        );
    }
    for (name, input) in &spec.colors {
        if SEMANTIC.contains(&name.as_str()) {
            continue;
        }
        palette.insert(name.clone(), semantic(input, "#18181b", &surface_base));
    }
    palette.insert("surface".to_string(), surface_map);

    let hover = spec
        .state_hover
        .unwrap_or(if is_dark { 0.16 } else { 0.05 });
    let pressed = spec
        .state_pressed
        .unwrap_or(if is_dark { 0.32 } else { 0.1 });
    (palette, hover, pressed)
}

// ───────────────────────────── scales ─────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub struct TypeOptions {
    pub base_min_px: f64,
    pub base_max_px: f64,
    pub min_viewport: f64,
    pub max_viewport: f64,
    pub ratio: f64,
    /// `remValueInPx` — the px unit behind svelai's rem-clamp terms.
    pub rem_value_in_px: f64,
}

impl TypeOptions {
    fn preset(name: &str) -> Option<Self> {
        let (min, max, ratio) = match name {
            "compact" => (14.0, 16.0, 1.2),
            "default" => (16.0, 18.0, 1.25),
            "comfortable" => (16.0, 20.0, 1.25),
            "large" => (18.0, 22.0, 1.32),
            _ => return None,
        };
        Some(Self {
            base_min_px: min,
            base_max_px: max,
            ratio,
            ..Default::default()
        })
    }
}

impl Default for TypeOptions {
    fn default() -> Self {
        Self {
            base_min_px: 16.0,
            base_max_px: 18.0,
            min_viewport: 375.0,
            max_viewport: 1440.0,
            ratio: 1.25,
            rem_value_in_px: 16.0,
        }
    }
}

const TYPE_STEPS: [&str; 13] = [
    "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl",
];
const TYPE_RATIOS: [(&str, f64); 8] = [
    ("minorSecond", 1.067),
    ("majorSecond", 1.125),
    ("minorThird", 1.2),
    ("majorThird", 1.25),
    ("perfectFourth", 1.32),
    ("augmentedFourth", 1.414),
    ("perfectFifth", 1.5),
    ("goldenRatio", 1.618),
];
const SPACING_FACTORS: [(&str, f64); 3] = [("small", 0.8), ("normal", 1.0), ("large", 1.2)];
const RADIUS_FACTORS: [(&str, f64); 6] = [
    ("none", 0.0),
    ("subtile", 0.5),
    ("small", 0.75),
    ("normal", 1.0),
    ("large", 1.5),
    ("round", 2.5),
];
const RADIUS_STEPS: [(&str, f64); 8] = [
    ("xs", 0.125),
    ("sm", 0.25),
    ("md", 0.5),
    ("lg", 0.75),
    ("xl", 1.0),
    ("2xl", 1.25),
    ("3xl", 1.5),
    ("4xl", 2.0),
];

/// The derivation configuration carried by a theme — svelai's designTokens.
#[derive(Clone, Debug, PartialEq)]
pub struct ThemeSpec {
    pub palette: PaletteSpec,
    /// `--spacing` factor (svelai `spacing`): 0.8/1/1.2 or arbitrary.
    pub spacing_factor: f64,
    /// `spacingScale`: xs..xl multipliers of `--spacing`.
    pub spacing_scale: [f64; 5],
    /// `radius` factor preset/number.
    pub radius_factor: f64,
    pub type_options: TypeOptions,
    /// Viewport width the fluid type ramp resolves against.
    pub viewport: f64,
    /// `elevation`: flat/normal/high → (alpha, blur) multipliers.
    pub elevation: (f64, f64),
    pub raised_with_border: bool,
    pub motion_duration: HashMap<String, f64>,
    pub motion_easing: HashMap<String, String>,
    pub default_color: String,
    /// nkit `tables:` extension — resolved-px overrides applied over the
    /// derived maps. This is how JS `applyTokenOverrides` writes cross.
    pub table_overrides: HashMap<String, HashMap<String, f64>>,
}

impl ThemeSpec {
    fn for_mode(mode: Mode) -> Self {
        Self {
            palette: match mode {
                Mode::Dark => PaletteSpec::dark(),
                Mode::Light => PaletteSpec::light(),
            },
            spacing_factor: 1.0,
            spacing_scale: [1.0, 1.5, 2.0, 3.0, 4.0],
            radius_factor: 1.0,
            type_options: TypeOptions::default(),
            viewport: 1440.0,
            elevation: (1.0, 1.0),
            raised_with_border: true,
            motion_duration: HashMap::from([
                ("instant".to_string(), 0.0),
                ("fast".to_string(), 100.0),
                ("normal".to_string(), 200.0),
                ("slow".to_string(), 300.0),
                ("slower".to_string(), 500.0),
            ]),
            motion_easing: HashMap::from([
                ("standard".to_string(), "cubicInOut".to_string()),
                ("enter".to_string(), "cubicOut".to_string()),
                ("exit".to_string(), "cubicIn".to_string()),
                ("emphasized".to_string(), "backOut".to_string()),
            ]),
            default_color: "neutral".to_string(),
            table_overrides: HashMap::new(),
        }
    }
}

/// Keys that mark a `theme` custom-prop object as a designTokens declaration.
/// Anything else (`{caret: …}`, `{background: …}` on `x-input`/`x-code`) is
/// the elements' own legacy vocabulary and does not cascade.
const THEME_DECLARATION_KEYS: [&str; 20] = [
    "mode",
    "palette",
    "colors",
    "surface",
    "defaultColor",
    "spacing",
    "spacingScale",
    "radius",
    "typeScale",
    "elevation",
    "raisedWithBorder",
    "motion",
    "stateHoverOpacity",
    "statePressedOpacity",
    "state-hover-opacity",
    "state-pressed-opacity",
    "luminance",
    "saturation",
    "viewport",
    "tables",
];

/// A theme-input color must parse — svelai feeds it to colorizr, which throws
/// on garbage. Called for every authored string before generation starts.
fn validate_color(color: &str, name: &str) -> Result<(), String> {
    if css_rgba(normalize_color_input(color)).is_none() {
        return Err(format!("Invalid color for {name}: \"{color}\"."));
    }
    Ok(())
}

/// One resolved elevation level: svelai's `--elevation-N` shadow stack (every
/// member, in paint order) + the dark-mode tonal tint.
#[derive(Clone, Debug, PartialEq)]
pub struct Elevation {
    /// Stack members as `(offsetY, blur, color)` — `0 Ypx Bpx rgb(0 0 0 / a)`.
    /// Empty for level 0 / `flat` (svelai emits the zero shadow `0 0 #0000`).
    pub shadows: Vec<(f64, f64, String)>,
    /// `elevation-tint-N`: white overlay in dark mode, transparent otherwise.
    pub tint: String,
}

const SHADOW_STACKS: [&[(f64, f64, f64)]; 6] = [
    &[],
    &[(1.0, 2.0, 0.06)],
    &[(1.0, 3.0, 0.08), (1.0, 2.0, 0.06)],
    &[(4.0, 6.0, 0.08), (2.0, 4.0, 0.06)],
    &[(10.0, 15.0, 0.1), (4.0, 6.0, 0.06)],
    &[(20.0, 25.0, 0.12), (8.0, 10.0, 0.08)],
];
const TINT_ALPHAS: [f64; 6] = [0.0, 0.03, 0.05, 0.07, 0.09, 0.11];

#[derive(Debug, Clone, PartialEq)]
pub struct TokenTheme {
    /// Unique per theme value — recipe caches key on this so a `theme` prop
    /// override never hits a stale resolved style.
    pub id: u64,
    pub mode: Mode,
    /// name → role → hex. Includes the `surface` entry.
    pub palette: HashMap<String, HashMap<String, String>>,
    /// `elevation-tint-N` colors.
    pub tints: HashMap<String, String>,
    pub spacing: HashMap<String, f64>,
    pub control: HashMap<String, f64>,
    pub row: HashMap<String, f64>,
    pub icon: HashMap<String, f64>,
    pub hit: HashMap<String, f64>,
    pub indent: HashMap<String, f64>,
    pub text: HashMap<String, f64>,
    pub radius: HashMap<String, f64>,
    pub font_weight: HashMap<String, f64>,
    /// `elevation-N`/`raised-*`/`lift-*` → shadow.
    pub elevation: HashMap<String, Elevation>,
    pub motion_duration: HashMap<String, f64>,
    pub motion_easing: HashMap<String, String>,
    /// `--spacing` in px (4 × factor) — bare numeric values multiply this.
    pub spacing_unit: f64,
    pub state_hover_opacity: f64,
    pub state_pressed_opacity: f64,
    pub raised_with_border: bool,
    /// Feeds `color` refs on elements that don't pin a `color` ctx.
    pub default_color: String,
    /// The derivation inputs — `with_override` edits these and regenerates.
    pub spec: ThemeSpec,
}

fn scale(pairs: &[(&str, f64)]) -> HashMap<String, f64> {
    pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}

impl TokenTheme {
    pub fn dark() -> Self {
        Self::build(ThemeSpec::for_mode(Mode::Dark))
    }

    pub fn light() -> Self {
        Self::build(ThemeSpec::for_mode(Mode::Light))
    }

    /// Generate every table from the spec — svelai's token compiler.
    fn build(spec: ThemeSpec) -> Self {
        let is_dark = spec.palette.mode == Mode::Dark;
        let (palette, state_hover, state_pressed) = generate_palette(&spec.palette);
        let unit = 4.0 * spec.spacing_factor;
        let spacing = scale(&[
            ("0", 0.0),
            ("micro", 0.5 * unit),
            ("xs", spec.spacing_scale[0] * unit),
            ("sm", spec.spacing_scale[1] * unit),
            ("md", spec.spacing_scale[2] * unit),
            ("lg", spec.spacing_scale[3] * unit),
            ("xl", spec.spacing_scale[4] * unit),
            ("layout-sm", 5.0 * unit),
            ("layout-md", 6.0 * unit),
            ("layout-lg", 8.0 * unit),
            ("layout-xl", 12.0 * unit),
        ]);
        // geometry.ts — all calc(--spacing × N), so they follow the factor.
        let control = scale(&[("sm", 7.0 * unit), ("md", 8.0 * unit), ("lg", 9.0 * unit)]);
        let row = scale(&[("sm", 8.0 * unit), ("md", 10.0 * unit), ("lg", 12.0 * unit)]);
        let icon = scale(&[
            ("xs", 3.0 * unit),
            ("sm", 3.5 * unit),
            ("md", 4.0 * unit),
            ("lg", 5.0 * unit),
            ("xl", 6.0 * unit),
        ]);
        let hit = scale(&[("sm", 7.0 * unit), ("md", 8.0 * unit), ("lg", 9.0 * unit)]);
        let indent = scale(&[
            ("sm", 6.0 * unit),
            ("md", 8.0 * unit),
            ("lg", 10.0 * unit),
            ("xl", 12.0 * unit),
        ]);

        // Radius: rem steps × factor × 16px; `full` is factor-exempt.
        let mut radius = scale(&[("none", 0.0), ("full", 9999.0)]);
        for (name, rem) in RADIUS_STEPS {
            radius.insert(name.to_string(), rem * 16.0 * spec.radius_factor);
        }

        // Fluid type — svelai `typeScaleVariables`: ramp BOTH endpoints, then
        // resolve the emitted `clamp(minRem, slopeVw + interceptRem, maxRem)`
        // at `spec.viewport`, with each term rounded to 3 decimals like the
        // generated CSS.
        let t = &spec.type_options;
        let ramp = |base_px: f64| -> Vec<f64> {
            let mut sizes: Vec<f64> = TYPE_STEPS
                .iter()
                .enumerate()
                .map(|(i, _)| base_px * t.ratio.powf(i as f64 - 2.0))
                .collect();
            // Legibility floors for xs/sm, applied upward like svelai's ramp().
            for (i, floor) in [12.0_f64, 14.0].iter().enumerate().rev() {
                sizes[i] = sizes[i].max(*floor).min(sizes[i + 1]);
            }
            sizes
        };
        let min_sizes = ramp(t.base_min_px);
        let max_sizes = ramp(t.base_max_px);
        let round3 = |v: f64| (v * 1000.0).round() / 1000.0;
        let rem = t.rem_value_in_px;
        let text: HashMap<String, f64> = TYPE_STEPS
            .iter()
            .enumerate()
            .map(|(i, name)| {
                let (min_px, max_px) = (min_sizes[i], max_sizes[i]);
                let slope = (max_px - min_px) / (t.max_viewport - t.min_viewport);
                let intercept = min_px - slope * t.min_viewport;
                let min_term = round3(min_px / rem) * rem;
                let fluid =
                    round3(slope * 100.0) / 100.0 * spec.viewport + round3(intercept / rem) * rem;
                let max_term = round3(max_px / rem) * rem;
                (name.to_string(), fluid.clamp(min_term, max_term))
            })
            .collect();

        // Elevation: the full svelai stack per level (all members, in order)
        // + the dark-mode tonal tint. `flat` zeroes alpha → empty stack.
        let (alpha_f, blur_f) = spec.elevation;
        let mut elevation = HashMap::new();
        let mut tints = HashMap::new();
        for (level, stack) in SHADOW_STACKS.iter().enumerate() {
            let shadows: Vec<(f64, f64, String)> = if stack.is_empty() || alpha_f == 0.0 {
                Vec::new()
            } else {
                stack
                    .iter()
                    .map(|(sy, sb, sa)| {
                        let strength = (sa * alpha_f * if is_dark { 1.8 } else { 1.0 }).min(1.0);
                        (*sy, (sb * blur_f).round(), with_alpha("#000000", strength))
                    })
                    .collect()
            };
            let tint = if is_dark && TINT_ALPHAS[level] > 0.0 && alpha_f > 0.0 {
                with_alpha("#ffffff", TINT_ALPHAS[level])
            } else {
                "transparent".to_string()
            };
            elevation.insert(
                format!("elevation-{level}"),
                Elevation {
                    shadows,
                    tint: tint.clone(),
                },
            );
            tints.insert(format!("elevation-tint-{level}"), tint);
        }
        // svelai aliases: raised-{xs,sm,md,lg,xl,2xl} → levels 1..5; `raised` → 2.
        for (alias, level) in [
            ("xs", 1),
            ("sm", 2),
            ("md", 3),
            ("lg", 4),
            ("xl", 5),
            ("2xl", 5),
        ] {
            let e = elevation[&format!("elevation-{level}")].clone();
            elevation.insert(format!("raised-{alias}"), e.clone());
            elevation.insert(format!("lift-{alias}"), e);
        }
        let default_e = elevation["elevation-2"].clone();
        elevation.insert("raised".to_string(), default_e.clone());
        elevation.insert("lift".to_string(), default_e);

        // `tables:` raw overrides sit on top of the derived maps.
        let apply = |map: &mut HashMap<String, f64>, table: &str| {
            if let Some(overrides) = spec.table_overrides.get(table) {
                for (name, px) in overrides {
                    map.insert(name.clone(), *px);
                }
            }
        };
        let mut spacing = spacing;
        let mut text = text;
        let mut radius = radius;
        let mut control = control;
        let mut row = row;
        let mut icon = icon;
        let mut hit = hit;
        let mut indent = indent;
        apply(&mut spacing, "spacing");
        apply(&mut text, "text");
        apply(&mut radius, "radius");
        apply(&mut control, "control");
        apply(&mut row, "row");
        apply(&mut icon, "icon");
        apply(&mut hit, "hit");
        apply(&mut indent, "indent");

        Self {
            id: fresh_id(),
            mode: spec.palette.mode,
            palette,
            tints,
            spacing,
            control,
            row,
            icon,
            hit,
            indent,
            text,
            radius,
            font_weight: scale(&[
                ("normal", 400.0),
                ("medium", 500.0),
                ("semibold", 600.0),
                ("bold", 700.0),
            ]),
            elevation,
            motion_duration: spec.motion_duration.clone(),
            motion_easing: spec.motion_easing.clone(),
            spacing_unit: unit,
            state_hover_opacity: state_hover,
            state_pressed_opacity: state_pressed,
            raised_with_border: spec.raised_with_border,
            default_color: spec.default_color.clone(),
            spec,
        }
    }

    /// A `theme` prop value in svelai's designTokens vocabulary — each key
    /// optional, applied over self and fully regenerated:
    /// `{mode, palette, colors, surface, defaultColor, spacing, spacingScale,
    ///   radius, typeScale, elevation, raisedWithBorder, motion,
    ///   stateHoverOpacity, statePressedOpacity, luminance, saturation,
    ///   viewport, tables}`.
    ///
    /// Validation mirrors svelai's `throw` sites — every malformed input is an
    /// `Err` (the cascade caller logs it and keeps the parent theme; a bad
    /// theme must never silently degrade into black-on-black).
    ///
    /// `tables` is an nkit extension with no svelai analogue: raw resolved-px
    /// tables (`{spacing:{name:px}, text, radius, control, row, icon, hit,
    ///   indent}`) applied *over* the derived maps — it is how the JS-side
    ///   `applyTokenOverrides` writes reach Rust verbatim.
    pub fn with_override(&self, value: &serde_json::Value) -> Result<Self, String> {
        let mut spec = self.spec.clone();
        // `mode` is a full scheme swap — svelai treats anything that is not
        // `dark` as light (`colorscheme === 'dark'` is the only check).
        match value.get("mode").and_then(|v| v.as_str()) {
            Some("dark") => spec.palette = PaletteSpec::dark(),
            Some(_) => spec.palette = PaletteSpec::light(),
            _ => {}
        }
        // `palette`: "dark"|"light" swaps the color inputs to that scheme's
        // defaults; an object merges as `colors`. Unknown names are svelai's
        // `paletteByName` throw.
        match value.get("palette") {
            Some(serde_json::Value::String(name)) => match name.as_str() {
                "light" => spec.palette = PaletteSpec::light(),
                "dark" => spec.palette = PaletteSpec::dark(),
                other => return Err(format!("Unknown palette \"{other}\".")),
            },
            Some(serde_json::Value::Object(map)) => apply_colors(&mut spec, map)?,
            _ => {}
        }
        if let Some(serde_json::Value::Object(map)) = value.get("colors") {
            apply_colors(&mut spec, map)?;
        }
        match value.get("surface") {
            Some(serde_json::Value::String(color)) => {
                validate_color(color, "surface")?;
                spec.palette.surface = color.clone();
            }
            Some(serde_json::Value::Object(map)) => {
                for (k, v) in map {
                    let Some(color) = v.as_str() else { continue };
                    validate_color(color, &format!("surface.{k}"))?;
                    if k == "base" || k == "DEFAULT" {
                        spec.palette.surface = color.to_string();
                    } else {
                        spec.palette
                            .surface_roles
                            .insert(k.clone(), color.to_string());
                    }
                }
            }
            _ => {}
        }
        if let Some(c) = value.get("defaultColor").and_then(|v| v.as_str()) {
            // Feeds `color` refs — must name a palette entry.
            if !SEMANTIC.contains(&c) && !spec.palette.colors.contains_key(c) {
                return Err(format!("defaultColor \"{c}\" is not a palette color."));
            }
            spec.default_color = c.to_string();
        }
        // svelai routes these through colorizr's `lighten`/`saturate`, which
        // throw `isNumberInRange(amount, 0, 100)` on out-of-range input.
        if let Some(v) = value.get("luminance") {
            let Some(l) = v.as_f64().filter(|l| (0.0..=100.0).contains(l)) else {
                return Err("luminance must be a number between 0 and 100.".to_string());
            };
            spec.palette.luminance = Some(l);
        }
        if let Some(v) = value.get("saturation") {
            let Some(s) = v.as_f64().filter(|s| (0.0..=100.0).contains(s)) else {
                return Err("saturation must be a number between 0 and 100.".to_string());
            };
            spec.palette.saturation = Some(s);
        }
        if let Some(v) = value
            .get("stateHoverOpacity")
            .or_else(|| value.get("state-hover-opacity"))
            .and_then(|v| v.as_f64())
        {
            spec.palette.state_hover = Some(v);
        }
        if let Some(v) = value
            .get("statePressedOpacity")
            .or_else(|| value.get("state-pressed-opacity"))
            .and_then(|v| v.as_f64())
        {
            spec.palette.state_pressed = Some(v);
        }
        // svelai factor knobs — `presetFactor` throws on unknown names and
        // `finiteNumber` on negative/non-finite numbers.
        if let Some(v) = value.get("spacing") {
            spec.spacing_factor = match v {
                serde_json::Value::Number(n) => {
                    n.as_f64()
                        .filter(|n| n.is_finite() && *n >= 0.0)
                        .ok_or_else(|| "spacing must be a finite number >= 0.".to_string())?
                }
                serde_json::Value::String(s) => SPACING_FACTORS
                    .iter()
                    .find(|(k, _)| k == &s.as_str())
                    .map(|(_, f)| *f)
                    .ok_or_else(|| format!("Unknown spacing preset \"{s}\"."))?,
                _ => spec.spacing_factor,
            };
        }
        if let Some(serde_json::Value::Object(map)) = value.get("spacingScale") {
            for (i, step) in ["xs", "sm", "md", "lg", "xl"].iter().enumerate() {
                if let Some(v) = map.get(*step) {
                    let n = v
                        .as_f64()
                        .filter(|n| n.is_finite() && *n > 0.0)
                        .ok_or_else(|| {
                            format!("spacingScale.{step} must be a finite number greater than 0.")
                        })?;
                    spec.spacing_scale[i] = n;
                }
            }
            // svelai validates the merged scale end to end — a partial object
            // cannot sneak a non-monotonic scale past the check.
            for pair in spec.spacing_scale.windows(2) {
                if pair[1] <= pair[0] {
                    return Err("spacingScale steps must be strictly increasing.".to_string());
                }
            }
        }
        if let Some(v) = value.get("radius") {
            spec.radius_factor = match v {
                serde_json::Value::Number(n) => {
                    n.as_f64()
                        .filter(|n| n.is_finite() && *n >= 0.0)
                        .ok_or_else(|| "radius must be a finite number >= 0.".to_string())?
                }
                serde_json::Value::String(s) => RADIUS_FACTORS
                    .iter()
                    .find(|(k, _)| k == &s.as_str())
                    .map(|(_, f)| *f)
                    .ok_or_else(|| format!("Unknown radius preset \"{s}\"."))?,
                _ => spec.radius_factor,
            };
        }
        match value.get("typeScale") {
            Some(serde_json::Value::String(name)) => {
                spec.type_options = TypeOptions::preset(name)
                    .ok_or_else(|| format!("Unknown typeScale preset \"{name}\"."))?;
            }
            Some(serde_json::Value::Object(map)) => {
                let t = &mut spec.type_options;
                if let Some(v) = map.get("baseMinPx") {
                    t.base_min_px = v.as_f64().filter(|n| *n > 0.0).ok_or_else(|| {
                        "typeScale.baseMinPx must be a finite number greater than 0.".to_string()
                    })?;
                }
                if let Some(v) = map.get("baseMaxPx") {
                    t.base_max_px = v.as_f64().filter(|n| *n > 0.0).ok_or_else(|| {
                        "typeScale.baseMaxPx must be a finite number greater than 0.".to_string()
                    })?;
                }
                if let Some(v) = map.get("minViewport") {
                    t.min_viewport = v
                        .as_f64()
                        .filter(|n| n.is_finite() && *n >= 0.0)
                        .ok_or_else(|| {
                            "typeScale.minViewport must be a finite number >= 0.".to_string()
                        })?;
                }
                if let Some(v) = map.get("maxViewport") {
                    t.max_viewport = v.as_f64().filter(|n| *n > 0.0).ok_or_else(|| {
                        "typeScale.maxViewport must be a finite number greater than 0.".to_string()
                    })?;
                }
                if let Some(v) = map.get("remValueInPx") {
                    t.rem_value_in_px = v.as_f64().filter(|n| *n > 0.0).ok_or_else(|| {
                        "typeScale.remValueInPx must be a finite number greater than 0.".to_string()
                    })?;
                }
                if let Some(s) = map.get("scale").and_then(|v| v.as_str()) {
                    t.ratio = TYPE_RATIOS
                        .iter()
                        .find(|(k, _)| k == &s)
                        .map(|(_, r)| *r)
                        .ok_or_else(|| format!("Unknown typeScale ratio \"{s}\"."))?;
                }
                if t.base_max_px < t.base_min_px {
                    return Err(
                        "typeScale.baseMaxPx must be greater than or equal to typeScale.baseMinPx."
                            .to_string(),
                    );
                }
                if t.max_viewport <= t.min_viewport {
                    return Err(
                        "typeScale.maxViewport must be greater than typeScale.minViewport."
                            .to_string(),
                    );
                }
            }
            _ => {}
        }
        if let Some(v) = value.get("viewport") {
            // nkit's fluid-ramp window — svelai uses live `innerWidth`.
            if let Some(n) = v.as_f64().filter(|n| n.is_finite() && *n > 0.0) {
                spec.viewport = n;
            }
        }
        if let Some(v) = value.get("elevation") {
            spec.elevation = match v.as_str() {
                Some("flat") => (0.0, 1.0),
                Some("high") => (1.5, 1.3),
                Some("normal") => (1.0, 1.0),
                Some(other) => return Err(format!("Unknown elevation preset \"{other}\".")),
                None => spec.elevation,
            };
        }
        if let Some(b) = value.get("raisedWithBorder").and_then(|v| v.as_bool()) {
            spec.raised_with_border = b;
        }
        if let Some(serde_json::Value::Object(motion)) = value.get("motion") {
            if let Some(serde_json::Value::Object(d)) = motion.get("duration") {
                for (k, v) in d {
                    let Some(n) = v.as_f64() else { continue };
                    if !n.is_finite() || n < 0.0 {
                        return Err(format!("motion.duration.{k} must be a finite number >= 0."));
                    }
                    spec.motion_duration.insert(k.clone(), n);
                }
            }
            if let Some(serde_json::Value::Object(e)) = motion.get("easing") {
                for (k, v) in e {
                    if let Some(s) = v.as_str() {
                        spec.motion_easing.insert(k.clone(), s.to_string());
                    }
                }
            }
        }
        // The JS `applyTokenOverrides` raw-table bridge: resolved px values
        // written over the derived maps. Not part of svelai's vocabulary —
        // svelai themes can only express factors and presets.
        if let Some(serde_json::Value::Object(tables)) = value.get("tables") {
            const TABLES: [&str; 8] = [
                "spacing", "text", "radius", "control", "row", "icon", "hit", "indent",
            ];
            for (table, entries) in tables {
                if !TABLES.contains(&table.as_str()) {
                    continue;
                }
                let Some(entries) = entries.as_object() else {
                    continue;
                };
                let target = spec.table_overrides.entry(table.clone()).or_default();
                for (name, v) in entries {
                    let Some(n) = v.as_f64().filter(|n| n.is_finite()) else {
                        return Err(format!("tables.{table}.{name} must be a finite number."));
                    };
                    target.insert(name.clone(), n);
                }
            }
        }
        Ok(Self::build(spec))
    }

    /// Whether a `theme` custom prop value speaks the designTokens vocabulary.
    /// `x-input`/`x-code` reuse the `theme` prop name for their own legacy
    /// object shapes (`{caret: …}`, `{background: …}`) — those contain none of
    /// these keys and must not trigger a token cascade.
    pub fn is_theme_declaration(value: &serde_json::Value) -> bool {
        value.as_object().is_some_and(|map| {
            map.keys()
                .any(|k| THEME_DECLARATION_KEYS.contains(&k.as_str()))
        })
    }

    /// Memoized `with_override` for the cascade: a `theme` declaration folded
    /// over `self`, shared by every element under the same parent theme.
    /// Invalid declarations warn and keep `self` — svelai throws at compile
    /// time, the runtime analog is refuse-and-log.
    pub fn themed(
        self: &std::sync::Arc<Self>,
        declaration: &serde_json::Value,
    ) -> std::sync::Arc<Self> {
        use std::hash::{Hash, Hasher};
        let mut hasher = rustc_hash::FxHasher::default();
        declaration.to_string().hash(&mut hasher);
        let key = hasher.finish();
        thread_local! {
            // Keyed by (parent theme id, declaration hash). Themes are few and
            // immutable; the cap keeps a hostile prop stream from growing it.
            static THEME_MEMO: std::cell::RefCell<HashMap<(u64, u64), std::sync::Arc<TokenTheme>>> =
                std::cell::RefCell::new(HashMap::new());
        }
        if let Some(hit) = THEME_MEMO.with(|m| m.borrow().get(&(self.id, key)).cloned()) {
            return hit;
        }
        let derived = match self.with_override(declaration) {
            Ok(theme) => std::sync::Arc::new(theme),
            Err(error) => {
                log::warn!("Ignoring invalid theme declaration: {error}");
                return self.clone();
            }
        };
        THEME_MEMO.with(|m| {
            let mut memo = m.borrow_mut();
            if memo.len() >= 512 {
                memo.clear();
            }
            memo.insert((self.id, key), derived.clone());
        });
        derived
    }

    /// `color-muted` / `primary/20` / `surface-raised` / `elevation-tint-3` /
    /// `transparent` → concrete color string. `None` = not a token — callers
    /// pass literals (`#hex`, `rgb()`, named colors) straight through.
    pub fn resolve_color(&self, reference: &str, ctx_color: Option<&str>) -> Option<String> {
        if reference.starts_with('#') || reference.contains('(') {
            return None;
        }
        let (base_ref, alpha) = match reference.split_once('/') {
            // The JS gate uses `parseFloat` — lenient: `20x` → 20, `10%` → 10,
            // `20/30` → 20; a non-numeric *prefix* leaves the ref unresolved.
            Some((head, tail)) => match js_parse_float(tail) {
                Some(a) => (head, Some(if a > 1.0 { a / 100.0 } else { a })),
                None => return None,
            },
            None => (reference, None),
        };
        let entry = |name: &str| self.palette.get(name);
        let role_hex = |entry: &HashMap<String, String>, role: Option<&str>| {
            role.and_then(|r| entry.get(r))
                .or_else(|| entry.get("base"))
                .cloned()
        };
        let hex = match base_ref {
            "transparent" => "transparent".to_string(),
            // Both spellings reach the wire: `current` from token syntax and
            // `currentColor` from the JS gate (ring defaults, state layers).
            "current" | "currentColor" => "currentColor".to_string(),
            "surface" => role_hex(entry("surface")?, None)?,
            _ => {
                if let Some(tint) = base_ref.strip_prefix("elevation-tint-") {
                    self.tints.get(&format!("elevation-tint-{tint}"))?.clone()
                } else {
                    let (name, role) = match base_ref.split_once('-') {
                        Some((n, r)) => (n, Some(r)),
                        None => (base_ref, None),
                    };
                    if name == "color" {
                        // An empty `color` prop is falsy in svelai — it falls
                        // back to `defaultColor`, it does not poison the ctx.
                        let ctx = ctx_color
                            .filter(|c| !c.is_empty())
                            .unwrap_or(&self.default_color);
                        let role = base_ref.strip_prefix("color-");
                        role_hex(entry(ctx)?, role)?
                    } else if name == "surface" {
                        role_hex(entry("surface")?, Some(&base_ref[8..]))?
                    } else {
                        role_hex(entry(name)?, role)?
                    }
                }
            }
        };
        Some(match alpha {
            None => hex,
            Some(0.0) => "transparent".to_string(),
            Some(a) => with_alpha(&hex, a),
        })
    }

    /// Rewrite token strings inside a style JSON before `StyleDesc`
    /// deserialization. Recurses `hover`/`active`. Returns what it couldn't
    /// resolve plus the `stateLayer` flag (consumed by the element).
    ///
    /// Unresolvable tokens are REMOVED — leaving them would poison serde
    /// (a stray string in an f64 field fails the whole StyleDesc). Literal
    /// values (`#hex`, `rgb()`, `var()`, numbers, `%`) pass through.
    pub fn resolve_style(
        &self,
        value: &mut serde_json::Value,
        ctx_color: Option<&str>,
    ) -> ResolveOutcome {
        let mut out = ResolveOutcome::default();
        let serde_json::Value::Object(map) = value else {
            return out;
        };
        let mut dead = Vec::new();
        // `raised`/`lift` run AFTER the loop: the merge reads the authored
        // `boxShadow`/`borderWidth`/`borderColor` in their final state, so
        // JSON key order cannot change the outcome.
        let mut raised: Option<(bool, Raised)> = None;
        // Buckets that declared their own `stateLayer` — baked per-bucket
        // after the loop, once the top-level `color`/`backgroundColor` they
        // composite over are resolved.
        let mut bucket_bakes: Vec<String> = Vec::new();
        for (key, field) in map.iter_mut() {
            if key == "stateLayer" {
                if field.as_bool() == Some(true) {
                    out.state_layer = true;
                }
                dead.push(key.clone());
                continue;
            }
            if key == "raised" || key == "lift" {
                dead.push(key.clone());
                raised = Some((key == "raised", Raised::parse(field)));
                continue;
            }
            // Pseudo buckets — `focusVisible` maps to gpui's focus_visible
            // refinement, `focusWithin` to in_focus. A non-object value would
            // fail StyleDesc deserialization wholesale, so it drops here.
            if matches!(
                key.as_str(),
                "hover" | "active" | "focus" | "focusWithin" | "focusVisible"
            ) {
                if field.is_object() {
                    let inner = self.resolve_style(field, ctx_color);
                    // A nested `stateLayer` scopes to its own bucket — it must
                    // not hoist to the top-level flag (x-* elements would
                    // paint a permanent overlay, generics would bake *both*
                    // buckets with the wrong fg).
                    if inner.state_layer {
                        bucket_bakes.push(key.clone());
                    }
                    out.dropped.extend(inner.dropped);
                } else {
                    dead.push(key.clone());
                }
                continue;
            }
            match (field_kind(key), &mut *field) {
                (Some(FieldKind::Color), serde_json::Value::String(token)) => {
                    match self.resolve_color(token, ctx_color) {
                        Some(hex) => *field = serde_json::Value::String(hex),
                        None if is_literal(token) => {}
                        None => dead.push(key.clone()),
                    }
                }
                // `background` as a gradient object: token refs inside the
                // color stops resolve the same as any color field.
                (Some(FieldKind::Color), serde_json::Value::Object(inner))
                    if key == "background" =>
                {
                    if let Some(serde_json::Value::Array(stops)) = inner.get_mut("stops") {
                        let mut stops_dead = false;
                        for stop in stops {
                            let Some(serde_json::Value::String(token)) = stop.get_mut("color")
                            else {
                                continue;
                            };
                            match self.resolve_color(token, ctx_color) {
                                Some(hex) => *token = hex,
                                None if is_literal(token) => {}
                                None => stops_dead = true,
                            }
                        }
                        if stops_dead {
                            dead.push(key.clone());
                        }
                    }
                }
                // JSON numbers are already px — JS resolves class numerics
                // (`p-2` → 8) before the wire. The ×--spacing convention
                // applies to *string* numerics, handled in spacing_px below.
                (Some(FieldKind::Spacing), serde_json::Value::Number(_)) => {}
                (Some(FieldKind::Spacing), serde_json::Value::String(token)) => {
                    match self.spacing_px(token) {
                        Some(v) => *field = serde_json::Value::from(v),
                        None => dead.push(key.clone()),
                    }
                }
                (Some(FieldKind::Dimension), serde_json::Value::Number(_)) => {}
                (Some(FieldKind::Dimension), serde_json::Value::String(token)) => {
                    match token.as_str() {
                        "full" => *field = serde_json::Value::String("100%".to_string()),
                        "auto" | "fit" => *field = serde_json::Value::String("auto".to_string()),
                        _ if token.ends_with('%') || token.ends_with("px") => {
                            if token.ends_with("px") {
                                if let Ok(n) = token[..token.len() - 2].parse::<f64>() {
                                    *field = serde_json::Value::from(n);
                                }
                            }
                        }
                        _ => match self.dimension_px(token) {
                            Some(v) => *field = serde_json::Value::from(v),
                            None => dead.push(key.clone()),
                        },
                    }
                }
                (Some(FieldKind::Text), serde_json::Value::String(token)) => {
                    match self
                        .text
                        .get(token.as_str())
                        .copied()
                        .or_else(|| px_literal(token))
                    {
                        Some(n) => *field = serde_json::Value::from(n),
                        None => dead.push(key.clone()),
                    }
                }
                (Some(FieldKind::Radius), serde_json::Value::String(token)) => {
                    match self
                        .radius
                        .get(token.as_str())
                        .copied()
                        .or_else(|| px_literal(token))
                    {
                        Some(n) => *field = serde_json::Value::from(n),
                        None => dead.push(key.clone()),
                    }
                }
                (Some(FieldKind::FontWeight), serde_json::Value::String(token)) => {
                    // Named weights or a numeric string — svelai passes raw
                    // numbers through (`fontWeight: '700'` is valid CSS).
                    match self.font_weight.get(token.as_str()).copied().or_else(|| {
                        token
                            .parse::<f64>()
                            .ok()
                            .filter(|n| n.is_finite() && *n > 0.0)
                    }) {
                        Some(n) => *field = serde_json::Value::from(n),
                        None => dead.push(key.clone()),
                    }
                }
                (Some(FieldKind::Elevation), serde_json::Value::String(token)) => {
                    match self.elevation.get(token.as_str()) {
                        Some(e) => {
                            *field = serde_json::Value::Array(shadow_list(e));
                        }
                        None => dead.push(key.clone()),
                    }
                }
                (Some(FieldKind::Elevation), serde_json::Value::Object(inner)) => {
                    if let Some(serde_json::Value::String(token)) = inner.get_mut("color") {
                        match self.resolve_color(token, ctx_color) {
                            Some(hex) => *token = hex,
                            None if is_literal(token) => {}
                            None => dead.push(key.clone()),
                        }
                    }
                }
                // Authored shadow lists: token refs in each member's `color`.
                (Some(FieldKind::Elevation), serde_json::Value::Array(members)) => {
                    for member in members {
                        if let Some(serde_json::Value::String(token)) = member.get_mut("color") {
                            match self.resolve_color(token, ctx_color) {
                                Some(hex) => *token = hex,
                                None if is_literal(token) => {}
                                None => dead.push(key.clone()),
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        for key in dead {
            // `raised`/`lift`/`stateLayer` are consumed pseudo-fields, not
            // unresolvable tokens — don't audit them as drops.
            if !matches!(key.as_str(), "raised" | "lift" | "stateLayer") {
                out.dropped.push(key.clone());
            }
            map.remove(&key);
        }
        if let Some((bordered, level)) = raised {
            self.expand_raised(map, bordered, level, ctx_color);
        }
        // `currentColor` in a shadow member means the element's text color —
        // gpui needs a concrete color, so resolve it against the *resolved*
        // `color` field. No text color → the member can't paint; drop it.
        // `boxShadow` arrives as a single object or a list — normalize both.
        let resolved_fg = map
            .get("color")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        if let Some(shadow) = map.get_mut("boxShadow") {
            let fg = resolved_fg;
            let fix = |member: &mut serde_json::Value| -> bool {
                if member.get("color").and_then(|c| c.as_str()) == Some("currentColor") {
                    match &fg {
                        Some(f) => {
                            member["color"] = serde_json::Value::String(f.clone());
                            true
                        }
                        None => false,
                    }
                } else {
                    true
                }
            };
            match shadow {
                serde_json::Value::Array(members) => members.retain_mut(|m| fix(m)),
                serde_json::Value::Object(_) => {
                    if !fix(shadow) {
                        *shadow = serde_json::Value::Array(vec![]);
                    }
                }
                _ => {}
            }
        }
        if !bucket_bakes.is_empty() {
            let top_fg = map
                .get("color")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let top_bg = map
                .get("backgroundColor")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            for key in bucket_bakes {
                let opacity = if key == "active" {
                    self.state_pressed_opacity
                } else {
                    self.state_hover_opacity
                };
                let Some(bucket) = map.get_mut(&key).and_then(|v| v.as_object_mut()) else {
                    continue;
                };
                if bucket.contains_key("backgroundColor") {
                    continue;
                }
                let Some(fg) = bucket
                    .get("color")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .or_else(|| top_fg.clone())
                    .or_else(|| self.resolve_color("neutral-readable", ctx_color))
                else {
                    continue;
                };
                bucket.insert(
                    "backgroundColor".to_string(),
                    serde_json::Value::String(overlay_composite(top_bg.as_deref(), &fg, opacity)),
                );
            }
        }
        out
    }

    /// svelai's `raised-*`/`lift-*` utilities. The tonal tint rides as an
    /// `inset 0 0 0 9999px` shadow *inside* the list — svelai composes it with
    /// the elevation stack so a gradient/image background survives. Authored
    /// inset shadows (rings) keep their slot ahead of it; an authored
    /// non-inset `boxShadow` is replaced — both write `--tw-shadow`.
    ///
    /// `none`/`0` clears `--tw-shadow` (keeping authored insets) and, for
    /// `raised`, zeroes the border. An unknown level means the utility does
    /// not exist in svelai — it emits nothing at all.
    fn expand_raised(
        &self,
        map: &mut serde_json::Map<String, serde_json::Value>,
        bordered: bool,
        level: Raised,
        ctx_color: Option<&str>,
    ) {
        // svelai composes `--tw-inset-shadow`, `--tw-ring-*` and `--tw-shadow`
        // into one box-shadow list: authored inset members AND ring members
        // keep their slots; only the authored non-inset drop shadow is
        // replaced (it's the same var).
        let preserved = preserved_shadow_members(map.get("boxShadow"));
        match level {
            Raised::Invalid => {}
            Raised::Clear => {
                map.insert("boxShadow".to_string(), serde_json::Value::Array(preserved));
                if bordered {
                    // `raised-none` → `border: 0px` — unconditional, authored
                    // borders included (it is the shorthand).
                    map.insert("borderWidth".to_string(), serde_json::json!(0));
                }
            }
            Raised::Level(level) => {
                if let Some(e) = self.elevation.get(&format!("elevation-{level}")) {
                    let mut list = preserved;
                    if e.tint != "transparent" {
                        list.push(serde_json::json!({
                            "offsetX": 0, "offsetY": 0, "blurRadius": 0,
                            "spreadRadius": 9999, "inset": true, "color": e.tint,
                        }));
                    }
                    list.extend(shadow_list(e));
                    map.insert("boxShadow".to_string(), serde_json::Value::Array(list));
                }
                if bordered {
                    if self.raised_with_border {
                        // `var(--current-border, …)` — authored fields win.
                        map.entry("borderWidth".to_string())
                            .or_insert(serde_json::json!(1));
                        if let Some(hex) = self.resolve_color("neutral-muted", ctx_color) {
                            map.entry("borderColor".to_string())
                                .or_insert(serde_json::Value::String(hex));
                        }
                    } else {
                        // raisedWithBorder:false → `--raised-border: 0 solid
                        // transparent` — the declaration still exists.
                        map.entry("borderWidth".to_string())
                            .or_insert(serde_json::json!(0));
                    }
                }
            }
        }
    }

    /// `state-layer` for generic elements: the currentColor overlay is baked
    /// into `hover`/`active` `backgroundColor` (`??=` — an explicit state bg
    /// wins). `x-*` elements paint a real overlay child via the recipe path
    /// instead, so they consume `ResolveOutcome::state_layer` directly and
    /// never call this. Mirrors the JS `overlay()` composite exactly.
    pub fn bake_state_layer(&self, value: &mut serde_json::Value) {
        let Some(map) = value.as_object_mut() else {
            return;
        };
        let Some(fg) = map
            .get("color")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or_else(|| self.resolve_color("neutral-readable", None))
        else {
            return;
        };
        let bg = map
            .get("backgroundColor")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        for (key, opacity) in [
            ("hover", self.state_hover_opacity),
            ("active", self.state_pressed_opacity),
        ] {
            let bucket = map
                .entry(key.to_string())
                .or_insert_with(|| serde_json::json!({}));
            let Some(bucket_map) = bucket.as_object_mut() else {
                continue;
            };
            if bucket_map.contains_key("backgroundColor") {
                continue;
            }
            bucket_map.insert(
                "backgroundColor".to_string(),
                serde_json::Value::String(overlay_composite(bg.as_deref(), &fg, opacity)),
            );
        }
    }

    /// Spacing-kind value: named scale, `indent-*` (padding-side geometry),
    /// bare number ×`--spacing`, `"Npx"`.
    fn spacing_px(&self, token: &str) -> Option<f64> {
        if let Some(n) = self.spacing.get(token) {
            return Some(*n);
        }
        if let Some(rest) = token.strip_prefix("indent-") {
            if let Some(n) = self.indent.get(rest) {
                return Some(*n);
            }
        }
        if let Some(px) = px_literal(token) {
            return Some(px);
        }
        token.parse::<f64>().ok().map(|n| n * self.spacing_unit)
    }

    /// Dimension-kind value: geometry scales → spacing names → numerics.
    fn dimension_px(&self, token: &str) -> Option<f64> {
        for (prefix, table) in [
            ("control-", &self.control),
            ("row-", &self.row),
            ("icon-", &self.icon),
            ("hit-", &self.hit),
            ("indent-", &self.indent),
        ] {
            if let Some(rest) = token.strip_prefix(prefix) {
                if let Some(n) = table.get(rest) {
                    return Some(*n);
                }
            }
        }
        self.spacing_px(token)
    }
}

/// svelai `raised-*`/`lift-*` level. `""`/`DEFAULT` → 2 (the bare utility);
/// `none`/`0` clear; an unknown level means the utility does not exist.
enum Raised {
    Clear,
    Level(usize),
    Invalid,
}

impl Raised {
    fn parse(field: &serde_json::Value) -> Self {
        match field.as_str() {
            None | Some("") | Some("DEFAULT") => Self::Level(2),
            Some("none") | Some("0") => Self::Clear,
            Some(token) => match token {
                "xs" => Self::Level(1),
                "sm" => Self::Level(2),
                "md" => Self::Level(3),
                "lg" => Self::Level(4),
                "xl" | "2xl" => Self::Level(5),
                other => other
                    .parse::<usize>()
                    .ok()
                    .filter(|l| *l <= 5)
                    .map(Self::Level)
                    .unwrap_or(Self::Invalid),
            },
        }
    }
}

/// `Elevation::shadows` → JSON members for the `boxShadow` list.
fn shadow_list(e: &Elevation) -> Vec<serde_json::Value> {
    e.shadows
        .iter()
        .map(|(y, blur, color)| {
            serde_json::json!({
                "offsetX": 0, "offsetY": y,
                "blurRadius": blur, "spreadRadius": 0,
                "color": color,
            })
        })
        .collect()
}

/// Authored `boxShadow` members that survive a `raised`/`lift` merge —
/// svelai's `--tw-inset-shadow` and `--tw-ring-*` vars compose ahead of
/// `--tw-shadow`, so members flagged `inset` (authored insets, inset rings)
/// or `ring` (emitted by `ring-*`) keep their slots; only the authored
/// non-inset drop shadow is replaced.
fn preserved_shadow_members(value: Option<&serde_json::Value>) -> Vec<serde_json::Value> {
    let keeps = |member: &serde_json::Value| {
        member.get("inset").and_then(|v| v.as_bool()) == Some(true)
            || member.get("ring").and_then(|v| v.as_bool()) == Some(true)
    };
    match value {
        Some(serde_json::Value::Array(members)) => {
            members.iter().filter(|m| keeps(m)).cloned().collect()
        }
        Some(member @ serde_json::Value::Object(_)) if keeps(member) => vec![member.clone()],
        _ => Vec::new(),
    }
}

/// Side-band of `resolve_style`: flags the element consumes and the audit
/// trail of dropped (unresolvable) properties.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct ResolveOutcome {
    /// `stateLayer: true` was present — paint the currentColor state overlay.
    /// Only the *top-level* key sets this; a bucket-scoped `stateLayer` bakes
    /// into that bucket alone.
    pub state_layer: bool,
    pub dropped: Vec<String>,
}

fn is_literal(token: &str) -> bool {
    token.starts_with('#') || token.contains('(')
}

/// fg composited over bg at `alpha` — transparent/missing bg → `#rrggbbaa`,
/// solid bg → mixed rgb (JS `overlay()` — emits the `#rrggbbff` form like JS).
/// An unparseable fg (`currentColor`, garbage) falls back to neutral-ish
/// `[250,250,250]` like the JS gate does — never leaks the raw string into a
/// baked background.
fn overlay_composite(bg: Option<&str>, fg: &str, alpha: f64) -> String {
    let (fr, fg_, fb) = hex_to_rgb(fg).unwrap_or((250.0, 250.0, 250.0));
    match bg
        .filter(|b| *b != "transparent")
        .and_then(|b| hex_to_rgb(b))
    {
        Some((r, g, b)) => {
            let mix = |x: f64, y: f64| x * (1.0 - alpha) + y * alpha;
            let mixed = rgb_to_hex(mix(r, fr), mix(g, fg_), mix(b, fb));
            format!("{mixed}ff")
        }
        None => {
            let a = (alpha.clamp(0.0, 1.0) * 255.0).round() as u8;
            format!("{}{a:02x}", rgba_to_hex(fr, fg_, fb, 1.0))
        }
    }
}

fn px_literal(token: &str) -> Option<f64> {
    token.strip_suffix("px")?.parse::<f64>().ok()
}

/// JS `parseFloat`: longest valid numeric prefix — `20x`→20, `10%`→10,
/// `.5`→0.5, `1e2`→100. `None` when the prefix isn't numeric at all
/// (`""`, `"x"`, `"/30"`).
fn js_parse_float(s: &str) -> Option<f64> {
    let s = s.trim_start();
    let bytes = s.as_bytes();
    let mut i = 0;
    if matches!(bytes.first(), Some(b'+') | Some(b'-')) {
        i += 1;
    }
    let mut saw_digit = false;
    while bytes.get(i).is_some_and(|b| b.is_ascii_digit()) {
        i += 1;
        saw_digit = true;
    }
    if bytes.get(i) == Some(&b'.') {
        i += 1;
        while bytes.get(i).is_some_and(|b| b.is_ascii_digit()) {
            i += 1;
            saw_digit = true;
        }
    }
    if !saw_digit {
        return None;
    }
    if matches!(bytes.get(i), Some(b'e') | Some(b'E')) {
        let mut j = i + 1;
        if matches!(bytes.get(j), Some(b'+') | Some(b'-')) {
            j += 1;
        }
        let exp_start = j;
        while bytes.get(j).is_some_and(|b| b.is_ascii_digit()) {
            j += 1;
        }
        if j > exp_start {
            i = j;
        }
    }
    s[..i].parse::<f64>().ok()
}

/// `colors`/`palette` object → spec inputs. Accepts svelai's shape:
/// `{primary: "#hex"}` (base only), `{primary: {base, muted, …}}` (role
/// overrides), or flat `{"primary-muted": "#hex"}` keys. `surface`/`surface-*`
/// keys route to the surface inputs, never to phantom color entries — svelai's
/// `ColorTheme` type makes them flat theme keys.
///
/// Base values normalize like `generateBaseColors`: hex verbatim, Tailwind
/// name → `500`, other CSS color strings verbatim. Every authored string must
/// parse as a CSS color — svelai throws via colorizr otherwise.
fn apply_colors(
    spec: &mut ThemeSpec,
    map: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    for (name, v) in map {
        match v {
            serde_json::Value::String(color) => {
                validate_color(color, name)?;
                // An empty string is falsy in svelai → the input stays unset,
                // it does not become a base of "".
                if color.is_empty() {
                    continue;
                }
                if name == "surface" {
                    spec.palette.surface = normalize_color_input(color).to_string();
                    continue;
                }
                if let Some(role) = name.strip_prefix("surface-") {
                    spec.palette
                        .surface_roles
                        .insert(role.to_string(), color.clone());
                    continue;
                }
                if let Some((color_name, role)) = name.split_once('-') {
                    spec.palette
                        .colors
                        .entry(color_name.to_string())
                        .or_default()
                        .roles
                        .insert(role.to_string(), color.clone());
                } else {
                    spec.palette.colors.entry(name.clone()).or_default().base =
                        Some(normalize_color_input(color).to_string());
                }
            }
            serde_json::Value::Object(roles) => {
                if name == "surface" || name.starts_with("surface-") {
                    continue;
                }
                for (role, v) in roles {
                    let Some(color) = v.as_str() else { continue };
                    validate_color(color, &format!("{name}.{role}"))?;
                    if color.is_empty() {
                        continue;
                    }
                    let entry = spec.palette.colors.entry(name.clone()).or_default();
                    if role == "base" || role == "DEFAULT" {
                        entry.base = Some(normalize_color_input(color).to_string());
                    } else {
                        entry.roles.insert(role.clone(), color.to_string());
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

enum FieldKind {
    Color,
    Spacing,
    Text,
    Radius,
    Dimension,
    FontWeight,
    Elevation,
}

fn field_kind(key: &str) -> Option<FieldKind> {
    match key {
        "background"
        | "backgroundColor"
        | "color"
        | "borderColor"
        | "selectionColor"
        | "borderTopColor"
        | "borderRightColor"
        | "borderBottomColor"
        | "borderLeftColor"
        | "textDecorationColor" => Some(FieldKind::Color),
        "padding" | "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft" | "margin"
        | "marginTop" | "marginRight" | "marginBottom" | "marginLeft" | "gap" | "rowGap"
        | "columnGap" | "top" | "right" | "bottom" | "left" => Some(FieldKind::Spacing),
        "fontSize" => Some(FieldKind::Text),
        "borderRadius"
        | "borderTopLeftRadius"
        | "borderTopRightRadius"
        | "borderBottomLeftRadius"
        | "borderBottomRightRadius" => Some(FieldKind::Radius),
        "width" | "height" | "minWidth" | "minHeight" | "maxWidth" | "maxHeight" | "flexBasis" => {
            Some(FieldKind::Dimension)
        }
        "fontWeight" => Some(FieldKind::FontWeight),
        "boxShadow" => Some(FieldKind::Elevation),
        _ => None,
    }
}

/// Compose `#rrggbb` with an alpha → `#rrggbbaa`. Passes non-hex through.
fn with_alpha(hex: &str, alpha: f64) -> String {
    let digits = hex.strip_prefix('#').unwrap_or(hex);
    if digits.len() != 6 && digits.len() != 8 {
        return hex.to_string();
    }
    let a = (alpha.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{}{:02x}", &digits[..6], a)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Pinned output of svelai's `generateColorPalette` on the canonical
    /// app.css defaults — proves the Rust derivation is byte-exact.
    #[test]
    fn dark_palette_matches_generated() {
        let t = TokenTheme::dark();
        let expect: Vec<(&str, Vec<(&str, &str)>)> = vec![
            (
                "primary",
                vec![
                    ("base", "#5f62ef"),
                    ("dark", "#191ee8"),
                    ("light", "#a5a6f6"),
                    ("lighter", "#d3d4fb"),
                    ("muted", "#181b3b"),
                    ("contrast", "#ffffff"),
                    ("readable", "#98a5ff"),
                    ("muted-readable", "#98a5ff"),
                ],
            ),
            (
                "secondary",
                vec![
                    ("base", "#27272a"),
                    ("dark", "#020202"),
                    ("light", "#4c4c52"),
                    ("lighter", "#64646c"),
                    ("muted", "#1f1f20"),
                    ("contrast", "#ffffff"),
                    ("readable", "#b7b7bb"),
                    ("muted-readable", "#b7b7bb"),
                ],
            ),
            (
                "danger",
                vec![
                    ("base", "#dc2626"),
                    ("dark", "#9c1919"),
                    ("light", "#e76868"),
                    ("lighter", "#ee9494"),
                    ("muted", "#36110e"),
                    ("contrast", "#ffffff"),
                    ("readable", "#ff7466"),
                    ("muted-readable", "#ff7466"),
                ],
            ),
            (
                "success",
                vec![
                    ("base", "#15803d"),
                    ("dark", "#0a3e1e"),
                    ("light", "#20c25c"),
                    ("lighter", "#36de75"),
                    ("muted", "#0f2414"),
                    ("contrast", "#ffffff"),
                    ("readable", "#71d088"),
                    ("muted-readable", "#71d088"),
                ],
            ),
            (
                "warning",
                vec![
                    ("base", "#f59e0b"),
                    ("dark", "#ac6f07"),
                    ("light", "#f8bb55"),
                    ("lighter", "#facf85"),
                    ("muted", "#2e1a01"),
                    ("contrast", "#000000"),
                    ("readable", "#f9a217"),
                    ("muted-readable", "#f9a217"),
                ],
            ),
            (
                "info",
                vec![
                    ("base", "#2563eb"),
                    ("dark", "#1043b3"),
                    ("light", "#6b95f1"),
                    ("lighter", "#9ab7f6"),
                    ("muted", "#0f1e3b"),
                    ("contrast", "#ffffff"),
                    ("readable", "#6ab0ff"),
                    ("muted-readable", "#6ab0ff"),
                ],
            ),
            (
                "neutral",
                vec![
                    ("base", "#fafafa"),
                    ("dark", "#f5f5f5"),
                    ("light", "#ffffff"),
                    ("lighter", "#ffffff"),
                    ("muted", "#1f1f1f"),
                    ("contrast", "#000000"),
                    ("readable", "#b7b7b7"),
                    ("muted-readable", "#b7b7b7"),
                ],
            ),
            (
                "surface",
                vec![
                    ("base", "#111113"),
                    ("recessed", "#09090b"),
                    ("canvas", "#0d0d0f"),
                    ("raised", "#161618"),
                    ("floating", "#27272a"),
                ],
            ),
        ];
        for (name, roles) in &expect {
            for (role, hex) in roles {
                assert_eq!(t.palette[*name][*role].as_str(), *hex, "dark {name}.{role}");
            }
        }
        assert_eq!(t.state_hover_opacity, 0.16);
        assert_eq!(t.state_pressed_opacity, 0.32);
    }

    #[test]
    fn light_palette_matches_generated() {
        let t = TokenTheme::light();
        let expect: Vec<(&str, Vec<(&str, &str)>)> = vec![
            (
                "primary",
                vec![
                    ("base", "#5f62ef"),
                    ("dark", "#191ee8"),
                    ("light", "#a5a6f6"),
                    ("lighter", "#d3d4fb"),
                    ("muted", "#e6eaff"),
                    ("contrast", "#ffffff"),
                    ("readable", "#595ae6"),
                    ("muted-readable", "#4f4dd9"),
                ],
            ),
            (
                "secondary",
                vec![
                    ("base", "#e4e4e7"),
                    ("dark", "#bcbcc3"),
                    ("light", "#ffffff"),
                    ("lighter", "#ffffff"),
                    ("muted", "#ebebec"),
                    ("contrast", "#000000"),
                    ("readable", "#47474a"),
                    ("muted-readable", "#47474a"),
                ],
            ),
            (
                "danger",
                vec![
                    ("base", "#dc2626"),
                    ("dark", "#9c1919"),
                    ("light", "#e76868"),
                    ("lighter", "#ee9494"),
                    ("muted", "#ffe4e0"),
                    ("contrast", "#ffffff"),
                    ("readable", "#d2161c"),
                    ("muted-readable", "#cb0314"),
                ],
            ),
            (
                "success",
                vec![
                    ("base", "#15803d"),
                    ("dark", "#0a3e1e"),
                    ("light", "#20c25c"),
                    ("lighter", "#36de75"),
                    ("muted", "#d9f4dd"),
                    ("contrast", "#ffffff"),
                    ("readable", "#097b38"),
                    ("muted-readable", "#007532"),
                ],
            ),
            (
                "warning",
                vec![
                    ("base", "#f59e0b"),
                    ("dark", "#ac6f07"),
                    ("light", "#f8bb55"),
                    ("lighter", "#facf85"),
                    ("muted", "#ffe7cc"),
                    ("contrast", "#000000"),
                    ("readable", "#ac5a00"),
                    ("muted-readable", "#9f4e00"),
                ],
            ),
            (
                "info",
                vec![
                    ("base", "#2563eb"),
                    ("dark", "#1043b3"),
                    ("light", "#6b95f1"),
                    ("lighter", "#9ab7f6"),
                    ("muted", "#e1ecff"),
                    ("contrast", "#ffffff"),
                    ("readable", "#2664ec"),
                    ("muted-readable", "#1a57de"),
                ],
            ),
            (
                "neutral",
                vec![
                    ("base", "#18181b"),
                    ("dark", "#131316"),
                    ("light", "#242428"),
                    ("lighter", "#3c3c43"),
                    ("muted", "#ebebec"),
                    ("contrast", "#ffffff"),
                    ("readable", "#47474b"),
                    ("muted-readable", "#47474b"),
                ],
            ),
            (
                "surface",
                vec![
                    ("base", "#fafafa"),
                    ("recessed", "#f4f4f4"),
                    ("canvas", "#f7f7f7"),
                    ("raised", "#fdfdfd"),
                    ("floating", "#ffffff"),
                ],
            ),
        ];
        for (name, roles) in &expect {
            for (role, hex) in roles {
                assert_eq!(
                    t.palette[*name][*role].as_str(),
                    *hex,
                    "light {name}.{role}"
                );
            }
        }
        assert_eq!(t.state_hover_opacity, 0.05);
        assert_eq!(t.state_pressed_opacity, 0.1);
    }

    #[test]
    fn scales_match_svelai() {
        let t = TokenTheme::dark();
        // geometry: control 28/32/36, row 32/40/48, icon 12..24, hit 28/32/36, indent 24..48
        assert_eq!(t.control["md"], 32.0);
        assert_eq!(t.row["lg"], 48.0);
        assert_eq!(t.icon["xs"], 12.0);
        assert_eq!(t.icon["xl"], 24.0);
        assert_eq!(t.hit["sm"], 28.0);
        assert_eq!(t.indent["xl"], 48.0);
        // radius: xs..4xl = 2/4/8/12/16/20/24/32
        assert_eq!(t.radius["xs"], 2.0);
        assert_eq!(t.radius["3xl"], 24.0);
        assert_eq!(t.radius["4xl"], 32.0);
        // fluid type at maxViewport (1440): base 18, ramp ×1.25, xs floored 12
        assert_eq!(t.text["xs"], 12.0);
        assert!((t.text["sm"] - 14.4).abs() < 0.01);
        assert_eq!(t.text["base"], 18.0);
        assert!((t.text["lg"] - 22.5).abs() < 0.01);
        assert!((t.text["9xl"] - 18.0 * 1.25f64.powf(10.0)).abs() < 0.01);
    }

    #[test]
    fn spacing_factor_rescales_geometry() {
        let t = TokenTheme::dark()
            .with_override(&json!({ "spacing": "small" }))
            .unwrap();
        assert!((t.spacing_unit - 3.2).abs() < 0.001);
        assert!((t.control["md"] - 25.6).abs() < 0.001);
        assert!((t.spacing["md"] - 6.4).abs() < 0.001);
    }

    #[test]
    fn custom_color_derives_roles() {
        let t = TokenTheme::dark()
            .with_override(&json!({
                "colors": { "brand": "#ff5500" }
            }))
            .unwrap();
        // Every role exists — derived like svelai would.
        for role in [
            "base",
            "dark",
            "light",
            "lighter",
            "muted",
            "contrast",
            "readable",
            "muted-readable",
        ] {
            assert!(t.palette["brand"].contains_key(role), "brand.{role}");
        }
        assert_eq!(t.palette["brand"]["base"], "#ff5500");
    }

    #[test]
    fn color_refs_match_svelai() {
        let t = TokenTheme::dark();
        assert_eq!(t.resolve_color("primary", None).as_deref(), Some("#5f62ef"));
        assert_eq!(
            t.resolve_color("primary-muted", None).as_deref(),
            Some("#181b3b")
        );
        assert_eq!(
            t.resolve_color("primary-muted-readable", None).as_deref(),
            Some("#98a5ff")
        );
        assert_eq!(
            t.resolve_color("surface-raised", None).as_deref(),
            Some("#161618")
        );
        assert_eq!(
            t.resolve_color("transparent", None).as_deref(),
            Some("transparent")
        );
        assert_eq!(
            t.resolve_color("color", Some("danger")).as_deref(),
            Some("#dc2626")
        );
        assert_eq!(
            t.resolve_color("color-contrast", Some("danger")).as_deref(),
            Some("#ffffff")
        );
        assert_eq!(t.resolve_color("color", None).as_deref(), Some("#fafafa"));
        assert_eq!(
            t.resolve_color("elevation-tint-3", None).as_deref(),
            Some("#ffffff12")
        );
    }

    #[test]
    fn alpha_suffix() {
        let t = TokenTheme::dark();
        assert_eq!(
            t.resolve_color("primary/50", None).as_deref(),
            Some("#5f62ef80")
        );
        assert_eq!(
            t.resolve_color("primary/0", None).as_deref(),
            Some("transparent")
        );
        assert_eq!(
            t.resolve_color("primary/0.5", None).as_deref(),
            Some("#5f62ef80")
        );
        // Bad alpha → unresolved (JS parity).
        assert_eq!(t.resolve_color("primary/foo", None), None);
        assert_eq!(t.resolve_color("primary/", None), None);
    }

    #[test]
    fn literals_pass_through() {
        let t = TokenTheme::dark();
        assert_eq!(t.resolve_color("#fff", None), None);
        assert_eq!(t.resolve_color("rgb(1,2,3)", None), None);
        assert_eq!(t.resolve_color("rebeccapurple", None), None);
    }

    #[test]
    fn style_resolution_per_field_kind() {
        let t = TokenTheme::dark();
        let mut style = json!({
            "backgroundColor": "color-muted",
            "color": "color-readable",
            "paddingLeft": "md",
            "marginTop": 4,              // JSON number = px → 4
            "marginBottom": "4",         // string numeric = spacing units → 16
            "fontSize": "sm",
            "fontWeight": "semibold",
            "borderRadius": "full",
            "height": "control-md",
            "width": "full",
            "boxShadow": "raised-md",
            "hover": { "backgroundColor": "color/8" },
            "stateLayer": true,
            "bogusColor": "notatoken"    // unknown key — untouched
        });
        let outcome = t.resolve_style(&mut style, Some("primary"));
        assert_eq!(style["backgroundColor"], "#181b3b");
        assert_eq!(style["color"], "#98a5ff");
        assert_eq!(style["paddingLeft"], 8.0);
        assert_eq!(style["marginTop"], 4.0);
        assert_eq!(style["marginBottom"], 16.0);
        assert_eq!(style["fontSize"], 14.4);
        assert_eq!(style["fontWeight"], 600.0);
        assert_eq!(style["borderRadius"], 9999.0);
        assert_eq!(style["height"], 32.0);
        assert_eq!(style["width"], "100%");
        // `boxShadow: "raised-md"` resolves the bare elevation stack — the
        // tonal tint member is added by the `raised-*` utility, not the var.
        assert_eq!(style["boxShadow"][0]["blurRadius"], 6.0);
        assert_eq!(style["hover"]["backgroundColor"], "#5f62ef14");
        assert!(outcome.state_layer);
        assert!(style.get("stateLayer").is_none());
        assert_eq!(style["bogusColor"], "notatoken");
    }

    #[test]
    fn unresolvable_tokens_are_dropped_not_poisoned() {
        let t = TokenTheme::dark();
        let mut style = json!({
            "paddingLeft": "bogus",
            "backgroundColor": "notacolor",
            "color": "#fff"
        });
        let outcome = t.resolve_style(&mut style, None);
        assert!(style.get("paddingLeft").is_none());
        assert!(style.get("backgroundColor").is_none());
        assert_eq!(style["color"], "#fff");
        assert!(outcome.dropped.contains(&"paddingLeft".to_string()));
        assert!(outcome.dropped.contains(&"backgroundColor".to_string()));
    }

    #[test]
    fn theme_override_scopes() {
        let t = TokenTheme::dark()
            .with_override(&json!({
                "defaultColor": "primary",
                "colors": { "brand": { "base": "#123456", "muted": "#0a1a2a" } },
                "radius": "large"
            }))
            .unwrap();
        assert_eq!(t.resolve_color("color", None).as_deref(), Some("#5f62ef"));
        assert_eq!(
            t.resolve_color("brand-muted", None).as_deref(),
            Some("#0a1a2a")
        );
        // role-less base override still resolves (falls back to base)
        assert_eq!(t.radius["md"], 12.0);
        let light = t.with_override(&json!({ "mode": "light" })).unwrap();
        assert_eq!(
            light.resolve_color("primary", None).as_deref(),
            Some("#5f62ef")
        );
        assert_eq!(
            light.resolve_color("surface", None).as_deref(),
            Some("#fafafa")
        );
    }

    /// svelai `raised-*`: the shadow LIST — authored insets, then the tonal
    /// tint as an `inset 0 0 0 9999px` member, then the full elevation stack.
    /// `lift-*` is the same list without the border; `none` clears
    /// `--tw-shadow` and the border; an invalid level emits nothing.
    #[test]
    fn raised_and_lift_expand_like_svelai() {
        let dark = TokenTheme::dark();
        let mut v = json!({ "raised": "md", "backgroundColor": "surface-raised" });
        dark.resolve_style(&mut v, None);
        // level 3 stack [(4,6,.08),(2,4,.06)] ×1.8 dark strength, tint .07.
        assert_eq!(
            v["boxShadow"],
            json!([
                { "offsetX": 0, "offsetY": 0, "blurRadius": 0, "spreadRadius": 9999, "inset": true, "color": "#ffffff12" },
                { "offsetX": 0, "offsetY": 4.0, "blurRadius": 6.0, "spreadRadius": 0, "color": "#00000025" },
                { "offsetX": 0, "offsetY": 2.0, "blurRadius": 4.0, "spreadRadius": 0, "color": "#0000001c" },
            ])
        );
        assert_eq!(v["borderWidth"], json!(1));
        assert_eq!(v["borderColor"], json!("#1f1f1f"));
        // The tint no longer touches the background — gradients survive.
        assert_eq!(v["backgroundColor"], json!("#161618"));
        assert!(v.get("raised").is_none());

        // An authored non-inset shadow is replaced (both write --tw-shadow);
        // authored insets (rings) compose ahead of the tint.
        let mut merged = json!({
            "raised": "sm",
            "boxShadow": [
                { "offsetX": 0, "offsetY": 0, "blurRadius": 0, "spreadRadius": 2, "inset": true, "color": "#ff0000" },
                { "offsetX": 0, "offsetY": 9, "blurRadius": 9, "spreadRadius": 0, "color": "#00ff00" }
            ]
        });
        dark.resolve_style(&mut merged, None);
        let list = merged["boxShadow"].as_array().unwrap();
        assert_eq!(list.len(), 4); // ring + tint + 2 stack members
        assert_eq!(list[0]["color"], json!("#ff0000"));

        // `raised-none` clears the authored non-inset shadow + the border.
        let mut clear = json!({
            "raised": "none",
            "borderWidth": 4,
            "boxShadow": { "offsetX": 0, "offsetY": 2, "blurRadius": 4, "spreadRadius": 0, "color": "#000000ff" }
        });
        dark.resolve_style(&mut clear, None);
        assert_eq!(clear["boxShadow"], json!([]));
        assert_eq!(clear["borderWidth"], json!(0));

        // Invalid level → the utility does not exist → no output at all.
        let mut bogus = json!({ "raised": "bogus", "borderWidth": 4, "boxShadow": { "offsetX": 0, "offsetY": 2, "blurRadius": 4, "spreadRadius": 0, "color": "#000000ff" } });
        dark.resolve_style(&mut bogus, None);
        assert_eq!(bogus["borderWidth"], json!(4));
        assert_eq!(bogus["boxShadow"]["offsetY"], json!(2));

        // `??=` — authored border fields survive a valid raised.
        let mut authored = json!({ "raised": "md", "borderWidth": 3, "borderColor": "#123456" });
        dark.resolve_style(&mut authored, None);
        assert_eq!(authored["borderWidth"], json!(3));
        assert_eq!(authored["borderColor"], json!("#123456"));

        let mut lift = json!({ "lift": "2" });
        dark.resolve_style(&mut lift, None);
        assert!(lift.get("borderWidth").is_none());
        assert_eq!(lift["boxShadow"][1]["blurRadius"], json!(3.0));

        // raisedWithBorder:false → `--raised-border: 0 solid transparent` —
        // the declaration still exists, zero-width. Light mode drops the tint.
        let no_border = dark
            .with_override(&json!({ "raisedWithBorder": false }))
            .unwrap();
        let mut v2 = json!({ "raised": "md" });
        no_border.resolve_style(&mut v2, None);
        assert_eq!(v2["borderWidth"], json!(0));
        let light = TokenTheme::light();
        let mut v3 = json!({ "raised": "md", "backgroundColor": "surface" });
        light.resolve_style(&mut v3, None);
        assert_eq!(v3["backgroundColor"], json!("#fafafa")); // no tint in light
                                                             // Light mode: tint is transparent → no inset member in the list.
        assert_eq!(
            v3["boxShadow"].as_array().unwrap()[0]["offsetY"],
            json!(4.0)
        );
        assert_eq!(v3["borderColor"], json!("#ebebec"));
    }
}
