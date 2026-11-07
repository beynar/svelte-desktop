//! The native stylesheet engine — the Rust half of the `<style>` pipeline.
//!
//! JS ships parsed rules once (`stylesheet.register`) and class tokens per
//! element (`setClass`); matching, cascade and pseudo-bucket routing run here
//! so a state flip never needs a JS round-trip. Rules resolve to the same
//! symbolic field map the other style layers speak (`setStyle` descs, recipes,
//! StyleProps), then merge UNDER the inline `style` attribute — inline always
//! wins, which is CSS semantics.
//!
//! Decl strings (`"color:#fff;padding:4px"`) parse through [`parse_decls`], a
//! port of gdom.ts's `styleObject`: CSS shorthands expand, values coerce to
//! the shapes `StyleDesc` fields expect, and anything the native model cannot
//! paint drops rather than poisoning the whole rule.

use serde_json::{Map, Value};

/// Pseudo states a `state` selector component can route into. Wire names are
/// the `StyleDesc` bucket keys verbatim, so `field_name` is the merge target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PseudoState {
    Hover,
    Active,
    Focus,
    FocusWithin,
    FocusVisible,
}

impl PseudoState {
    fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "hover" => Self::Hover,
            "active" => Self::Active,
            "focus" => Self::Focus,
            "focusWithin" => Self::FocusWithin,
            "focusVisible" => Self::FocusVisible,
            _ => return None,
        })
    }

    pub fn field_name(self) -> &'static str {
        match self {
            Self::Hover => "hover",
            Self::Active => "active",
            Self::Focus => "focus",
            Self::FocusWithin => "focusWithin",
            Self::FocusVisible => "focusVisible",
        }
    }
}

/// One selector component from the wire. `comb` separates two compounds —
/// matching walks right-to-left over the retained tree. `attr` tests a
/// custom prop by its native name (`class` is the one exception: it reads
/// the element's class list). `not` wraps one combinator-free compound.
#[derive(Debug, Clone, PartialEq)]
pub enum SelectorComp {
    Tag(String),
    Class(String),
    Id(String),
    Universal,
    State(PseudoState),
    Comb(Combinator),
    Attr {
        name: Box<str>,
        op: Option<AttrOp>,
        value: Option<Value>,
    },
    Not(Vec<SelectorComp>),
}

/// The four CSS combinators, in wire spelling order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Combinator {
    Descendant,
    Child,
    NextSibling,
    LaterSibling,
}

/// `[attr op value]` operators — wire letters match the CSS spellings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttrOp {
    Equal,
    Includes,
    DashMatch,
    Prefix,
    Suffix,
    Substring,
}

/// A registered rule: selector pre-split into compounds (rightmost is the
/// subject), decls pre-parsed into the symbolic field map, and its cascade
/// position.
///
/// Decls parse once at register, not once per element: a malformed value
/// drops when the rule lands instead of taxing every element it matches.
pub struct Rule {
    /// Compounds left-to-right. The last must match the element itself;
    /// earlier ones match ancestors or preceding siblings per `combs`.
    compounds: Vec<Vec<SelectorComp>>,
    /// `combs[i]` relates `compounds[i]` to `compounds[i+1]`.
    combs: Vec<Combinator>,
    fields: Map<String, Value>,
    specificity: [u32; 3],
    order: u64,
    /// The pseudo bucket this rule's decls route into. Extracted from the
    /// selector at register — `state` comps are routing, not predicates.
    state: Option<PseudoState>,
}

/// The rule shape the wire carries: `{sel, decls, spec, order}`.
/// `spec` is `[a,b,c]` specificity, `order` the source position; both are
/// emitted by JS so this side never re-derives them.
#[derive(serde::Deserialize)]
pub(crate) struct RuleWire {
    #[serde(default)]
    sel: Vec<SelCompWire>,
    #[serde(default)]
    decls: String,
    #[serde(default)]
    spec: Vec<f64>,
    #[serde(default)]
    order: f64,
}

#[derive(serde::Deserialize)]
pub(crate) struct SelCompWire {
    k: String,
    #[serde(default)]
    v: Option<String>,
    /// `[attr op …]` operator letter, `:`-separated ops stay on `v`.
    #[serde(default)]
    op: Option<String>,
    /// `[attr = x]` value — already coerced to the prop's JSON shape by JS.
    #[serde(default)]
    x: Option<Value>,
    /// `not` args — one compound's worth of comps (no comb/state/not).
    #[serde(default)]
    sel: Option<Vec<SelCompWire>>,
}

/// Wire comp → `SelectorComp`, or `None` when the kind/args can't be
/// honored. `in_not` narrows the surface to a plain compound — `:not()`
/// args can't carry combinators, states, or another `:not()`.
fn parse_comp(comp: &SelCompWire, in_not: bool) -> Option<SelectorComp> {
    match comp.k.as_str() {
        "tag" => comp.v.clone().map(SelectorComp::Tag),
        "class" => comp.v.clone().map(SelectorComp::Class),
        "id" => comp.v.clone().map(SelectorComp::Id),
        "universal" => Some(SelectorComp::Universal),
        "state" if !in_not => comp
            .v
            .as_deref()
            .and_then(PseudoState::from_name)
            .map(SelectorComp::State),
        "comb" if !in_not => Some(SelectorComp::Comb(match comp.v.as_deref()? {
            " " => Combinator::Descendant,
            ">" => Combinator::Child,
            "+" => Combinator::NextSibling,
            "~" => Combinator::LaterSibling,
            _ => return None,
        })),
        "attr" => comp.v.clone().map(|name| SelectorComp::Attr {
            name: name.into(),
            op: comp.op.as_deref().and_then(|op| {
                Some(match op {
                    "=" => AttrOp::Equal,
                    "~=" => AttrOp::Includes,
                    "|=" => AttrOp::DashMatch,
                    "^=" => AttrOp::Prefix,
                    "$=" => AttrOp::Suffix,
                    "*=" => AttrOp::Substring,
                    _ => return None,
                })
            }),
            value: comp.x.clone(),
        }),
        "not" if !in_not => {
            let inners = comp.sel.as_ref()?;
            let mut inner = Vec::with_capacity(inners.len());
            for ic in inners {
                inner.push(parse_comp(ic, true)?);
            }
            if inner.is_empty() {
                return None;
            }
            Some(SelectorComp::Not(inner))
        }
        _ => None,
    }
}

/// The prop string an attr op compares against. `class` reads the token
/// list joined (the attr value CSS would have compared); everything else
/// reads `custom_props` — a `null` there is a removed prop, i.e. absent.
fn attr_operand(
    element: &crate::retained_tree::RetainedElement,
    name: &str,
) -> Option<Value> {
    if name == "class" {
        if element.classes.is_empty() {
            None
        } else {
            Some(Value::String(element.classes.join(" ")))
        }
    } else {
        element
            .custom_props
            .get(name)
            .filter(|v| !v.is_null())
            .cloned()
    }
}

/// A prop value in the shape a `[attr op str]` test expects — strings pass
/// through, numbers/bools take their JSON text (0 → "0", true → "true").
fn prop_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn attr_matches(
    element: &crate::retained_tree::RetainedElement,
    name: &str,
    op: Option<AttrOp>,
    value: &Option<Value>,
) -> bool {
    let Some(raw) = attr_operand(element, name) else {
        return false;
    };
    let Some(op) = op else {
        return true; // `[attr]` — presence only
    };
    let expected = value.as_ref().map(prop_string).unwrap_or_default();
    if op == AttrOp::Equal {
        // `x` arrives coerced (tabindex="0" → 0); compare JSON first, then
        // the string form so `[aria-hidden="true"]` also hits a bool prop.
        return value.as_ref().is_some_and(|v| *v == raw) || prop_string(&raw) == expected;
    }
    let actual = prop_string(&raw);
    match op {
        AttrOp::Includes => actual.split_ascii_whitespace().any(|tok| tok == expected),
        AttrOp::DashMatch => actual == expected || actual.starts_with(&format!("{expected}-")),
        AttrOp::Prefix => actual.starts_with(&expected),
        AttrOp::Suffix => actual.ends_with(&expected),
        AttrOp::Substring => !expected.is_empty() && actual.contains(&expected),
        AttrOp::Equal => unreachable!(),
    }
}

/// Every comp in a compound must hold for the same element. `state` comps
/// always pass — register already routed their decls into the bucket.
/// `Comb` never appears inside a compound (validated at `from_wire`).
fn compound_matches(comps: &[SelectorComp], element: &crate::retained_tree::RetainedElement) -> bool {
    comps.iter().all(|comp| match comp {
        SelectorComp::Tag(tag) => tag.eq_ignore_ascii_case(&element.element_type),
        SelectorComp::Class(name) => element.classes.iter().any(|token| token == name),
        SelectorComp::Id(id) => {
            element
                .custom_props
                .get("id")
                .and_then(Value::as_str)
                == Some(id.as_str())
        }
        SelectorComp::Universal | SelectorComp::State(_) => true,
        SelectorComp::Comb(_) => false,
        SelectorComp::Attr { name, op, value } => attr_matches(element, name, *op, value),
        SelectorComp::Not(inner) => !compound_matches(inner, element),
    })
}

/// The element before `id` in its parent's child list, if any.
fn prev_sibling(tree: &crate::retained_tree::RetainedTree, id: u64) -> Option<u64> {
    let element = tree.elements.get(&id)?;
    let parent = tree.elements.get(&element.parent?)?;
    let index = parent.children.iter().position(|c| *c == id)?;
    index.checked_sub(1).map(|i| parent.children[i])
}

