//! CSS `transform` / `transform-origin` support.
//!
//! The property is element-level, not style-level: it moves where a subtree
//! paints without touching layout. Parsing happens once per style push; the
//! function list resolves to a `TransformationMatrix` against the element's
//! painted bounds each frame (percentages are relative to the element's own
//! box, and `transform-origin` defaults to its center).
//!
//! Application goes through `window.with_element_transformation`, so quads,
//! text, images, hitboxes and content masks all follow the same matrix — the
//! behavior CSS gives a browser transform.

use gpui::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId,
    IntoElement, LayoutId, Pixels, TransformationMatrix, Window, px, point, radians, size,
};

/// A CSS `<length>` or `<percentage>` — percentages resolve against the
/// element's own size along the relevant axis at paint time.
#[derive(Debug, Clone, Copy, PartialEq)]
enum CssLength {
    Px(f32),
    Fraction(f32),
}

impl CssLength {
    fn resolve(self, extent: Pixels) -> Pixels {
        match self {
            CssLength::Px(v) => px(v),
            CssLength::Fraction(f) => extent * f,
        }
    }
}

/// One function in a `transform` list, before origin resolution.
#[derive(Debug, Clone, Copy, PartialEq)]
enum TransformFn {
    Translate { x: CssLength, y: CssLength },
    Scale { x: f32, y: f32 },
    Rotate { radians: f32 },
    Skew { x: f32, y: f32 },
    /// CSS `matrix(a, b, c, d, tx, ty)` — column-vector convention
    /// `x' = a·x + c·y + tx`, `y' = b·x + d·y + ty`.
    Matrix { a: f32, b: f32, c: f32, d: f32, tx: f32, ty: f32 },
}

impl TransformFn {
    fn matrix(self, bounds: Bounds<Pixels>) -> TransformationMatrix {
        match self {
            TransformFn::Translate { x, y } => {
                TransformationMatrix::unit().translate_pixels(point(
                    x.resolve(bounds.size.width),
                    y.resolve(bounds.size.height),
                ))
            }
            TransformFn::Scale { x, y } => TransformationMatrix::unit().scale(size(x, y)),
            TransformFn::Rotate { radians: angle } => {
                TransformationMatrix::unit().rotate(radians(angle))
            }
            TransformFn::Skew { x, y } => TransformationMatrix {
                rotation_scale: [[1.0, x.tan()], [y.tan(), 1.0]],
                translation: [0.0, 0.0],
            },
            TransformFn::Matrix { a, b, c, d, tx, ty } => TransformationMatrix {
                rotation_scale: [[a, c], [b, d]],
                translation: [tx, ty],
            },
        }
    }
}

/// A parsed `transform` declaration plus its origin. `none` parses to `None`.
#[derive(Debug, Clone, PartialEq)]
pub struct Transform {
    fns: Vec<TransformFn>,
    origin: [CssLength; 2],
}

impl Transform {
    /// Parse the `transform`/`transformOrigin` pair. An unparseable or `none`
    /// transform yields `None` — matching CSS, which drops the whole
    /// declaration rather than applying a prefix of the function list.
    pub fn parse(transform: &str, origin: Option<&str>) -> Option<Transform> {
        let transform = transform.trim();
        if transform.is_empty() || transform == "none" {
            return None;
        }
        let mut fns = Vec::new();
        let mut rest = transform;
        while !rest.is_empty() {
            let open = rest.find('(')?;
            let close = rest.find(')')?;
            let name = rest[..open].trim();
            let args = &rest[open + 1..close];
            fns.push(parse_fn(name, args)?);
            rest = rest[close + 1..].trim_start();
        }
        let origin = parse_origin(origin.unwrap_or("50% 50%"))?;
        Some(Transform { fns, origin })
    }

    /// Resolve the function list and origin against painted bounds into the
    /// matrix the window transformation stack expects. `transform: translate`
    /// alone produces a pure offset — everything else composes around the
    /// resolved origin point (default: the element's center).
    pub fn matrix(&self, bounds: Bounds<Pixels>) -> TransformationMatrix {
        let origin = point(
            bounds.origin.x + self.origin[0].resolve(bounds.size.width),
            bounds.origin.y + self.origin[1].resolve(bounds.size.height),
        );
        // CSS applies functions left-to-right: `translate() scale()` is the
        // matrix product T·S — the rightmost function reaches points first.
        let mut m = TransformationMatrix::unit();
        for f in &self.fns {
            m = m.compose(f.matrix(bounds));
        }
        // transform-origin: T(origin)·M·T(-origin)
        TransformationMatrix::unit()
            .translate_pixels(origin)
            .compose(m)
            .translate_pixels(point(-origin.x, -origin.y))
    }
}

