/// `Recipe` — the CVA engine for native elements.
///
/// Same config shape and resolution order as `gpuix-poc/src/nkit/recipe.js`:
/// base → variants in declaration order → compoundVariants → defaults fill.
/// A component authored as a custom element declares its recipe in Rust, the
/// wire carries only variant *names* (`setCustomProp(id, "variant", "danger")`
/// — ~30 bytes), and resolution produces a `StyleDesc` natively.
///
/// Resolution results are cached per effective-variant tuple: render() runs
/// every frame, so steady-state cost is one hash lookup, not a re-parse.
/// Nested `hover`/`active` objects ride inside the style JSON and are applied
/// by `apply_interactive_styles`, exactly like a resolved JS `setStyle`.
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use crate::style::StyleDesc;

/// One recipe config: `{ base, variants, defaultVariants, compoundVariants }`.
pub struct Recipe {
    base: serde_json::Value,
    /// (variant key, [(value token, style)]) in declaration order — order is
    /// significant, later variants overwrite earlier ones (svelai's CVA
    /// resolves in authored key order).
    variants: Vec<(String, Vec<(String, serde_json::Value)>)>,
    /// (conditions, style) — style applies when every condition matches.
    compounds: Vec<(Vec<(String, Vec<String>)>, serde_json::Value)>,
    defaults: HashMap<String, String>,
    /// Effective-variant tuple → resolved style. Elements are main-thread only.
    cache: RefCell<HashMap<String, Arc<ResolvedStyle>>>,
    /// (ctx, effective tuple) → merged symbolic JSON. Theme-free by
    /// construction — `merged_json` never resolves tokens — so entries stay
    /// valid across theme swaps while `cache` keys on the theme id.
    merged_cache: RefCell<HashMap<String, Arc<serde_json::Value>>>,
}

/// What an element paints: the resolved style plus recipe-level flags that
/// live outside `StyleDesc` (the `stateLayer` overlay).
#[derive(Debug, Clone)]
pub struct ResolvedStyle {
    pub style: Arc<StyleDesc>,
    /// `stateLayer: true` appeared in the merged recipe — paint a currentColor
    /// overlay at the theme's hover/pressed opacities.
    pub state_layer: bool,
}

impl Recipe {
    /// Parse a recipe.js-shaped config. Variant groups and their entries keep
    /// authored declaration order (serde_json `preserve_order`), matching
    /// svelai's CVA exactly.
    pub fn from_json(config: &serde_json::Value) -> Result<Self, String> {
        let obj = |key: &str| config.get(key).cloned().unwrap_or(serde_json::Value::Null);

        let mut variants: Vec<(String, Vec<(String, serde_json::Value)>)> = Vec::new();
        if let serde_json::Value::Object(table) = obj("variants") {
            for (key, entries) in &table {
                let mut values = Vec::new();
                if let serde_json::Value::Object(entries) = entries {
                    for (value_key, style) in entries {
                        values.push((value_key.clone(), style.clone()));
                    }
                }
                variants.push((key.clone(), values));
            }
        }

        let mut compounds = Vec::new();
        if let serde_json::Value::Array(list) = obj("compoundVariants") {
            for entry in list {
                let serde_json::Value::Object(map) = entry else {
                    continue;
                };
                let Some(style) = map.get("style").cloned() else {
                    continue;
                };
                let mut conds = Vec::new();
                for (key, value) in map {
                    if key == "style" {
                        continue;
                    }
                    let tokens = match value {
                        serde_json::Value::Array(items) => {
                            items.iter().map(variant_token).collect()
                        }
                        other => vec![variant_token(&other)],
                    };
                    conds.push((key.clone(), tokens));
                }
                compounds.push((conds, style.clone()));
            }
        }

        let mut defaults = HashMap::new();
        if let serde_json::Value::Object(map) = obj("defaultVariants") {
            for (key, value) in map {
                defaults.insert(key.clone(), variant_token(&value));
            }
        }

        Ok(Self {
            base: obj("base"),
            variants,
            compounds,
            defaults,
            cache: RefCell::new(HashMap::new()),
            merged_cache: RefCell::new(HashMap::new()),
        })
    }

    /// Variant keys this recipe resolves — the props `set_prop` should route.
    pub fn variant_keys(&self) -> impl Iterator<Item = &str> {
        self.variants.iter().map(|(key, _)| key.as_str())
    }

    pub fn handles(&self, key: &str) -> bool {
        self.variants.iter().any(|(k, _)| k == key)
    }