impl Rule {
    /// `sel` comps → compounds + combinators. Returns `None` for rules this
    /// engine cannot honor — unknown comp kinds, a `state` comp without a
    /// known state, more than one `state` comp, a `state` comp outside the
    /// subject compound (its decls can't route into an ancestor's bucket),
    /// or malformed combinator placement. CSS drops unsupported selectors
    /// the same way: the rule never applies, the sheet around it still does.
    pub(crate) fn from_wire(wire: RuleWire) -> Option<Self> {
        let mut compounds: Vec<Vec<SelectorComp>> = vec![Vec::new()];
        let mut combs: Vec<Combinator> = Vec::new();
        let mut state = None;
        for comp in &wire.sel {
            let Some(parsed) = parse_comp(comp, false) else {
                log::debug!(
                    "stylesheet rule skipped: unsupported selector comp {:?}",
                    comp.k
                );
                return None;
            };
            if let SelectorComp::Comb(kind) = parsed {
                if compounds.last().is_some_and(|c| c.is_empty()) {
                    log::debug!("stylesheet rule skipped: misplaced combinator");
                    return None;
                }
                combs.push(kind);
                compounds.push(Vec::new());
                continue;
            }
            if let SelectorComp::State(found) = parsed {
                if state.replace(found).is_some() {
                    log::debug!("stylesheet rule skipped: multiple state comps");
                    return None;
                }
            }
            compounds.last_mut().unwrap().push(parsed);
        }
        if compounds.last().is_some_and(|c| c.is_empty()) {
            log::debug!("stylesheet rule skipped: trailing combinator");
            return None;
        }
        // A state comp before the last combinator would route this element's
        // decls into a bucket gated on an ANCESTOR's state — unsupported.
        for compound in &compounds[..compounds.len().saturating_sub(1)] {
            if compound.iter().any(|c| matches!(c, SelectorComp::State(_))) {
                log::debug!("stylesheet rule skipped: state comp outside subject compound");
                return None;
            }
        }
        let mut specificity = [0u32; 3];
        for (slot, value) in specificity.iter_mut().zip(wire.spec.iter()) {
            *slot = *value as u32;
        }
        Some(Rule {
            compounds,
            combs,
            fields: parse_decls(&wire.decls),
            specificity,
            order: wire.order as u64,
            state,
        })
    }

    /// Right-to-left match with backtracking: the subject compound must
    /// hold on `id`, then each combinator picks the candidates to its left
    /// (parent / previous siblings / ancestors) and recursion retries the
    /// remaining compounds against each — greedy nearest-pick alone would
    /// miss `.a .b .c` when the nearer `.b` has no `.a` ancestor.
    fn matches(&self, tree: &crate::retained_tree::RetainedTree, id: u64) -> bool {
        self.matches_compound(self.compounds.len() - 1, tree, id)
    }

    fn matches_compound(
        &self,
        index: usize,
        tree: &crate::retained_tree::RetainedTree,
        id: u64,
    ) -> bool {
        let Some(element) = tree.elements.get(&id) else {
            return false;
        };
        if !compound_matches(&self.compounds[index], element) {
            return false;
        }
        if index == 0 {
            return true;
        }
        match self.combs[index - 1] {
            Combinator::Child => element
                .parent
                .is_some_and(|p| self.matches_compound(index - 1, tree, p)),
            Combinator::NextSibling => prev_sibling(tree, id)
                .is_some_and(|s| self.matches_compound(index - 1, tree, s)),
            Combinator::Descendant => {
                let mut ancestor = element.parent;
                while let Some(aid) = ancestor {
                    if self.matches_compound(index - 1, tree, aid) {
                        return true;
                    }
                    ancestor = tree.elements.get(&aid).and_then(|e| e.parent);
                }
                false
            }
            Combinator::LaterSibling => {
                let mut sibling = prev_sibling(tree, id);
                while let Some(sid) = sibling {
                    if self.matches_compound(index - 1, tree, sid) {
                        return true;
                    }
                    sibling = prev_sibling(tree, sid);
                }
                false
            }
        }
    }

    /// Whether the SUBJECT compound mentions a class comp — the cheap
    /// partition for "which elements could this sheet possibly restyle":
    /// a rule whose subject needs a class can never reach a classless
    /// element, no matter what its ancestor compounds say.
    pub(crate) fn requires_class(&self) -> bool {
        self.compounds.last().is_some_and(|compound| {
            compound
                .iter()
                .any(|comp| matches!(comp, SelectorComp::Class(_)))
        })
    }