/// Parse one `name(args)` function. Percentages and px are the only units the
/// 2D subset needs; anything else (3D functions, calc, missing args) fails
/// the whole declaration, matching CSS's all-or-nothing parse.
fn parse_fn(name: &str, args: &str) -> Option<TransformFn> {
    let parts: Vec<&str> = args.split(',').map(str::trim).collect();
    match name {
        "translate" => Some(TransformFn::Translate {
            x: length(parts.first()?)?,
            y: parts.get(1).and_then(|s| length(s)).unwrap_or(CssLength::Px(0.0)),
        }),
        "translateX" => Some(TransformFn::Translate {
            x: length(parts.first()?)?,
            y: CssLength::Px(0.0),
        }),
        "translateY" => Some(TransformFn::Translate {
            x: CssLength::Px(0.0),
            y: length(parts.first()?)?,
        }),
        // A 2D canvas can't draw z, but translate3d(x, y, 0) is common
        // emitted code — accept it when z resolves to zero.
        "translate3d" if length(parts.get(2)?) == Some(CssLength::Px(0.0)) => {
            Some(TransformFn::Translate {
                x: length(parts.first()?)?,
                y: length(parts.get(1)?)?,
            })
        }
        "scale" => {
            let x = number(parts.first()?)?;
            let y = parts.get(1).and_then(|s| number(s)).unwrap_or(x);
            Some(TransformFn::Scale { x, y })
        }
        "scaleX" => Some(TransformFn::Scale {
            x: number(parts.first()?)?,
            y: 1.0,
        }),
        "scaleY" => Some(TransformFn::Scale {
            x: 1.0,
            y: number(parts.first()?)?,
        }),
        "rotate" => Some(TransformFn::Rotate {
            radians: angle(parts.first()?)?,
        }),
        "skew" => Some(TransformFn::Skew {
            x: angle(parts.first()?)?,
            y: parts.get(1).and_then(|s| angle(s)).unwrap_or(0.0),
        }),
        "skewX" => Some(TransformFn::Skew {
            x: angle(parts.first()?)?,
            y: 0.0,
        }),
        "skewY" => Some(TransformFn::Skew {
            x: 0.0,
            y: angle(parts.first()?)?,
        }),
        "matrix" if parts.len() == 6 => Some(TransformFn::Matrix {
            a: number(parts[0])?,
            b: number(parts[1])?,
            c: number(parts[2])?,
            d: number(parts[3])?,
            tx: number(parts[4])?,
            ty: number(parts[5])?,
        }),
        _ => None,
    }
}

/// `transform-origin`: two axis values in either order — `top left` and
/// `left top` both mean the same corner. Bare lengths resolve against the
/// element's own size.
fn parse_origin(value: &str) -> Option<[CssLength; 2]> {
    let mut x = CssLength::Fraction(0.5);
    let mut y = CssLength::Fraction(0.5);
    for part in value.split_whitespace() {
        match part {
            "left" => x = CssLength::Fraction(0.0),
            "right" => x = CssLength::Fraction(1.0),
            "top" => y = CssLength::Fraction(0.0),
            "bottom" => y = CssLength::Fraction(1.0),
            "center" => {}
            other => {
                let length = length(other)?;
                // First axis value wins x, second wins y (CSS order).
                if x == CssLength::Fraction(0.5) {
                    x = length;
                } else {
                    y = length;
                }
            }
        }
    }
    Some([x, y])
}

fn length(value: &str) -> Option<CssLength> {
    let value = value.trim();
    if let Some(px) = value.strip_suffix("px") {
        return px.parse().ok().map(CssLength::Px);
    }
    if let Some(pct) = value.strip_suffix('%') {
        return pct.parse::<f32>().ok().map(|v| CssLength::Fraction(v / 100.0));
    }
    // `0` is the only unitless length CSS allows.
    if value == "0" {
        return Some(CssLength::Px(0.0));
    }
    None
}

fn number(value: &str) -> Option<f32> {
    value.trim().parse().ok()
}

/// deg / rad / grad / turn → radians.
fn angle(value: &str) -> Option<f32> {
    let value = value.trim();
    if let Some(deg) = value.strip_suffix("deg") {
        return deg.parse::<f32>().ok().map(f32::to_radians);
    }
    if let Some(rad) = value.strip_suffix("rad") {
        return rad.parse().ok();
    }
    if let Some(grad) = value.strip_suffix("grad") {
        return grad.parse::<f32>().ok().map(|g| g * std::f32::consts::PI / 200.0);
    }
    if let Some(turn) = value.strip_suffix("turn") {
        return turn.parse::<f32>().ok().map(|t| t * std::f32::consts::TAU);
    }
    // Unitless angles are invalid in CSS, but `rotate(0)` shows up in emitted
    // transitions — accept exactly zero.
    if value == "0" {
        return Some(0.0);
    }
    None
}

/// Wraps a child element and paints its subtree under a transformation.
/// Layout is untouched — the transform only moves where pixels and hits land.
pub struct Transformed {
    child: AnyElement,
    transform: Transform,
}

impl Transformed {
    pub fn new(child: AnyElement, transform: Transform) -> Self {
        Self { child, transform }
    }
}