    /// Whether `key`'s declared entries are exactly the boolean pair —
    /// boolean axes give a bare `prop=""` HTML-presence semantics (`true`).
    pub fn is_bool_axis(&self, key: &str) -> bool {
        self.variants
            .iter()
            .find(|(k, _)| k == key)
            .is_some_and(|(_, entries)| {
                !entries.is_empty()
                    && entries
                        .iter()
                        .all(|(token, _)| token == "true" || token == "false")
            })
    }

    /// Resolve the current variant props to a style, against `tokens`.
    /// Cache hit on every previously seen (tuple, theme, ctx color) — the
    /// Merge base → variants → compounds into the *symbolic* field map —
    /// token refs stay unresolved. The merge is theme-independent (resolution
    /// is `resolve_style`'s job), so this cache keys on (ctx, effective
    /// tuple) alone and survives theme swaps. The element-layer path resolves
    /// the merged map once, after composing all layers.
    ///
    /// `ctx_color` is the effective `color` ctx (element prop → inherited →
    /// theme `defaultColor`); it also participates in compound matching, so
    /// `{color: 'neutral', variant: 'outline'}` compounds work like svelai's.
    pub fn merged_json(
        &self,
        props: &HashMap<String, String>,
        tokens: &crate::tokens::TokenTheme,
        ctx_color: Option<&str>,
    ) -> Arc<serde_json::Value> {
        // svelai's falsyToString: empty/false/absent props fall back to
        // defaults; a compound sees the *effective* tuple including ctx color.
        let effective = |key: &str| -> Option<&str> {
            props
                .get(key)
                .map(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .or_else(|| self.defaults.get(key).map(|v| v.as_str()))
        };
        let ctx = ctx_color.unwrap_or(&tokens.default_color);

        let mut cache_key = String::with_capacity(64);
        cache_key.push_str(ctx);
        for (key, _) in &self.variants {
            cache_key.push('\u{1f}');
            if let Some(value) = effective(key) {
                cache_key.push_str(key);
                cache_key.push('=');
                cache_key.push_str(value);
            }
        }
        if let Some(hit) = self.merged_cache.borrow().get(&cache_key) {
            return hit.clone();
        }

        let mut out = self.base.clone();
        let mut eff: HashMap<&str, &str> = HashMap::new();
        eff.insert("color", ctx);
        for (key, table) in &self.variants {
            let Some(value) = effective(key) else {
                continue;
            };
            eff.insert(key.as_str(), value);
            for (token, style) in table {
                if token == value {
                    merge(&mut out, style);
                }
            }
        }
        for (conds, style) in &self.compounds {
            let matches = conds.iter().all(|(key, tokens)| {
                eff.get(key.as_str())
                    .is_some_and(|value| tokens.iter().any(|t| t == value))
            });
            if matches {
                merge(&mut out, style);
            }
        }

        let merged = Arc::new(out);
        self.merged_cache
            .borrow_mut()
            .insert(cache_key, merged.clone());
        merged
    }

    /// Resolve a variant tuple to a `StyleDesc` — the custom-element path,
    /// where the recipe's symbolic merge is resolved straight through.
    /// Cached on (theme, ctx, effective tuple): the `key="value"` tuples
    /// spell the compound-matching input verbatim, so the common case is
    /// zero work beyond building the key string.
    pub fn style(
        &self,
        props: &HashMap<String, String>,
        tokens: &crate::tokens::TokenTheme,
        ctx_color: Option<&str>,
    ) -> Arc<ResolvedStyle> {
        let effective = |key: &str| -> Option<&str> {
            props
                .get(key)
                .map(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .or_else(|| self.defaults.get(key).map(|v| v.as_str()))
        };
        let ctx = ctx_color.unwrap_or(&tokens.default_color);

        let mut cache_key = String::with_capacity(64);
        cache_key.push_str(&tokens.id.to_string());
        cache_key.push('\u{1f}');
        cache_key.push_str(ctx);
        for (key, _) in &self.variants {
            cache_key.push('\u{1f}');
            if let Some(value) = effective(key) {
                cache_key.push_str(key);
                cache_key.push('=');
                cache_key.push_str(value);
            }
        }
        if let Some(hit) = self.cache.borrow().get(&cache_key) {
            return hit.clone();
        }

        let mut out = self.merged_json(props, tokens, ctx_color).as_ref().clone();
        let outcome = tokens.resolve_style(&mut out, ctx_color);
        let resolved = Arc::new(ResolvedStyle {
            style: Arc::new(serde_json::from_value(out).unwrap_or_else(|error| {
                log::warn!("recipe produced invalid style: {error}");
                StyleDesc::default()
            })),
            state_layer: outcome.state_layer,
        });
        self.cache.borrow_mut().insert(cache_key, resolved.clone());
        resolved
    }
}

impl std::fmt::Debug for Recipe {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Recipe").finish_non_exhaustive()
    }
}

/// JSON prop value → variant token. Mirrors recipe.js's `String(v)` coercion:
/// `true` → "true", `2` → "2", strings pass through, null/absent → "".
pub fn variant_token(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

/// `mergeProps` semantics: objects merge key-wise recursively (so `hover`
/// substyles accumulate), everything else is last-write-wins. Null contributes
/// nothing — a `null` variant entry is a ctx marker, not a style.
pub(crate) fn merge(dst: &mut serde_json::Value, src: &serde_json::Value) {
    match (dst, src) {
        (serde_json::Value::Object(dst), serde_json::Value::Object(src)) => {
            for (key, value) in src {
                match dst.get_mut(key) {
                    Some(slot) => merge(slot, value),
                    None => {
                        dst.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (slot, serde_json::Value::Null) => {
            let _ = slot;
        }
        (slot, value) => *slot = value.clone(),
    }
}

/// Merge `src`'s top-level fields into `dst` — the same key-wise recursion as
/// `merge`, lifted one level so the batch path can compose an element's style
/// layers (desc → recipe → props) into one symbolic map.
pub(crate) fn merge_fields(
    dst: &mut serde_json::Map<String, serde_json::Value>,
    src: &serde_json::Map<String, serde_json::Value>,
) {
    for (key, value) in src {
        match dst.get_mut(key) {
            Some(slot) => merge(slot, value),
            None => {
                dst.insert(key.clone(), value.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tokens::TokenTheme;
    use serde_json::json;

    fn recipe() -> Recipe {
        Recipe::from_json(&json!({
            "base": { "display": "flex", "borderRadius": 6 },
            "variants": {
                "variant": {
                    "primary": { "backgroundColor": "#4f6ef7" },
                    "danger": { "backgroundColor": "#d64545" }
                },
                "disabled": {
                    "true": { "opacity": 0.55 },
                    "false": null
                }
            },
            "defaultVariants": { "variant": "primary", "disabled": false },
            "compoundVariants": [
                { "variant": "danger", "disabled": "true",
                  "style": { "backgroundColor": "#803030" } }
            ]
        }))
        .unwrap()
    }

    #[test]
    fn defaults_apply_and_variants_layer() {
        let recipe = recipe();
        let resolved = recipe.style(&HashMap::new(), &TokenTheme::dark(), None);
        assert_eq!(resolved.style.background_color.as_deref(), Some("#4f6ef7"));
        assert_eq!(resolved.style.opacity, None);

        let props = HashMap::from([("variant".to_string(), "danger".to_string())]);
        let resolved = recipe.style(&props, &TokenTheme::dark(), None);
        assert_eq!(resolved.style.background_color.as_deref(), Some("#d64545"));
    }

    #[test]
    fn compound_variants_and_null_entries() {
        let recipe = recipe();
        let props = HashMap::from([
            ("variant".to_string(), "danger".to_string()),
            ("disabled".to_string(), "true".to_string()),
        ]);
        let resolved = recipe.style(&props, &TokenTheme::dark(), None);
        assert_eq!(resolved.style.background_color.as_deref(), Some("#803030"));
        assert_eq!(resolved.style.opacity, Some(0.55));
    }

    #[test]
    fn nested_substyles_merge_keywise() {
        let recipe = Recipe::from_json(&json!({
            "base": { "hover": { "backgroundColor": "#111111" } },
            "variants": { "v": { "a": { "hover": { "color": "#ffffff" } } } },
            "defaultVariants": { "v": "a" }
        }))
        .unwrap();
        let resolved = recipe.style(&HashMap::new(), &TokenTheme::dark(), None);
        let hover = resolved.style.hover.as_deref().unwrap();
        assert_eq!(hover.background_color.as_deref(), Some("#111111"));
        assert_eq!(hover.color.as_deref(), Some("#ffffff"));
    }

    #[test]
    fn cache_returns_same_arc() {
        let recipe = recipe();
        let theme = TokenTheme::dark();
        let a = recipe.style(&HashMap::new(), &theme, None);
        let b = recipe.style(&HashMap::new(), &theme, None);
        assert!(Arc::ptr_eq(&a.style, &b.style));
    }
}