    /// Every attr name this rule tests, including inside `:not()` compounds
    /// — the registry indexes them so a `setCustomProp` knows when matching
    /// inputs changed.
    fn attr_names(&self, out: &mut rustc_hash::FxHashSet<Box<str>>) {
        for compound in &self.compounds {
            for comp in compound {
                match comp {
                    SelectorComp::Attr { name, .. } => {
                        out.insert(name.clone());
                    }
                    SelectorComp::Not(inner) => {
                        for comp in inner {
                            if let SelectorComp::Attr { name, .. } = comp {
                                out.insert(name.clone());
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

/// Sheets in registration order. The cascade key is
/// (specificity, sheet position, rule order) — equal-specificity conflicts
/// resolve to the later sheet, then the later rule, matching document order.
/// A same-id re-register keeps its slot (an edit, not an append); a sheet
/// dropped and re-registered moves to the end, like a new stylesheet.
#[derive(Default)]
pub struct StyleSheetRegistry {
    sheets: Vec<RegisteredSheet>,
    /// Any rule uses a combinator — matching then depends on ancestors and
    /// siblings, so structural ops and class/attr changes re-resolve a
    /// wider scope (the apply loop consults this before widening).
    has_complex: bool,
    /// Every attr name any rule tests (`[data-open]`, `[tabindex]`…) — a
    /// `setCustomProp` on one of these is a selector input change.
    attr_names: rustc_hash::FxHashSet<Box<str>>,
}

struct RegisteredSheet {
    id: Box<str>,
    rules: Vec<Rule>,
}

impl StyleSheetRegistry {
    /// Register or replace a sheet's rules. Same-id registration replaces —
    /// a re-sent sheet is an edit, not an append. Returns the replaced rules
    /// so the caller can scope re-resolution over BOTH rule sets: a sheet
    /// that shrinks from `div{}` to `.a{}` still has to un-style the
    /// classless elements its old rules reached.
    pub fn register(&mut self, sheet: &str, rules: Vec<Rule>) -> Option<Vec<Rule>> {
        let out = match self.sheets.iter_mut().find(|entry| &*entry.id == sheet) {
            Some(entry) => Some(std::mem::replace(&mut entry.rules, rules)),
            None => {
                self.sheets.push(RegisteredSheet {
                    id: sheet.into(),
                    rules,
                });
                None
            }
        };
        self.rebuild_indexes();
        out
    }

    /// Remove a sheet, returning its rules so the caller can scope the
    /// re-resolution (`None` when the sheet was never registered).
    pub fn unregister(&mut self, sheet: &str) -> Option<Vec<Rule>> {
        let index = self.sheets.iter().position(|entry| &*entry.id == sheet)?;
        let out = Some(self.sheets.remove(index).rules);
        self.rebuild_indexes();
        out
    }

    fn rebuild_indexes(&mut self) {
        self.has_complex = false;
        self.attr_names.clear();
        for sheet in &self.sheets {
            for rule in &sheet.rules {
                if !rule.combs.is_empty() {
                    self.has_complex = true;
                }
                rule.attr_names(&mut self.attr_names);
            }
        }
    }

    /// Selector matching touches ancestors/siblings — when true, reparents,
    /// destroys, and class/attr changes re-resolve beyond the element.
    pub fn has_complex(&self) -> bool {
        self.has_complex
    }

    /// Whether any rule's attr comps test `name` — gates `setCustomProp`
    /// re-resolution (a `value` write on an input is not a selector input
    /// unless a selector says so).
    pub fn tests_attr(&self, name: &str) -> bool {
        self.attr_names.contains(name)
    }

    pub fn len(&self) -> usize {
        self.sheets.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sheets.is_empty()
    }

    /// The symbolic field map this element's selectors resolve to: base
    /// decls at the top level, state decls inside their bucket object.
    /// Matching runs against the live tree — combinator rules walk parents
    /// and siblings. Matching rules sort by (specificity, sheet position,
    /// order) ascending and apply in that order — last write wins per
    /// property, which is the CSS cascade.
    pub(crate) fn resolve_fields(
        &self,
        tree: &crate::retained_tree::RetainedTree,
        id: u64,
    ) -> Map<String, Value> {
        if !tree.elements.contains_key(&id) {
            return Map::new();
        }
        let mut matched: Vec<(usize, &Rule)> = self
            .sheets
            .iter()
            .enumerate()
            .flat_map(|(seq, sheet)| sheet.rules.iter().map(move |rule| (seq, rule)))
            .filter(|(_, rule)| rule.matches(tree, id))
            .collect();
        if matched.is_empty() {
            return Map::new();
        }
        matched.sort_by(|a, b| {
            (a.1.specificity, a.0, a.1.order).cmp(&(b.1.specificity, b.0, b.1.order))
        });
        let mut out = Map::new();
        for (_, rule) in matched {
            // A rule whose decls all dropped must not materialize an empty
            // bucket — `hover:{}` would still flag the element interactive.
            if rule.fields.is_empty() {
                continue;
            }
            match rule.state {
                None => crate::recipe::merge_fields(&mut out, &rule.fields),
                Some(state) => {
                    let bucket = out
                        .entry(state.field_name().to_string())
                        .or_insert_with(|| Value::Object(Map::new()));
                    if let Value::Object(bucket) = bucket {
                        crate::recipe::merge_fields(bucket, &rule.fields);
                    }
                }
            }
        }
        out
    }

    /// Whether any registered rule matches this element — the "has style
    /// layers" test, so a theme/`color` swap re-resolves sheet-derived
    /// styles like every other symbolic layer.
    pub(crate) fn any_match(&self, tree: &crate::retained_tree::RetainedTree, id: u64) -> bool {
        self.sheets
            .iter()
            .flat_map(|sheet| &sheet.rules)
            .any(|rule| rule.matches(tree, id))
    }
}

// ── Declaration parsing ──────────────────────────────────────────────
// Port of gdom.ts `styleObject`: same expansions, same coercions, same drops.

/// `kebab-case` → `camelCase`. `--*` custom props stay raw — they exist only
/// as `var()` sources inside their own decl block.
fn kebab_to_camel(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut upper = false;
    for ch in name.chars() {
        if ch == '-' {
            upper = true;
        } else if upper {
            out.extend(ch.to_uppercase());
            upper = false;
        } else {
            out.push(ch);
        }
    }
    out
}

/// `-?digits[.digits][unit]` → (number text, unit). Anything else is not a
/// dimension the native side can read.
fn split_dimension(value: &str) -> Option<(&str, &str)> {
    let bytes = value.as_bytes();
    let mut end = 0;
    if bytes.first() == Some(&b'-') {
        end = 1;
    }
    let mut digits = 0;
    let mut dots = 0;
    while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b'.') {
        if bytes[end] == b'.' {
            dots += 1;
        } else {
            digits += 1;
        }
        end += 1;
    }
    if digits == 0 || dots > 1 {
        return None;
    }
    Some((&value[..end], &value[end..]))
}

/// css dimension → field value: px/unitless → f64, `N%` → "N%", `auto` →
/// "auto", em/rem → ×16 px. Viewport units degrade to `%` — the native side
/// has no viewport measure, which is JS's own fallback when unset.
fn to_dimension(value: &str) -> Option<Value> {
    if value == "auto" {
        return Some(Value::from("auto"));
    }
    let (digits, unit) = split_dimension(value)?;
    let number: f64 = digits.parse().ok()?;
    if !number.is_finite() {
        return None;
    }
    match unit {
        "" | "px" => Some(Value::from(number)),
        "%" => Some(Value::from(format!("{number}%"))),
        "rem" | "em" => Some(Value::from(number * 16.0)),
        "vh" | "vw" | "svh" | "svw" | "lvh" | "lvw" | "dvh" | "dvw" => {
            Some(Value::from(format!("{number}%")))
        }
        _ => None,
    }
}

/// Numeric-only dimension: `calc()` evaluates first (single-unit arithmetic,
/// like JS), plain dimensions follow. `%` results are not numbers.
fn to_number(value: &str) -> Option<f64> {
    let parsed = if value.starts_with("calc(") {
        eval_calc(value)?
    } else {
        to_dimension(value)?
    };
    parsed.as_f64()
}

/// calc() → f64 px or "N%". Grammar mirrors JS `evalCalc`: expr is +/- over
/// terms, term is */ over factors, factor is a parenthesized expr or a
/// dimension. Same-unit required for +/-; */ keeps whichever side's unit.
fn eval_calc(expr: &str) -> Option<Value> {
    let inner = expr.trim().strip_prefix("calc(")?.strip_suffix(')')?.trim();
    let tokens = tokenize_calc(inner)?;
    let mut pos = 0;
    let value = calc_expr(&tokens, &mut pos)?;
    if pos != tokens.len() {
        return None;
    }
    Some(match value.unit {
        "%" => Value::from(format!("{}%", value.n)),
        _ => Value::from(value.n),
    })
}

#[derive(Clone, Copy)]
struct CalcValue {
    n: f64,
    unit: &'static str,
}

fn tokenize_calc(s: &str) -> Option<Vec<String>> {
    let bytes = s.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        // `-` is a sign only when a digit (or .digit) follows; otherwise it's
        // the binary operator — same read as the JS token regex.
        let negative_number = c == '-'
            && bytes
                .get(i + 1)
                .is_some_and(|b| b.is_ascii_digit() || *b == b'.');
        if negative_number || c.is_ascii_digit() || c == '.' {
            let start = i;
            if c == '-' {
                i += 1;
            }
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                i += 1;
            }
            while i < bytes.len() && (bytes[i].is_ascii_lowercase() || bytes[i] == b'%') {
                i += 1;
            }
            tokens.push(s[start..i].to_string());
            continue;
        }
        if "()+-*/".contains(c) {
            tokens.push(c.to_string());
            i += 1;
            continue;
        }
        return None;
    }
    Some(tokens)
}

fn calc_factor(tokens: &[String], pos: &mut usize) -> Option<CalcValue> {
    let token = tokens.get(*pos)?;
    if token == "(" {
        *pos += 1;
        let value = calc_expr(tokens, pos)?;
        if tokens.get(*pos).map(String::as_str) != Some(")") {
            return None;
        }
        *pos += 1;
        return Some(value);
    }
    *pos += 1;
    let (digits, unit) = split_dimension(token)?;
    let n: f64 = digits.parse().ok()?;
    if !n.is_finite() {
        return None;
    }
    Some(match unit {
        "" | "px" => CalcValue { n, unit: "px" },
        "rem" | "em" => CalcValue {
            n: n * 16.0,
            unit: "px",
        },
        "%" | "vh" | "vw" | "svh" | "svw" | "lvh" | "lvw" | "dvh" | "dvw" => {
            CalcValue { n, unit: "%" }
        }
        _ => return None,
    })
}

fn calc_term(tokens: &[String], pos: &mut usize) -> Option<CalcValue> {
    let mut value = calc_factor(tokens, pos)?;
    while matches!(tokens.get(*pos).map(String::as_str), Some("*") | Some("/")) {
        let op = tokens[*pos].as_str();
        *pos += 1;
        let rhs = calc_factor(tokens, pos)?;
        // `*`/`/` across two different units is meaningless — one side must
        // carry no unit (the "" unit never occurs here; everything is px/%).
        if !rhs.unit.is_empty() && !value.unit.is_empty() && rhs.unit != value.unit {
            return None;
        }
        let unit = if value.unit.is_empty() {
            rhs.unit
        } else {
            value.unit
        };
        value = CalcValue {
            n: if op == "*" {
                value.n * rhs.n
            } else {
                value.n / rhs.n
            },
            unit,
        };
    }
    Some(value)
}

fn calc_expr(tokens: &[String], pos: &mut usize) -> Option<CalcValue> {
    let mut value = calc_term(tokens, pos)?;
    while matches!(tokens.get(*pos).map(String::as_str), Some("+") | Some("-")) {
        let op = tokens[*pos].as_str();
        *pos += 1;
        let rhs = calc_term(tokens, pos)?;
        if rhs.unit != value.unit {
            return None;
        }
        value = CalcValue {
            n: if op == "+" {
                value.n + rhs.n
            } else {
                value.n - rhs.n
            },
            unit: value.unit,
        };
    }
    Some(value)
}

/// Whitespace split that keeps functional values whole — `calc(0.25rem * 2)`
/// is one component, `10px 16px` is two.
fn split_css_components(value: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut start = 0usize;
    for (index, ch) in value.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ if ch.is_whitespace() && depth == 0 => {
                if start < index {
                    parts.push(&value[start..index]);
                }
                start = index + ch.len_utf8();
            }
            _ => {}
        }
    }
    if start < value.len() {
        parts.push(&value[start..]);
    }
    parts
}

/// `var(--name)` / `var(--name, fallback)` resolve against the rule's own
/// `--*` decls — element-scoped custom props exist only as var() sources
/// (globals are baked JS-side). Depth-capped like the JS implementation.
fn resolve_vars(
    value: &str,
    props: &std::collections::BTreeMap<String, String>,
    depth: u8,
) -> String {
    if depth > 4 {
        return value.to_string();
    }
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(at) = rest.find("var(") {
        out.push_str(&rest[..at]);
        let inner = &rest[at + 4..];
        let Some(close) = inner.find(')') else {
            // Unterminated var( — emit verbatim so the unsafe-value drop
            // still sees it.
            out.push_str(&rest[at..]);
            return out;
        };
        let body = inner[..close].trim();
        let (name, fallback) = match body.split_once(',') {
            Some((name, fallback)) => (name.trim(), Some(fallback.trim())),
            None => (body, None),
        };
        if name.starts_with("--") {
            if let Some(own) = props.get(name) {
                out.push_str(&resolve_vars(own, props, depth + 1));
            } else {
                // No own decl: the fallback wins, else the var() survives
                // verbatim and the unsafe-value drop removes the decl.
                out.push_str(fallback.unwrap_or(&rest[at..at + 4 + close + 1]));
            }
        } else {
            out.push_str(&rest[at..at + 4 + close + 1]);
        }
        rest = &rest[at + 4 + close + 1..];
    }
    out.push_str(rest);
    out
}

/// css 1–4-value box shorthands → per-direction fields (top/right/bottom/left).
fn box_longhands(key: &str) -> Option<&'static [&'static str]> {
    Some(match key {
        "padding" => &["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"],
        "margin" => &["marginTop", "marginRight", "marginBottom", "marginLeft"],
        "inset" => &["top", "right", "bottom", "left"],
        "borderWidth" => &[
            "borderTopWidth",
            "borderRightWidth",
            "borderBottomWidth",
            "borderLeftWidth",
        ],
        "borderRadius" => &[
            "borderTopLeftRadius",
            "borderTopRightRadius",
            "borderBottomRightRadius",
            "borderBottomLeftRadius",
        ],
        _ => return None,
    })
}

/// Fields whose native type is a bare f64 — `%`/`auto`/keywords must drop,
/// not pass through: a wrong type rejects the whole `StyleDesc` parse.
fn number_field(key: &str) -> bool {
    matches!(
        key,
        "fontSize"
            | "lineHeight"
            | "opacity"
            | "flexGrow"
            | "flexShrink"
            | "gap"
            | "rowGap"
            | "columnGap"
            | "padding"
            | "paddingTop"
            | "paddingRight"
            | "paddingBottom"
            | "paddingLeft"
            | "margin"
            | "marginTop"
            | "marginRight"
            | "marginBottom"
            | "marginLeft"
            | "top"
            | "right"
            | "bottom"
            | "left"
            | "borderWidth"
            | "borderTopWidth"
            | "borderRightWidth"
            | "borderBottomWidth"
            | "borderLeftWidth"
            | "borderRadius"
            | "borderTopLeftRadius"
            | "borderTopRightRadius"
            | "borderBottomRightRadius"
            | "borderBottomLeftRadius"
            | "lineClamp"
            | "gridTemplateColumns"
            | "gridTemplateRows"
            | "zIndex"
    )
}

/// Fields accepting a DimensionValue (number | `N%` | `auto`).
fn dimension_field(key: &str) -> bool {
    matches!(
        key,
        "width" | "height" | "minWidth" | "minHeight" | "maxWidth" | "maxHeight" | "flexBasis"
    )
}

/// Color-kind fields — named colors normalize to hex so they survive token
/// resolution as literals (`resolve_style` drops non-token non-literals).
fn color_field(key: &str) -> bool {
    matches!(
        key,
        "background"
            | "backgroundColor"
            | "color"
            | "borderColor"
            | "selectionColor"
            | "borderTopColor"
            | "borderRightColor"
            | "borderBottomColor"
            | "borderLeftColor"
            | "textDecorationColor"
    )
}

/// css logical props → physical fields the engine understands.
fn logical_fields(key: &str) -> Option<&'static [&'static str]> {
    Some(match key {
        "insetBlock" => &["top", "bottom"],
        "insetBlockStart" => &["top"],
        "insetBlockEnd" => &["bottom"],
        "insetInline" => &["left", "right"],
        "insetInlineStart" => &["left"],
        "insetInlineEnd" => &["right"],
        "paddingBlock" => &["paddingTop", "paddingBottom"],
        "paddingInline" => &["paddingLeft", "paddingRight"],
        "marginBlock" => &["marginTop", "marginBottom"],
        "marginInline" => &["marginLeft", "marginRight"],
        "borderBlockWidth" => &["borderTopWidth", "borderBottomWidth"],
        "borderInlineWidth" => &["borderLeftWidth", "borderRightWidth"],
        "borderBlockColor" => &["borderTopColor", "borderBottomColor"],
        "borderInlineColor" => &["borderLeftColor", "borderRightColor"],
        "borderStartStartRadius" => &["borderTopLeftRadius"],
        "borderStartEndRadius" => &["borderTopRightRadius"],
        "borderEndStartRadius" => &["borderBottomLeftRadius"],
        "borderEndEndRadius" => &["borderBottomRightRadius"],
        _ => return None,
    })
}

/// Named colors → `#hex` through csscolorparser so token resolution treats
/// them as literals. `currentColor` and unparseable values pass through —
/// palette tokens resolve in `resolve_style`, and `currentColor` is
/// load-bearing in shadow members.
fn normalize_color(value: &str) -> String {
    if value.eq_ignore_ascii_case("currentcolor") {
        return value.to_string();
    }
    match csscolorparser::parse(value) {
        Ok(color) => color.to_css_hex(),
        Err(_) => value.to_string(),
    }
}

/// `N(px)` → f64 — the number components of a `box-shadow` layer.
fn shadow_number(component: &str) -> Option<f64> {
    let (digits, unit) = split_dimension(component)?;
    match unit {
        "" | "px" => digits.parse::<f64>().ok().filter(|n| n.is_finite()),
        _ => None,
    }
}

/// One `box-shadow` layer → a `BoxShadowValue` member: `[inset] ox oy [blur]
/// [spread] color`. A layer that can't parse contributes nothing — the next
/// layer in the list gets its chance.
fn parse_shadow_layer(layer: &str) -> Option<Value> {
    let layer = layer.trim();
    let (inset, rest) = match layer.strip_prefix("inset") {
        Some(rest) if rest.starts_with(char::is_whitespace) => (true, rest.trim_start()),
        _ => (false, layer),
    };
    let components = split_css_components(rest);
    let offset_x = shadow_number(components.first()?)?;
    let offset_y = shadow_number(components.get(1)?)?;
    let mut index = 2;
    let mut blur_radius = 0.0;
    let mut spread_radius = 0.0;
    if let Some(value) = components.get(index).and_then(|c| shadow_number(c)) {
        blur_radius = value;
        index += 1;
    }
    if let Some(value) = components.get(index).and_then(|c| shadow_number(c)) {
        spread_radius = value;
        index += 1;
    }
    let color = components.get(index..)?.join(" ");
    if color.is_empty() {
        return None;
    }
    let color = normalize_color(&color);
    // A fully transparent layer paints nothing — skip it so a later layer
    // can win, like the JS `#0{4}|transparent` gate.
    if crate::color::parse_color_rgba(&color).is_some_and(|rgba| rgba.a <= 0.0) {
        return None;
    }
    Some(serde_json::json!({
        "inset": inset,
        "offsetX": offset_x,
        "offsetY": offset_y,
        "blurRadius": blur_radius,
        "spreadRadius": spread_radius,
        "color": color,
    }))
}

/// Comma-separated shadow layers → a one-member `boxShadow` list: the first
/// layer that parses and isn't transparent. The array shape matters — arrays
/// replace wholesale on merge, so a later rule's shadow is not deep-merged
/// into an earlier one's member fields.
fn parse_box_shadow(value: &str) -> Option<Value> {
    let mut depth = 0i32;
    let mut start = 0usize;
    let mut layers = Vec::new();
    for (index, ch) in value.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                layers.push(&value[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    layers.push(&value[start..]);
    let member = layers.iter().find_map(|layer| parse_shadow_layer(layer))?;
    Some(Value::Array(vec![member]))
}

/// Values the native style model cannot represent — a decl carrying one
/// drops rather than writing garbage into a string field.
fn unsafe_value(value: &str) -> bool {
    [
        "var(",
        "url(",
        "clamp(",
        "attr(",
        "env(",
        "color-mix(",
        "gradient(",
        "conic(",
        "min(",
        "max(",
        "mix(",
        "oklch from",
        "calc(",
    ]
    .iter()
    .any(|needle| value.contains(needle))
}

/// CSS `prop: value; …` → the symbolic field map (StyleDesc camelCase keys)
/// that every other style layer speaks. Port of gdom.ts `styleObject`:
/// shorthands expand to longhands, values coerce to field shapes, `var()`
/// resolves inside the decl block, unrepresentable values drop.
pub(crate) fn parse_decls(decls: &str) -> Map<String, Value> {
    // First pass: name → raw value, honoring declaration order (a later decl
    // of the same property overwrites — within a rule, source order wins).
    let mut raw = std::collections::BTreeMap::<String, String>::new();
    for decl in decls.split(';') {
        let Some((name, value)) = decl.split_once(':') else {
            continue;
        };
        let name = name.trim();
        let mut value = value.trim();
        // `!important` carries no weight here — there is no higher layer for
        // it to beat; the value still applies.
        if value
            .get(value.len().saturating_sub(10)..)
            .is_some_and(|tail| tail.eq_ignore_ascii_case("!important"))
        {
            value = value[..value.len() - 10].trim_end();
        }
        if !name.is_empty() && !value.is_empty() {
            let key = if name.starts_with("--") {
                name.to_string()
            } else {
                kebab_to_camel(name)
            };
            raw.insert(key, value.to_string());
        }
    }

    let mut out = Map::new();
    for (key, raw_value) in &raw {
        if key.starts_with("--") {
            continue;
        }
        let value = resolve_vars(raw_value, &raw, 0);
        let value = value.trim();

        if let Some(longhands) = box_longhands(key) {
            let parts = split_css_components(value);
            if (1..=4).contains(&parts.len()) {
                let values = [
                    parts[0],
                    parts.get(1).copied().unwrap_or(parts[0]),
                    parts.get(2).copied().unwrap_or(parts[0]),
                    parts
                        .get(3)
                        .copied()
                        .unwrap_or_else(|| parts.get(1).copied().unwrap_or(parts[0])),
                ];
                let mut converted = [None, None, None, None];
                let mut all = true;
                for (slot, component) in converted.iter_mut().zip(values) {
                    *slot = to_number(component);
                    all &= slot.is_some();
                }
                if all {
                    for (field, number) in longhands.iter().zip(converted.iter()) {
                        if let Some(number) = number {
                            out.insert(field.to_string(), Value::from(*number));
                        }
                    }
                }
            }
            continue;
        }
        match key.as_str() {
            "gap" => {
                let parts = split_css_components(value);
                if let Some(row) = parts.first().and_then(|p| to_number(p)) {
                    out.insert("rowGap".into(), Value::from(row));
                }
                if let Some(column) = parts
                    .get(1)
                    .copied()
                    .or_else(|| parts.first().copied())
                    .and_then(to_number)
                {
                    out.insert("columnGap".into(), Value::from(column));
                }
            }
            // flex: <grow> [<shrink> [<basis>]] | none | auto | initial
            "flex" => {
                let parts = split_css_components(value);
                match parts.first().copied() {
                    Some("none") => {
                        out.insert("flexGrow".into(), Value::from(0));
                        out.insert("flexShrink".into(), Value::from(0));
                    }
                    Some("auto") => {
                        out.insert("flexGrow".into(), Value::from(1));
                        out.insert("flexShrink".into(), Value::from(1));
                    }
                    _ => {
                        if let Some(grow) = parts
                            .first()
                            .and_then(|part| part.parse::<f64>().ok())
                            .filter(|n| n.is_finite())
                        {
                            out.insert("flexGrow".into(), Value::from(grow));
                            let shrink = parts
                                .get(1)
                                .and_then(|part| part.parse::<f64>().ok())
                                .filter(|n| n.is_finite())
                                .unwrap_or(1.0);
                            out.insert("flexShrink".into(), Value::from(shrink));
                            if let Some(basis) = parts.get(2).and_then(|part| to_number(part)) {
                                out.insert("flexBasis".into(), Value::from(basis));
                            }
                        }
                    }
                }
            }
            // The native scrollable literal is "scroll"; css "auto" is the same.
            "overflow" => {
                let parts = split_css_components(value);
                for (field, component) in [
                    ("overflowX", parts.first()),
                    ("overflowY", parts.get(1).or(parts.first())),
                ] {
                    if let Some(component) = component.copied() {
                        let component = if component == "auto" {
                            "scroll"
                        } else {
                            component
                        };
                        out.insert(field.into(), Value::from(component));
                    }
                }
            }
            "overflowX" | "overflowY" => {
                out.insert(
                    key.clone(),
                    Value::from(if value == "auto" { "scroll" } else { value }),
                );
            }
            "border" => {
                let components: Vec<&str> = value.split_whitespace().collect();
                if components.len() >= 3
                    && matches!(components[1], "solid" | "dashed" | "dotted" | "double")
                {
                    if let Some(width) = to_number(components[0]) {
                        out.insert("borderWidth".into(), Value::from(width));
                    }
                    if let Some(at) = value.find(components[1]) {
                        let color = value[at + components[1].len()..].trim();
                        if !color.is_empty() {
                            out.insert("borderColor".into(), Value::from(normalize_color(color)));
                        }
                    }
                }
            }
            "gridTemplateColumns" | "gridTemplateRows" => {
                // repeat(N, …) → N; a bare number → N; track lists can't
                // express → drop.
                let count = value
                    .strip_prefix("repeat(")
                    .and_then(|rest| {
                        rest.trim_start()
                            .split(|c: char| !c.is_ascii_digit())
                            .next()
                    })
                    .and_then(|digits| digits.parse::<f64>().ok())
                    .or_else(|| to_number(value));
                if let Some(count) = count.filter(|n| *n > 0.0) {
                    out.insert(key.clone(), Value::from(count));
                }
            }
            "boxShadow" => {
                if let Some(member) = parse_box_shadow(value) {
                    out.insert(key.clone(), member);
                }
            }
            "fontFamily" => {
                // First usable family wins; quotes are punctuation, not name.
                if let Some(first) = value.split(',').next() {
                    let first = first.trim().trim_matches(|c| c == '"' || c == '\'');
                    if !first.is_empty() {
                        out.insert(key.clone(), Value::from(first));
                    }
                }
            }
            "letterSpacing" | "wordSpacing" => {
                if let Some(number) = to_number(value) {
                    out.insert(key.clone(), Value::from(number));
                }
            }
            // font-feature-settings: "tnum" 1, "liga" off → the feature map
            // gpui's FontFeatures deserializes.
            "fontFeatureSettings" => {
                let mut features = serde_json::Map::new();
                for entry in value.split(',') {
                    let mut parts = entry.trim().split_whitespace();
                    let Some(tag) = parts.next().map(|t| t.trim_matches(|c| c == '"' || c == '\'')) else { continue };
                    let value = match parts.next() {
                        None | Some("on") => Value::from(true),
                        Some("off") => Value::from(false),
                        Some(n) => match n.parse::<u64>() {
                            Ok(n) => Value::from(n),
                            Err(_) => continue,
                        },
                    };
                    features.insert(tag.to_string(), value);
                }
                if !features.is_empty() {
                    out.insert("fontFeatures".into(), Value::Object(features));
                }
            }
            // aspectRatio is a bare f64 in StyleDesc — "16/9" must become a
            // number here or serde rejects the whole resolved style.
            "aspectRatio" => {
                let ratio = match value.split_once('/') {
                    Some((a, b)) => match (a.trim().parse::<f64>(), b.trim().parse::<f64>()) {
                        (Ok(a), Ok(b)) if b != 0.0 => Some(a / b),
                        _ => None,
                    },
                    None => to_number(value),
                };
                if let Some(ratio) = ratio.filter(|n| n.is_finite() && *n > 0.0) {
                    out.insert(key.clone(), Value::from(ratio));
                }
            }
            _ => {
                if let Some(fields) = logical_fields(key) {
                    // Logical props take 1–2 values: all | start,end.
                    let parts = split_css_components(value);
                    let first = parts.first().copied().unwrap_or(value);
                    let second = parts.get(1).copied().unwrap_or(first);
                    for (index, field) in fields.iter().enumerate() {
                        let component = if index == 0 { first } else { second };
                        if let Some(number) = to_number(component) {
                            out.insert(field.to_string(), Value::from(number));
                        }
                    }
                } else if number_field(key) {
                    if let Some(number) = to_number(value) {
                        out.insert(key.clone(), Value::from(number));
                    }
                } else if dimension_field(key) {
                    match if value.starts_with("calc(") {
                        eval_calc(value)
                    } else {
                        to_dimension(value)
                    } {
                        Some(dimension) => {
                            out.insert(key.clone(), dimension);
                        }
                        None => {
                            // fit-content/min-content/max-content/stretch all
                            // mean "size to content" — the Auto arm.
                            if matches!(
                                value,
                                "fit-content" | "min-content" | "max-content" | "stretch"
                            ) {
                                out.insert(key.clone(), Value::from("auto"));
                            }
                        }
                    }
                } else if matches!(
                    value,
                    "inherit" | "initial" | "unset" | "revert" | "revert-layer"
                ) {
                    // css-wide keywords lean on a real cascade — nothing to do.
                } else if unsafe_value(value) {
                    // Can't represent it — drop the decl, keep the rule.
                } else if color_field(key) {
                    out.insert(key.clone(), Value::from(normalize_color(value)));
                } else {
                    out.insert(key.clone(), Value::from(value));
                }
            }
        }
    }

    // css unitless line-height is a font-size multiplier; the native field
    // wants px. Emit it as `lineHeightScale` — gpui resolves the fraction
    // against the element's own font size, so a bare `line-height: 1.5`
    // stays correct even when fontSize lives in a different rule.
    if let Some(scale) = out
        .get("lineHeight")
        .and_then(|v| v.as_f64())
        .filter(|n| *n > 0.0 && *n < 8.0)
    {
        out.shift_remove("lineHeight");
        out.insert("lineHeightScale".into(), Value::from(scale));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::retained_tree::{RetainedTree, MEMO_HAS_EVENTS};

    fn apply(tree: &mut RetainedTree, json: &str) -> crate::renderer::BatchResult<Vec<f64>> {
        crate::renderer::apply_batch_to_tree(tree, json.as_bytes())
            .map(|outcome| outcome.destroyed)
    }

    /// Build a `stylesheet.register` op batch carrying `rules` verbatim.
    fn register(sheet: &str, rules: &str) -> String {
        format!(r#"[["stylesheet.register","{sheet}",{rules}]]"#)
    }

    fn rule(sel: &str, decls: &str, spec: &str, order: u64) -> String {
        format!(r#"{{"sel":[{sel}],"decls":"{decls}","spec":{spec},"order":{order}}}"#)
    }

    fn class(name: &str) -> String {
        format!(r#"{{"k":"class","v":"{name}"}}"#)
    }

    fn tag(name: &str) -> String {
        format!(r#"{{"k":"tag","v":"{name}"}}"#)
    }

    fn dom_id(name: &str) -> String {
        format!(r#"{{"k":"id","v":"{name}"}}"#)
    }

    fn state(name: &str) -> String {
        format!(r#"{{"k":"state","v":"{name}"}}"#)
    }

    fn div_with_class(tree: &mut RetainedTree, classes: &str) {
        apply(
            tree,
            &format!(r#"[["createElement",1,"div"],["setRoot",1],["setClass",1,"{classes}"]]"#),
        )
        .expect("mount batch");
    }

    fn style_of(tree: &RetainedTree, id: u64) -> &crate::style::StyleDesc {
        tree.elements[&id]
            .style
            .as_deref()
            .expect("element should have a resolved style")
    }

    #[test]
    fn a_class_rule_matches_and_restyles_existing_elements() {
        let mut tree = RetainedTree::new();
        div_with_class(&mut tree, "btn");
        // Register after the element exists — the sheet must invalidate and
        // re-resolve the elements it can match.
        apply(
            &mut tree,
            &register(
                "app",
                &format!(
                    "[{}]",
                    rule(&class("btn"), "color:#ff0000;padding:4px", "[0,1,0]", 0)
                ),
            ),
        )
        .expect("register batch");
        let style = style_of(&tree, 1);
        assert_eq!(style.color.as_deref(), Some("#ff0000"));
        assert_eq!(style.padding_top, Some(4.0));
        assert_eq!(style.padding_right, Some(4.0));
        assert_eq!(style.padding_bottom, Some(4.0));
        assert_eq!(style.padding_left, Some(4.0));
    }

    #[test]
    fn a_tag_rule_matches_the_element_type() {
        let mut tree = RetainedTree::new();
        apply(
            &mut tree,
            &register(
                "app",
                &format!("[{}]", rule(&tag("div"), "color:#00ff00", "[1,0,0]", 0)),
            ),
        )
        .expect("register batch");
        apply(
            &mut tree,
            r#"[["createElement",1,"div"],["createElement",2,"text"],["setRoot",1]]"#,
        )
        .expect("mount batch");
        assert_eq!(style_of(&tree, 1).color.as_deref(), Some("#00ff00"));
        // `text` is a different element type — the rule must not reach it.
        assert!(
            tree.elements[&2].style.is_none() || style_of(&tree, 2).color.is_none(),
            "a div rule must not style a text element"
        );
    }

    #[test]
    fn an_id_rule_matches_the_dom_id_prop() {
        let mut tree = RetainedTree::new();
        apply(
            &mut tree,
            &register(
                "app",
                &format!("[{}]", rule(&dom_id("hero"), "color:#0000ff", "[1,0,0]", 0)),
            ),
        )
        .expect("register batch");
        apply(
            &mut tree,
            r#"[["createElement",1,"div"],["setRoot",1],["setCustomProp",1,"id","hero"]]"#,
        )
        .expect("mount batch");
        assert_eq!(style_of(&tree, 1).color.as_deref(), Some("#0000ff"));
    }

    #[test]
    fn a_compound_selector_requires_every_component() {
        let mut tree = RetainedTree::new();
        div_with_class(&mut tree, "a");
        apply(
            &mut tree,
            &register(
                "app",
                &format!(
                    "[{}]",
                    rule(
                        &format!("{},{}", class("a"), class("b")),
                        "color:#ff0000",
                        "[0,2,0]",
                        0,
                    )
                ),
            ),
        )
        .expect("register batch");
        assert!(
            tree.elements[&1].style.is_none() || style_of(&tree, 1).color.is_none(),
            "`.a.b` must not match an element that only carries `a`"
        );
        apply(&mut tree, r#"[["setClass",1,"a b"]]"#).expect("setClass batch");
        assert_eq!(style_of(&tree, 1).color.as_deref(), Some("#ff0000"));
    }

    #[test]
    fn unmatched_rules_apply_nothing() {
        let mut tree = RetainedTree::new();
        div_with_class(&mut tree, "x");
        apply(
            &mut tree,
            &register(
                "app",
                &format!("[{}]", rule(&class("y"), "color:#ff0000", "[0,1,0]", 0)),
            ),
        )
        .expect("register batch");
        assert!(
            tree.elements[&1].style.is_none() || style_of(&tree, 1).color.is_none(),
            "a non-matching rule must not leak fields into the element style"
        );
    }

    #[test]
    fn a_universal_rule_matches_anything() {
        let mut tree = RetainedTree::new();
        apply(&mut tree, r#"[["createElement",1,"div"],["setRoot",1]]"#).expect("mount");
        apply(
            &mut tree,
            &register(
                "app",
                &format!(
                    "[{}]",
                    rule(r#"{"k":"universal"}"#, "opacity:0.5", "[0,0,0]", 0)
                ),
            ),
        )
        .expect("register batch");
        assert_eq!(style_of(&tree, 1).opacity, Some(0.5));
    }

    #[test]
    fn specificity_beats_source_order() {
        let mut tree = RetainedTree::new();
        div_with_class(&mut tree, "a b");
        let rules = format!(
            "[{},{}]",
            // Higher specificity, earlier order — must still win.
            rule(
                &format!("{},{}", class("a"), class("b")),
                "color:#111111",
                "[0,2,0]",
                0
            ),
            rule(&class("b"), "color:#222222", "[0,1,0]", 1),
        );
        apply(&mut tree, &register("app", &rules)).expect("register batch");
        assert_eq!(style_of(&tree, 1).color.as_deref(), Some("#111111"));
    }

    #[test]
    fn source_order_breaks_specificity_ties() {
        let mut tree = RetainedTree::new();
        div_with_class(&mut tree, "a");
        let rules = format!(
            "[{},{}]",
            rule(&class("a"), "color:#111111", "[0,1,0]", 0),
            rule(&class("a"), "color:#222222", "[0,1,0]", 1),
        );
        apply(&mut tree, &register("app", &rules)).expect("register batch");
        assert_eq!(style_of(&tree, 1).color.as_deref(), Some("#222222"));
    }

    #[test]
    fn inline_style_beats_the_stylesheet() {
        let mut tree = RetainedTree::new();
        div_with_class(&mut tree, "btn");
        apply(
            &mut tree,
            &register(
                "app",
                &format!(
                    "[{}]",
                    rule(&class("btn"), "color:#ff0000;padding:4px", "[0,1,0]", 0)
                ),
            ),
        )
        .expect("register batch");
        apply(&mut tree, r##"[["setStyle",1,{"color":"#0000ff"}]]"##).expect("setStyle batch");
        let style = style_of(&tree, 1);
        assert_eq!(
            style.color.as_deref(),
            Some("#0000ff"),
            "the inline style attr must override the stylesheet"
        );
        assert_eq!(
            style.padding_top,
            Some(4.0),
            "stylesheet fields the inline style does not touch still apply"
        );
    }

    #[test]
    fn state_components_route_into_the_pseudo_bucket() {
        let mut tree = RetainedTree::new();
        div_with_class(&mut tree, "btn");
        let rules = format!(
            "[{}]",
            rule(
                &format!("{},{}", class("btn"), state("hover")),
                "color:#ff0000;background-color:#00ff00",
                "[0,1,0]",
                0,
            )
        );
        apply(&mut tree, &register("app", &rules)).expect("register batch");
        let style = style_of(&tree, 1);
        assert!(
            style.color.is_none(),
            "state decls must not leak into the base fields"
        );
        let hover = style.hover.as_deref().expect("hover bucket populated");
        assert_eq!(hover.color.as_deref(), Some("#ff0000"));
        assert_eq!(hover.background_color.as_deref(), Some("#00ff00"));
        assert!(
            style.has_state_bucket(),
            "a resolved pseudo bucket must flag the style interactive"
        );
    }

    #[test]
    fn every_state_routes_to_its_own_bucket() {
        let mut tree = RetainedTree::new();
        div_with_class(&mut tree, "a");
        let rules = format!(
            "[{},{},{},{}]",
            rule(
                &format!("{},{}", class("a"), state("hover")),
                "opacity:0.1",
                "[0,1,0]",
                0
            ),
            rule(
                &format!("{},{}", class("a"), state("active")),
                "opacity:0.2",
                "[0,1,0]",
                1
            ),
            rule(
                &format!("{},{}", class("a"), state("focus")),
                "opacity:0.3",
                "[0,1,0]",
                2
            ),
            rule(
                &format!("{},{}", class("a"), state("focusVisible")),
                "opacity:0.4",
                "[0,1,0]",
                3,
            ),
        );
        apply(&mut tree, &register("app", &rules)).expect("register batch");
        let style = style_of(&tree, 1);
        assert_eq!(style.hover.as_deref().and_then(|s| s.opacity), Some(0.1));
        assert_eq!(style.active.as_deref().and_then(|s| s.opacity), Some(0.2));
        assert_eq!(style.focus.as_deref().and_then(|s| s.opacity), Some(0.3));
        assert_eq!(
            style.focus_visible.as_deref().and_then(|s| s.opacity),
            Some(0.4)
        );
        assert!(style.focus_within.is_none());
    }

    #[test]
    fn a_pseudo_bucket_disqualifies_memoization() {
        let mut tree = RetainedTree::new();
        div_with_class(&mut tree, "a");
        apply(
            &mut tree,
            &register(
                "app",
                &format!(
                    "[{}]",
                    rule(
                        &format!("{},{}", class("a"), state("hover")),
                        "color:#ff0000",
                        "[0,1,0]",
                        0,
                    )
                ),
            ),
        )
        .expect("register batch");
        // A cached leaf would replay the hover state it was recorded under —
        // the events disqualifier must cover native state buckets too.
        assert_ne!(
            tree.memo_scan(1).flags & MEMO_HAS_EVENTS,
            0,
            "an element with a state bucket must not be replayed from a cached paint"
        );
    }

    #[test]
    fn setclass_re_resolves_against_registered_sheets() {
        let mut tree = RetainedTree::new();
        apply(&mut tree, r#"[["createElement",1,"div"],["setRoot",1]]"#).expect("mount");
        apply(
            &mut tree,
            &register(
                "app",
                &format!("[{}]", rule(&class("x"), "color:#ff0000", "[0,1,0]", 0)),
            ),
        )
        .expect("register batch");
        assert!(
            tree.elements[&1].style.is_none() || style_of(&tree, 1).color.is_none(),
            "no class, no match"
        );
        apply(&mut tree, r#"[["setClass",1,"x"]]"#).expect("setClass batch");
        assert_eq!(style_of(&tree, 1).color.as_deref(), Some("#ff0000"));
        assert_eq!(
            tree.elements[&1].classes,
            vec!["x".to_string()],
            "the token list replaces, not appends"
        );
    }

    #[test]
    fn setclass_replaces_the_whole_token_list() {
        let mut tree = RetainedTree::new();
        div_with_class(&mut tree, "a b");
        apply(
            &mut tree,
            &register(
                "app",
                &format!(
                    "[{}]",
                    rule(
                        &format!("{},{}", class("a"), class("b")),
                        "color:#ff0000",
                        "[0,2,0]",
                        0,
                    )
                ),
            ),
        )
        .expect("register batch");
        assert_eq!(style_of(&tree, 1).color.as_deref(), Some("#ff0000"));
        // Dropping `b` must un-apply the compound rule — the attr replaces.
        apply(&mut tree, r#"[["setClass",1,"a"]]"#).expect("setClass batch");
        assert!(
            style_of(&tree, 1).color.is_none(),
            "losing a required token must un-apply the compound rule"
        );
    }

    #[test]
    fn unregister_removes_the_sheets_rules() {
        let mut tree = RetainedTree::new();
        div_with_class(&mut tree, "btn");
        apply(
            &mut tree,
            &register(
                "app",
                &format!("[{}]", rule(&class("btn"), "color:#ff0000", "[0,1,0]", 0)),
            ),
        )
        .expect("register batch");
        assert_eq!(style_of(&tree, 1).color.as_deref(), Some("#ff0000"));
        apply(&mut tree, r#"[["stylesheet.unregister","app"]]"#).expect("unregister batch");
        assert!(
            style_of(&tree, 1).color.is_none(),
            "unregistering must re-resolve and drop the sheet's contribution"
        );
        assert_eq!(tree.sheets.len(), 0);
    }

    #[test]
    fn rules_with_multiple_state_components_are_skipped() {
        let mut tree = RetainedTree::new();
        div_with_class(&mut tree, "a");
        let rules = format!(
            "[{},{}]",
            rule(
                &format!("{},{},{}", class("a"), state("hover"), state("active")),
                "color:#ff0000",
                "[0,1,0]",
                0,
            ),
            rule(&class("a"), "color:#00ff00", "[0,1,0]", 1),
        );
        apply(&mut tree, &register("app", &rules)).expect("register batch");
        let style = style_of(&tree, 1);
        // The multi-state rule drops at register; the valid rule still applies.
        assert_eq!(style.color.as_deref(), Some("#00ff00"));
        assert!(style.hover.is_none(), "a two-state rule cannot route");
    }

    #[test]
    fn object_form_ops_decode_too() {
        let mut tree = RetainedTree::new();
        apply(&mut tree, r#"[{"op":"createElement","id":1}]"#)
            .expect_err("createElement is tuple-only");
        apply(&mut tree, r#"[["createElement",1,"div"],["setRoot",1]]"#).expect("mount");
        apply(
            &mut tree,
            r#"[{"op":"setClass","id":1,"value":"a"},{"op":"stylesheet.register","sheet":"app","rules":[{"sel":[{"k":"class","v":"a"}],"decls":"color:#ff0000","spec":[0,1,0],"order":0}]}]"#,
        )
        .expect("object-form ops");
        assert_eq!(style_of(&tree, 1).color.as_deref(), Some("#ff0000"));
        apply(
            &mut tree,
            r#"[{"op":"stylesheet.unregister","sheet":"app"}]"#,
        )
        .expect("object-form unregister");
        assert!(style_of(&tree, 1).color.is_none());
    }

    #[test]
    fn a_register_replaces_the_same_sheets_rules() {
        let mut tree = RetainedTree::new();
        div_with_class(&mut tree, "a");
        apply(
            &mut tree,
            &register(
                "app",
                &format!("[{}]", rule(&class("a"), "color:#ff0000", "[0,1,0]", 0)),
            ),
        )
        .expect("register batch");
        // A re-sent sheet is an edit, not an append — the old rules are gone.
        apply(
            &mut tree,
            &register(
                "app",
                &format!("[{}]", rule(&class("a"), "padding:8px", "[0,1,0]", 0)),
            ),
        )
        .expect("re-register batch");
        let style = style_of(&tree, 1);
        assert_eq!(style.padding_top, Some(8.0));
        assert!(style.color.is_none(), "replaced rules must not linger");
    }

    #[test]
    fn a_re_register_un_styles_elements_the_old_rules_reached() {
        let mut tree = RetainedTree::new();
        // No classes on this element — a `div{}` rule still reaches it.
        apply(&mut tree, r#"[["createElement",1,"div"],["setRoot",1]]"#).expect("mount");
        apply(
            &mut tree,
            &register(
                "app",
                &format!("[{}]", rule(&tag("div"), "color:#ff0000", "[1,0,0]", 0)),
            ),
        )
        .expect("register batch");
        assert_eq!(style_of(&tree, 1).color.as_deref(), Some("#ff0000"));
        // Re-registering with class-only rules narrows the sheet: the tag
        // match is gone, and the element must drop the old rule's color even
        // though it carries no classes.
        apply(
            &mut tree,
            &register(
                "app",
                &format!("[{}]", rule(&class("a"), "color:#00ff00", "[0,1,0]", 0)),
            ),
        )
        .expect("re-register batch");
        assert_eq!(tree.sheets.len(), 1, "re-register replaces, not appends");
        assert!(
            style_of(&tree, 1).color.is_none(),
            "the replaced tag rule must un-style classless elements too"
        );
    }

    #[test]
    fn a_malformed_rules_payload_fails_the_batch() {
        let mut tree = RetainedTree::new();
        apply(&mut tree, r#"[["createElement",1,"div"],["setRoot",1]]"#).expect("mount");
        let before = tree.elements[&1].subtree_revision;
        let error = apply(
            &mut tree,
            r#"[["stylesheet.register","app","not-an-array"],["setClass",1,"a"]]"#,
        )
        .expect_err("a malformed rules payload must reject the batch");
        assert!(
            error.contains("stylesheet.register") || error.contains("Batch op 0"),
            "{error}"
        );
        // Atomicity: the setClass behind the bad op must not have applied.
        assert!(tree.elements[&1].classes.is_empty());
        assert_eq!(tree.elements[&1].subtree_revision, before);
    }

    // ── parse_decls ───────────────────────────────────────────────────

    fn fields(decls: &str) -> serde_json::Map<String, serde_json::Value> {
        parse_decls(decls)
    }

    #[test]
    fn decls_expand_box_shorthands() {
        let map = fields("padding:4px 8px");
        assert_eq!(map["paddingTop"], serde_json::json!(4.0));
        assert_eq!(map["paddingRight"], serde_json::json!(8.0));
        assert_eq!(map["paddingBottom"], serde_json::json!(4.0));
        assert_eq!(map["paddingLeft"], serde_json::json!(8.0));
        let map = fields("margin:1px 2px 3px 4px");
        assert_eq!(map["marginTop"], serde_json::json!(1.0));
        assert_eq!(map["marginRight"], serde_json::json!(2.0));
        assert_eq!(map["marginBottom"], serde_json::json!(3.0));
        assert_eq!(map["marginLeft"], serde_json::json!(4.0));
    }

    #[test]
    fn decls_coerce_dimensions_and_numbers() {
        let map = fields("width:50%;height:calc(100% - 20%);font-size:14px;opacity:.5");
        assert_eq!(map["width"], serde_json::json!("50%"));
        assert_eq!(map["height"], serde_json::json!("80%"));
        assert_eq!(map["fontSize"], serde_json::json!(14.0));
        assert_eq!(map["opacity"], serde_json::json!(0.5));
        let map = fields("width:auto;min-width:fit-content");
        assert_eq!(map["width"], serde_json::json!("auto"));
        assert_eq!(map["minWidth"], serde_json::json!("auto"));
    }

    #[test]
    fn decls_normalize_named_colors() {
        let map = fields("color:red;border-color:rgba(0,0,0,0.5)");
        assert_eq!(map["color"], serde_json::json!("#ff0000"));
        assert_eq!(map["borderColor"], serde_json::json!("#00000080"));
        // Palette tokens pass through so the element's theme resolves them.
        let map = fields("color:primary");
        assert_eq!(map["color"], serde_json::json!("primary"));
        // currentColor is load-bearing — never rewritten to a literal.
        let map = fields("color:currentColor");
        assert_eq!(map["color"], serde_json::json!("currentColor"));
    }

    #[test]
    fn decls_drop_unrepresentable_values() {
        let map = fields("background:url(x.png);color:#ff0000;width:clamp(1px,2vw,4px)");
        assert!(map.get("background").is_none(), "url() cannot paint");
        assert!(map.get("width").is_none(), "clamp() cannot resolve");
        assert_eq!(
            map["color"],
            serde_json::json!("#ff0000"),
            "the rule survives"
        );
    }

    #[test]
    fn decls_resolve_local_vars() {
        let map = fields("--pad:8px;padding:var(--pad);width:var(--w, 10%)");
        assert_eq!(map["paddingTop"], serde_json::json!(8.0));
        assert_eq!(map["width"], serde_json::json!("10%"));
        assert!(map.get("--pad").is_none(), "custom props are not emitted");
    }

    #[test]
    fn decls_expand_misc_shorthands() {
        let map = fields("gap:4px 8px");
        assert_eq!(map["rowGap"], serde_json::json!(4.0));
        assert_eq!(map["columnGap"], serde_json::json!(8.0));
        let map = fields("flex:1 0 auto");
        assert_eq!(map["flexGrow"], serde_json::json!(1.0));
        assert_eq!(map["flexShrink"], serde_json::json!(0.0));
        let map = fields("border:1px solid #333");
        assert_eq!(map["borderWidth"], serde_json::json!(1.0));
        assert_eq!(map["borderColor"], serde_json::json!("#333333"));
        let map = fields("grid-template-columns:repeat(3, minmax(0, 1fr))");
        assert_eq!(map["gridTemplateColumns"], serde_json::json!(3.0));
        let map = fields("box-shadow:0 2px 4px rgba(0,0,0,0.4)");
        let member = &map["boxShadow"][0];
        assert_eq!(member["offsetY"], serde_json::json!(2.0));
        assert_eq!(member["blurRadius"], serde_json::json!(4.0));
        assert_eq!(member["color"], serde_json::json!("#00000066"));
    }

    #[test]
    fn decls_apply_the_line_height_multiplier() {
        let map = fields("font-size:10px;line-height:1.5");
        assert_eq!(map["lineHeightScale"], serde_json::json!(1.5));
        assert!(!map.contains_key("lineHeight"));
        let map = fields("line-height:24px");
        assert_eq!(map["lineHeight"], serde_json::json!(24.0));
    }

    #[test]
    fn decls_expand_logical_props() {
        let map = fields("padding-inline:4px;inset-block-start:2px;margin-block:3px 6px");
        assert_eq!(map["paddingLeft"], serde_json::json!(4.0));
        assert_eq!(map["paddingRight"], serde_json::json!(4.0));
        assert_eq!(map["top"], serde_json::json!(2.0));
        assert_eq!(map["marginTop"], serde_json::json!(3.0));
        assert_eq!(map["marginBottom"], serde_json::json!(6.0));
    }

    #[test]
    fn decls_strip_important() {
        let map = fields("color:#ff0000 !important");
        assert_eq!(map["color"], serde_json::json!("#ff0000"));
    }

    // ── combinators, attr selectors, :not() ─────────────────────────────

    fn comb(v: &str) -> String {
        format!(r#"{{"k":"comb","v":"{v}"}}"#)
    }

    fn attr(sel: &str) -> String {
        format!(r#"{{"k":"attr","v":"{sel}"}}"#)
    }

    fn attr_eq(name: &str, value: &str) -> String {
        format!(r#"{{"k":"attr","v":"{name}","op":"=","x":{value}}}"#)
    }

    fn not(inner: &str) -> String {
        format!(r#"{{"k":"not","sel":[{inner}]}}"#)
    }

    fn no_style(tree: &RetainedTree, id: u64) -> bool {
        tree.elements[&id].style.is_none()
            || tree.elements[&id]
                .style
                .as_deref()
                .unwrap()
                .color
                .is_none()
    }

    /// root(1) > marked(2).marked > plain(3) > target(4).t — 4 is a
    /// descendant of .marked but not a direct child.
    fn marked_parent_tree(tree: &mut RetainedTree) {
        apply(
            tree,
            r#"[
                ["createElement",1,"div"],["createElement",2,"div"],["createElement",3,"div"],
                ["createElement",4,"div"],
                ["appendChild",1,2],["appendChild",2,3],["appendChild",3,4],
                ["setClass",2,"marked"],["setClass",4,"t"],
                ["setRoot",1]
            ]"#,
        )
        .expect("mount batch");
    }

    #[test]
    fn descendant_and_child_combinators_match_ancestry() {
        let mut tree = RetainedTree::new();
        marked_parent_tree(&mut tree);
        apply(
            &mut tree,
            &register(
                "app",
                &format!(
                    "[{}]",
                    rule(
                        &format!("{},{},{}", class("marked"), comb(" "), class("t")),
                        "color:#ff0000",
                        "[0,2,0]",
                        0,
                    )
                ),
            ),
        )
        .expect("register batch");
        assert_eq!(style_of(&tree, 4).color.as_deref(), Some("#ff0000"), ".marked .t");
        assert!(no_style(&tree, 2), "the ancestor itself is not the subject");

        // `>` requires the direct parent — 4's parent is plain(3), so a
        // second sheet with `.marked > .t` must not reach it.
        apply(
            &mut tree,
            &register(
                "app2",
                &format!(
                    "[{}]",
                    rule(
                        &format!("{},{},{}", class("marked"), comb(">"), class("t")),
                        "color:#00ff00",
                        "[0,2,0]",
                        1,
                    )
                ),
            ),
        )
        .expect("register batch");
        assert_eq!(
            style_of(&tree, 4).color.as_deref(),
            Some("#ff0000"),
            "child combinator must not match across an intermediate parent"
        );
    }

    #[test]
    fn descendant_matching_backtracks_to_a_further_ancestor() {
        // `.a .b .c`: two `.b` ancestors — only the farther has `.a` above
        // it. Greedy nearest-pick would miss; backtracking must find it.
        let mut tree = RetainedTree::new();
        apply(
            &mut tree,
            r#"[
                ["createElement",1,"div"],["createElement",2,"div"],["createElement",3,"div"],
                ["createElement",4,"div"],["createElement",5,"div"],
                ["appendChild",1,2],["appendChild",2,3],["appendChild",3,4],["appendChild",4,5],
                ["setClass",1,"a"],["setClass",2,"b"],["setClass",4,"b"],["setClass",5,"c"],
                ["setRoot",1]
            ]"#,
        )
        .expect("mount batch");
        apply(
            &mut tree,
            &register(
                "app",
                &format!(
                    "[{}]",
                    rule(
                        &format!(
                            "{},{},{},{},{}",
                            class("a"),
                            comb(" "),
                            class("b"),
                            comb(" "),
                            class("c")
                        ),
                        "color:#ff0000",
                        "[0,3,0]",
                        0,
                    )
                ),
            ),
        )
        .expect("register batch");
        assert_eq!(
            style_of(&tree, 5).color.as_deref(),
            Some("#ff0000"),
            "backtracking: farther .b carries the .a ancestor"
        );
    }

    #[test]
    fn sibling_combinators_match_positions() {
        // root > x(2).x, mid(3), y(4).y — `.x + .y` misses (mid between),
        // `.x ~ .y` hits.
        let mut tree = RetainedTree::new();
        apply(
            &mut tree,
            r#"[
                ["createElement",1,"div"],["createElement",2,"div"],["createElement",3,"div"],
                ["createElement",4,"div"],
                ["appendChild",1,2],["appendChild",1,3],["appendChild",1,4],
                ["setClass",2,"x"],["setClass",4,"y"],
                ["setRoot",1]
            ]"#,
        )
        .expect("mount batch");
        apply(
            &mut tree,
            &register(
                "app",
                &format!(
                    "[{},{}]",
                    rule(
                        &format!("{},{},{}", class("x"), comb("~"), class("y")),
                        "color:#ff0000",
                        "[0,2,0]",
                        0,
                    ),
                    rule(
                        &format!("{},{},{}", class("x"), comb("+"), class("y")),
                        "padding:9px",
                        "[0,2,0]",
                        1,
                    ),
                ),
            ),
        )
        .expect("register batch");
        assert_eq!(style_of(&tree, 4).color.as_deref(), Some("#ff0000"), ".x ~ .y");
        assert_eq!(
            style_of(&tree, 4).padding_top,
            None,
            ".x + .y must not match across an intervening sibling"
        );
        // Reorder mid out from between them — now adjacent, `+` applies.
        apply(&mut tree, r#"[["moveBefore",1,3,null]]"#).expect("reorder");
        assert_eq!(style_of(&tree, 4).padding_top, Some(9.0), "adjacent after reorder");
    }

    #[test]
    fn attribute_selectors_match_props() {
        let mut tree = RetainedTree::new();
        apply(
            &mut tree,
            r#"[
                ["createElement",1,"div"],["createElement",2,"div"],["createElement",3,"div"],
                ["appendChild",1,2],["appendChild",1,3],["setRoot",1],
                ["setCustomProp",2,"data-open",true],
                ["setCustomProp",3,"data-open",false],
                ["setCustomProp",2,"tabIndex",0]
            ]"#,
        )
        .expect("mount batch");
        apply(
            &mut tree,
            &register(
                "app",
                &format!(
                    "[{},{},{}]",
                    rule(&attr("data-open"), "color:#ff0000", "[0,1,0]", 0),
                    rule(&attr_eq("data-open", "true"), "padding:3px", "[0,1,0]", 1),
                    rule(&attr_eq("tabIndex", "0"), "margin:5px", "[0,1,0]", 2),
                ),
            ),
        )
        .expect("register batch");
        assert_eq!(style_of(&tree, 2).color.as_deref(), Some("#ff0000"), "presence");
        assert_eq!(style_of(&tree, 2).padding_top, Some(3.0), "string '=' matches bool true");
        assert_eq!(style_of(&tree, 2).margin_top, Some(5.0), "number '=' matches number");
        // data-open=false is still PRESENT — presence matches; '=' does not.
        assert_eq!(style_of(&tree, 3).color.as_deref(), Some("#ff0000"), "false ≠ absent");
        assert_eq!(style_of(&tree, 3).padding_top, None);
    }

    #[test]
    fn attr_change_retests_the_selector() {
        let mut tree = RetainedTree::new();
        apply(
            &mut tree,
            r#"[
                ["createElement",1,"div"],["createElement",2,"div"],
                ["appendChild",1,2],["setClass",2,"t"],["setRoot",1]
            ]"#,
        )
        .expect("mount batch");
        apply(
            &mut tree,
            &register(
                "app",
                &format!(
                    "[{}]",
                    rule(
                        &format!("{},{},{}", attr("data-open"), comb(" "), class("t")),
                        "color:#ff0000",
                        "[0,2,0]",
                        0,
                    )
                ),
            ),
        )
        .expect("register batch");
        assert!(no_style(&tree, 2), "no data-open yet");
        apply(&mut tree, r#"[["setCustomProp",1,"data-open",true]]"#).expect("attr set");
        assert_eq!(style_of(&tree, 2).color.as_deref(), Some("#ff0000"), "ancestor attr set");
        apply(&mut tree, r#"[["setCustomProp",1,"data-open",null]]"#).expect("attr removed");
        assert!(no_style(&tree, 2), "ancestor attr removed retracts");
    }

    #[test]
    fn reparent_and_class_flips_restyle_combinator_matches() {
        let mut tree = RetainedTree::new();
        marked_parent_tree(&mut tree);
        apply(
            &mut tree,
            &register(
                "app",
                &format!(
                    "[{}]",
                    rule(
                        &format!("{},{},{}", class("marked"), comb(" "), class("t")),
                        "color:#ff0000",
                        "[0,2,0]",
                        0,
                    )
                ),
            ),
        )
        .expect("register batch");
        assert_eq!(style_of(&tree, 4).color.as_deref(), Some("#ff0000"));

        // Move target under the unmarked parent — match must retract.
        apply(&mut tree, r#"[["moveBefore",1,4,null]]"#).expect("reparent to root");
        assert!(no_style(&tree, 4), "moved out from under .marked");

        // Back under marked(2) — match returns.
        apply(&mut tree, r#"[["moveBefore",2,4,null]]"#).expect("reparent under marked");
        assert_eq!(style_of(&tree, 4).color.as_deref(), Some("#ff0000"));

        // Class flip on the ANCESTOR restyles the descendant.
        apply(&mut tree, r#"[["setClass",2,""]]"#).expect("unmark");
        assert!(no_style(&tree, 4), "ancestor lost .marked");
        apply(&mut tree, r#"[["setClass",2,"marked"]]"#).expect("remark");
        assert_eq!(style_of(&tree, 4).color.as_deref(), Some("#ff0000"));
    }

    #[test]
    fn not_compound_negates() {
        let mut tree = RetainedTree::new();
        apply(
            &mut tree,
            r#"[
                ["createElement",1,"div"],["createElement",2,"div"],["createElement",3,"div"],
                ["appendChild",1,2],["appendChild",1,3],
                ["setClass",2,"btn"],["setClass",3,"btn disabled"],
                ["setRoot",1]
            ]"#,
        )
        .expect("mount batch");
        apply(
            &mut tree,
            &register(
                "app",
                &format!(
                    "[{}]",
                    rule(
                        &format!("{},{}", class("btn"), not(&class("disabled"))),
                        "color:#ff0000",
                        "[0,2,0]",
                        0,
                    )
                ),
            ),
        )
        .expect("register batch");
        assert_eq!(style_of(&tree, 2).color.as_deref(), Some("#ff0000"), ".btn:not(.disabled)");
        assert!(no_style(&tree, 3), ".disabled excluded");
    }

    #[test]
    fn invalid_selector_shapes_drop_the_rule() {
        let mut tree = RetainedTree::new();
        // 1(.a) > 2(.b): if `.a:hover .b` ignored the state comp instead of
        // dropping, the .a ancestor would match and 2 would gain a style.
        apply(
            &mut tree,
            r#"[
                ["createElement",1,"div"],["createElement",2,"div"],
                ["appendChild",1,2],["setClass",1,"a"],["setClass",2,"b"],
                ["setRoot",1]
            ]"#,
        )
        .expect("mount batch");
        // state comp on a non-subject compound, a trailing combinator, and a
        // state inside :not() — each must drop rather than mis-apply.
        apply(
            &mut tree,
            &register(
                "app",
                &format!(
                    "[{},{},{}]",
                    rule(
                        &format!(
                            "{},{},{},{}",
                            class("a"),
                            state("hover"),
                            comb(" "),
                            class("b")
                        ),
                        "color:#ff0000",
                        "[0,3,0]",
                        0,
                    ),
                    rule(
                        &format!("{},{}", class("b"), comb(">")),
                        "color:#ff0000",
                        "[0,1,0]",
                        1,
                    ),
                    rule(
                        &format!("{},{}", class("a"), not(&state("hover"))),
                        "color:#ff0000",
                        "[0,2,0]",
                        2,
                    ),
                ),
            ),
        )
        .expect("register batch");
        assert!(no_style(&tree, 2), "ancestor-state rule dropped");
        assert!(no_style(&tree, 1), "malformed rules dropped");
    }
}