impl IntoElement for Transformed {
    type Element = Self;
    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for Transformed {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        (self.child.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let matrix = self.transform.matrix(bounds);
        window.with_element_transformation(matrix, |window| {
            self.child.prepaint(window, cx);
        });
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let matrix = self.transform.matrix(bounds);
        window.with_element_transformation(matrix, |window| {
            self.child.paint(window, cx);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn translate_of(m: &TransformationMatrix) -> [f32; 2] {
        m.translation
    }

    #[test]
    fn parses_translate_px() {
        let t = Transform::parse("translate(10px, 20px)", None).unwrap();
        let m = t.matrix(Bounds {
            origin: point(px(100.0), px(50.0)),
            size: size(px(200.0), px(40.0)),
        });
        // translate about the center origin: T(o)·T(10,20)·T(-o) = T(10,20)
        assert_eq!(translate_of(&m), [10.0, 20.0]);
    }

    #[test]
    fn parses_translate_percent_of_self() {
        let t = Transform::parse("translateX(50%)", None).unwrap();
        let m = t.matrix(Bounds {
            origin: point(px(0.0), px(0.0)),
            size: size(px(200.0), px(40.0)),
        });
        assert_eq!(translate_of(&m), [100.0, 0.0]);
    }

    #[test]
    fn scale_defaults_to_center_origin() {
        let t = Transform::parse("scale(0.5)", None).unwrap();
        let bounds = Bounds {
            origin: point(px(100.0), px(50.0)),
            size: size(px(200.0), px(40.0)),
        };
        let m = t.matrix(bounds);
        // Center (200, 70) stays fixed under a centered 0.5 scale:
        // p' = (p - o)·0.5 + o → translation = o·0.5 = (100, 35)
        assert_eq!(m.rotation_scale, [[0.5, 0.0], [0.0, 0.5]]);
        assert_eq!(translate_of(&m), [100.0, 35.0]);
    }

    #[test]
    fn scale_about_top_left_origin() {
        let t = Transform::parse("scale(0.5)", Some("top left")).unwrap();
        let m = t.matrix(Bounds {
            origin: point(px(100.0), px(50.0)),
            size: size(px(200.0), px(40.0)),
        });
        // p' = (p - o)·0.5 + o where o = top-left (100, 50)
        assert_eq!(translate_of(&m), [50.0, 25.0]);
    }

    #[test]
    fn functions_compose_left_to_right() {
        // `translate(10px) scale(2)` = T·S — the scale is applied to points
        // first, so the 10px shift is NOT doubled.
        let t = Transform::parse("translate(10px, 0px) scale(2)", Some("0 0")).unwrap();
        let m = t.matrix(Bounds {
            origin: point(px(0.0), px(0.0)),
            size: size(px(10.0), px(10.0)),
        });
        assert_eq!(m.rotation_scale, [[2.0, 0.0], [0.0, 2.0]]);
        assert_eq!(translate_of(&m), [10.0, 0.0]);
    }

    #[test]
    fn matrix_function_maps_columns() {
        let t = Transform::parse("matrix(1, 0, 0, 1, 30, 40)", None).unwrap();
        let m = t.matrix(Bounds {
            origin: point(px(0.0), px(0.0)),
            size: size(px(10.0), px(10.0)),
        });
        let p = m.apply(point(px(1.0), px(1.0)));
        assert_eq!((f32::from(p.x), f32::from(p.y)), (31.0, 41.0));
    }

    #[test]
    fn rotate_unitless_zero_and_deg() {
        assert!(Transform::parse("rotate(0)", None).is_some());
        let t = Transform::parse("rotate(90deg)", Some("0 0")).unwrap();
        let m = t.matrix(Bounds {
            origin: point(px(0.0), px(0.0)),
            size: size(px(10.0), px(10.0)),
        });
        let p = m.apply(point(px(10.0), px(0.0)));
        assert!(f32::from(p.x).abs() < 1e-4 && (f32::from(p.y) - 10.0).abs() < 1e-4);
    }

    #[test]
    fn none_and_garbage_reject() {
        assert!(Transform::parse("none", None).is_none());
        assert!(Transform::parse("", None).is_none());
        assert!(Transform::parse("translate(10px", None).is_none());
        assert!(Transform::parse("spin(45deg)", None).is_none());
        // 3D-only functions can't be honored — dropped, not approximated.
        assert!(Transform::parse("rotateX(45deg)", None).is_none());
        assert!(Transform::parse("translate3d(1px, 2px, 3px)", None).is_none());
        assert!(Transform::parse("translate3d(1px, 2px, 0)", None).is_some());
    }

    #[test]
    fn skew_builds_shear_matrix() {
        let t = Transform::parse("skewX(45deg)", Some("0 0")).unwrap();
        let m = t.matrix(Bounds {
            origin: point(px(0.0), px(0.0)),
            size: size(px(10.0), px(10.0)),
        });
        // skewX(45°): x' = x + y·tan(45°) = x + y
        let p = m.apply(point(px(0.0), px(10.0)));
        assert!((f32::from(p.x) - 10.0).abs() < 1e-4);
    }
}
