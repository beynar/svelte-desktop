/// Retained element tree — the Rust-side source of truth for the UI.
///
/// React's reconciler sends mutations (create, append, remove, etc.) via napi.
/// This tree stores those mutations. GpuixView builds ephemeral GPUI elements
/// from it, while virtual lists defer offscreen subtrees until layout requests them.
///
/// All IDs are u64 — JS generates them with an incrementing counter,
/// passes them as numbers across napi (no string allocation).
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use crate::style::StyleDesc;

pub struct RetainedElement {
    pub id: u64,
    pub element_type: String,
    /// Shared, not owned. `StyleDesc` is ~1.4 KB, and holding it inline made an
    /// unstyled element pay for a style it does not have: `RetainedElement` was
    /// 1624 bytes, and the `HashMap` stores values inline, so the whole table
    /// was that wide. Behind an `Arc` the record is 248 bytes.
    ///
    /// The pointer is also shared between every element that declared the same
    /// style. A 10k-turn chat has 59 320 `setStyle` ops and 90 distinct styles.
    ///
    /// Read it with `.as_deref()` to get `Option<&StyleDesc>`. Never mutate
    /// through it; `Arc` has no `DerefMut`, so the compiler enforces that.
    pub style: Option<Arc<StyleDesc>>,
    /// The pre-resolution token JSON for `style`, kept so a `theme`/`color`
    /// prop change or a reparent can re-resolve it under the new ancestor
    /// chain — the interned `StyleDesc` alone has already forgotten the tokens.
    pub style_raw: Option<Box<str>>,
    /// Pre-mapping StyleProps payload from `setStyleProps` — the third style
    /// layer, applied over the desc and recipe layers. Retained symbolic for
    /// the same retheme reasons as `style_raw`.
    pub props_raw: Option<Box<str>>,
    /// Recipe binding from `setRecipe`: variant names only — the style
    /// resolution itself happens natively against `RetainedTree::recipes`.
    pub recipe: Option<RecipeBinding>,
    /// Class tokens from `setClass` — the selector-match input for the
    /// native stylesheet engine. Each op replaces the list wholesale.
    pub classes: Vec<String>,
    pub content: Option<String>,
    pub events: HashSet<String>,
    pub children: Vec<u64>,
    pub parent: Option<u64>,
    /// Props for custom elements (input, editor, diff, etc.).
    /// Keyed by prop name, values are JSON. Ignored for "div" and "text".
    pub custom_props: HashMap<String, serde_json::Value>,
    /// Take keyboard focus the first time this element gets a focus handle.
    /// Without it an `<input>` is dead until the user clicks it.
    pub auto_focus: bool,
    /// Last mutation applied to this element or one of its descendants.
    pub subtree_revision: u64,
    /// Last change to the searchable TEXT of this subtree: content, structure,
    /// or the set of nested `highlight` declarations.
    ///
    /// Separate from `subtree_revision` because `highlight` is itself a custom
    /// prop: keying the group cache on the general revision means every find-bar
    /// keystroke re-walks and re-folds the whole subtree, which is the one case
    /// the cache exists for. Style, `activeIndex`, colours and a native
    /// element's own props never move this.
    pub search_revision: u64,
    /// Stable locator id from the React `testId` prop.
    pub test_id: Option<String>,
    /// Lazily-computed memoization candidacy for the subtree rooted here,
    /// cached so `build_element` does not re-walk it every frame. Keyed by
    /// `subtree_revision`; `None` means "not computed since the last mutation".
    pub memo_scan: std::cell::Cell<Option<(u64, MemoScan)>>,
}

/// Subtree-wide facts the renderer needs before it can hand a subtree to a
/// cached GPUI view. Computed by `RetainedTree::memo_scan`, invalidated by
/// `subtree_revision` like every other fact about the subtree.
#[derive(Clone, Copy)]
pub struct MemoScan {
    /// Retained elements in the subtree, root included.
    pub len: u32,
    /// `MEMO_*` disqualifiers — any set flag forbids caching the subtree.
    pub flags: u8,
}

/// A custom element lives in the subtree. The renderer's per-element registry
/// instances and their paint-time state cannot be replayed from a cached
/// paint range.
pub const MEMO_HAS_CUSTOM: u8 = 1;
/// A `motion` prop lives in the subtree. Motion is sampled per frame during
/// the build walk, so a cached subtree would freeze the animation.
pub const MEMO_HAS_MOTION: u8 = 2;
/// A `virtual-list` lives in the subtree. Rows are built lazily outside the
/// render pass, so their registration order cannot be frozen.
pub const MEMO_HAS_VLIST: u8 = 4;
/// A pointer-capturing element lives in the subtree (`mouseDown`+`mouseMove`
/// get `capture_pointer`). GPUI rebinds `captured_hitbox` inside
/// `insert_hitbox`, which a replayed prepaint range never calls — caching the
/// subtree would drop the capture on the frame after the mousedown.
pub const MEMO_HAS_CAPTURE: u8 = 8;
/// An element with event listeners lives in the subtree. Interactive content
/// flips style on input; every flip bumps `subtree_revision` and forces a
/// live frame plus a fresh entity, so the cached leaf only ever serves the
/// transition frames — exactly where live/leaf paint can visibly diverge.
pub const MEMO_HAS_EVENTS: u8 = 16;

impl RetainedElement {
    pub fn new(id: u64, element_type: String, revision: u64) -> Self {
        Self {
            id,
            element_type,
            style: None,
            style_raw: None,
            props_raw: None,
            recipe: None,
            classes: Vec::new(),
            content: None,
            events: HashSet::new(),
            children: Vec::new(),
            parent: None,
            auto_focus: false,
            subtree_revision: revision,
            search_revision: revision,
            test_id: None,
            custom_props: HashMap::new(),
            memo_scan: std::cell::Cell::new(None),
        }
    }
}

/// A `setRecipe` binding on a generic element: the JS `recipe()` callable
/// shipped the variant choice, Rust resolves the tuple natively against the
/// live theme chain.
#[derive(Debug, Clone)]
pub struct RecipeBinding {
    pub name: Box<str>,
    /// Variant axis → chosen value. Missing axes fall back to the recipe's
    /// `defaultVariants` at resolve time.
    pub variants: HashMap<String, String>,
    /// StyleProps fragment merged over the recipe result — the `style` escape
    /// hatch. Retained symbolic so retheme re-resolves it.
    pub extra: Option<Box<str>>,
}

/// The element map, keyed by the u64 counter JS allocates.
///
/// Deliberately not the std hasher. `mark_changed` probes this map once per
/// ancestor hop on every append, insert, style and text mutation, and
/// `build_virtual_list` probes it twice per child on every frame. The keys come
/// from our own counter, never from user input, so SipHash only costs time.
pub type ElementMap = rustc_hash::FxHashMap<u64, RetainedElement>;

/// One hash-consed style: the raw JSON that produced it, and the shared value.
///
/// The raw bytes are kept so a hash hit can be confirmed by comparing content.
/// A 64-bit hash collides eventually, and a collision here would paint one
/// element with another element's style, which is a bug nobody would find.
struct InternedStyle {
    raw: Box<[u8]>,
    style: Arc<StyleDesc>,
}

/// Below this many entries a sweep is not worth thinking about, so the table
/// never sweeps on a small app just because it grew from one style to two.
pub(crate) const STYLE_SWEEP_FLOOR: usize = 64;

/// Styles shared by content. Keyed by a hash of the raw payload, with a bucket
/// per key so collisions are resolved by comparing bytes.
///
/// Interning happens here, on arrival, rather than in the protocol. JS cannot
/// do it safely: `commitUpdate` resends the full style on every commit, and a
/// dragged element produces a distinct style every frame, so a JS-owned table
/// would grow without bound and the update path would send a definition plus a
/// reference where it sends one op today.
///
/// Separate from the element tree so `resolve_styles` can borrow it alone. That
/// is what makes a batch atomic: interning is the only fallible step, and the
/// borrow checker proves it cannot have touched an element.
#[derive(Default)]
pub struct StyleTable {
    entries: rustc_hash::FxHashMap<u64, Vec<InternedStyle>>,
    /// Entries currently held. Tracked rather than summed, so `maybe_sweep` is
    /// O(1) on the commits that do not sweep.
    count: usize,
    /// `count` right after the last sweep.
    swept_at: usize,
}

impl StyleTable {
    /// Parse a style payload, reusing the shared value when the same bytes
    /// arrived before. Hashing ~110 bytes is far cheaper than building the
    /// ~80 `Option` fields of a `StyleDesc`.
    pub fn intern(&mut self, raw: &[u8]) -> Result<Arc<StyleDesc>, String> {
        let mut hasher = rustc_hash::FxHasher::default();
        raw.hash(&mut hasher);
        let key = hasher.finish();
        if let Some(bucket) = self.entries.get(&key) {
            if let Some(hit) = bucket.iter().find(|entry| &*entry.raw == raw) {
                return Ok(hit.style.clone());
            }
        }
        let style: StyleDesc = serde_json::from_slice(raw).map_err(|error| error.to_string())?;
        let shared = Arc::new(style);
        self.entries.entry(key).or_default().push(InternedStyle {
            raw: raw.into(),
            style: shared.clone(),
        });
        self.count += 1;
        Ok(shared)
    }

    /// Drop interned styles no element references any more.
    ///
    /// This is what makes the table safe on an interactive app. A drag creates
    /// one style per frame; each is released once the element stops referencing
    /// it. `strong_count == 1` means the table holds the last reference, so
    /// nothing can be reading it.
    pub fn sweep(&mut self) {
        let mut live = 0;
        self.entries.retain(|_, bucket| {
            bucket.retain(|entry| Arc::strong_count(&entry.style) > 1);
            live += bucket.len();
            !bucket.is_empty()
        });
        self.count = live;
        self.swept_at = live;
    }

    /// Sweep when the table has grown, or when the tree has shrunk under it.
    ///
    /// Growth alone is not enough. After a large mount `swept_at` is large, so
    /// destroying the root or remounting a smaller app leaves `count` below the
    /// next threshold forever, and the whole high-water table stays resident.
    /// Re-interning an existing style does not raise `count`, so nothing would
    /// ever reclaim it.
    ///
    /// `live_elements` closes that. A live style needs at least one element
    /// holding it, so the live style count can never exceed the element count;
    /// a table far larger than the tree is therefore mostly dead. After a sweep
    /// `count <= live_elements`, so this cannot thrash.
    ///
    /// Both arms are amortized: each scan is O(entries) and follows at least as
    /// many interns or as large a collapse.
    pub fn maybe_sweep(&mut self, live_elements: usize) {
        let grew = self.count >= self.swept_at.saturating_mul(2).max(STYLE_SWEEP_FLOOR);
        let tree_shrank = self.count > live_elements.saturating_mul(2).max(STYLE_SWEEP_FLOOR);
        if grew || tree_shrank {
            self.sweep();
        }
    }

    pub fn len(&self) -> usize {
        self.count
    }
}

pub struct RetainedTree {
    pub elements: ElementMap,
    pub styles: StyleTable,
    /// Recipes registered by `registerRecipe` batch ops — the CVA engine is
    /// native, so the wire carries variant names, not resolved styles.
    pub recipes: rustc_hash::FxHashMap<Box<str>, crate::recipe::Recipe>,
    /// Sheets registered by `stylesheet.register` — the native CSS rule
    /// table that `setClass` tokens, tags and `id` props match against.
    pub sheets: crate::stylesheet::StyleSheetRegistry,
    /// Root element IDs per window — `setRoot` binds a subtree to a window.
    /// Window 0 is the primary window `GpuixRenderer.init` opens; further
    /// ids come from `window.create` platform ops.
    pub roots: std::collections::BTreeMap<u32, u64>,
    /// App-level theme declaration set by the `setTheme` op — seeds every
    /// element's ancestor fold below any element-level `theme` custom props,
    /// so no element needs to carry it.
    pub theme_decl: Option<serde_json::Value>,
    /// Event types the app delegated to a root/document listener
    /// (`setDelegatedEvents`, gpuix names). Native dispatch attaches for these
    /// on every element — the JS side walks the hit element's ancestor chain
    /// itself — so no per-element `setEventListener` op is ever needed for
    /// them. Focus-scoped types (key/focus) never land here: they stay
    /// element-marked so `needs_focus` and focus subscriptions keep working.
    pub delegated_events: HashSet<String>,
    next_revision: u64,
}

impl RetainedTree {
    pub fn new() -> Self {
        Self {
            elements: ElementMap::default(),
            styles: StyleTable::default(),
            recipes: rustc_hash::FxHashMap::default(),
            sheets: crate::stylesheet::StyleSheetRegistry::default(),
            roots: std::collections::BTreeMap::new(),
            theme_decl: None,
            delegated_events: HashSet::new(),
            next_revision: 1,
        }
    }

    /// The primary window's root — every pre-multi-window reader means this.
    pub fn root_id(&self) -> Option<u64> {
        self.root_id_in(0)
    }

    /// The root bound to `window_id` — what a `GpuixView` renders.
    pub fn root_id_in(&self, window_id: u32) -> Option<u64> {
        self.roots.get(&window_id).copied()
    }

    /// The window whose root subtree contains `id`, if it is reachable from
    /// any window root. Detached subtrees resolve to `None` — they are
    /// invisible, so nothing needs repainting for them.
    pub fn window_of(&self, id: u64) -> Option<u32> {
        let mut current = id;
        loop {
            for (window_id, root_id) in &self.roots {
                if *root_id == current {
                    return Some(*window_id);
                }
            }
            match self.elements.get(&current).and_then(|element| element.parent) {
                Some(parent) => current = parent,
                None => return None,
            }
        }
    }

    pub fn create_element(&mut self, id: u64, element_type: String) {
        let revision = self.take_revision();
        self.elements
            .insert(id, RetainedElement::new(id, element_type, revision));
    }

    /// Does a native event of `name` dispatch for `element` — either a
    /// per-element listener or a type the app delegated (a root-level
    /// listener semantically covers every element, so the tree-level set
    /// answers for it). Text never answers for the delegated set: DOM text
    /// nodes aren't event targets — a press on text must report the
    /// containing element as the deepest emit, or JS-side activation walks
    /// (`<a href>`, submit buttons) see a non-element target and bail.
    pub fn dispatches(&self, element: &RetainedElement, name: &str) -> bool {
        if element.element_type == "text" {
            return element.events.contains(name);
        }
        element.events.contains(name) || self.delegated_events.contains(name)
    }

    fn take_revision(&mut self) -> u64 {
        let revision = self.next_revision;
        self.next_revision = self.next_revision.wrapping_add(1).max(1);
        revision
    }

    /// Monotonic mutation counter — every mark_* path takes one, so readers
    /// can skip tree-wide work when nothing changed since their last pass.
    pub fn revision(&self) -> u64 {
        self.next_revision
    }

    /// Drop every cached fact keyed on `subtree_revision` — memo scans and
    /// memoized subtree views — by re-marking every element. Rendering truth
    /// only: searchable text is untouched. Used when a tree-level input the
    /// per-element revision doesn't observe changes (the delegated set).
    pub fn invalidate_render_caches(&mut self) {
        let revision = self.take_revision();
        for element in self.elements.values_mut() {
            element.subtree_revision = revision;
        }
    }

    /// Invalidate `id` and its ancestors, including their searchable text.
    fn mark_changed(&mut self, id: u64) {
        self.mark_changed_detail(id, true);
    }

    /// Invalidate for rendering only. Use for changes that cannot move a glyph
    /// into or out of the searchable text: style, and a native element's own
    /// props, whose text is matched at paint and never enters a `GroupList`.
    fn mark_render_changed(&mut self, id: u64) {
        self.mark_changed_detail(id, false);
    }

    fn mark_changed_detail(&mut self, id: u64, search: bool) {
        let revision = self.take_revision();
        let mut current = Some(id);
        while let Some(current_id) = current {
            let Some(element) = self.elements.get_mut(&current_id) else {
                break;
            };
            element.subtree_revision = revision;
            if search {
                element.search_revision = revision;
            }
            current = element.parent;
        }
    }

    /// Subtree-wide memoization candidacy, memoized on the element and keyed
    /// by `subtree_revision` — every mutation re-marks the chain, so a stale
    /// answer is never served for a mutated subtree.
    pub fn memo_scan(&self, id: u64) -> MemoScan {
        if let Some(element) = self.elements.get(&id) {
            if let Some((revision, scan)) = element.memo_scan.get() {
                if revision == element.subtree_revision {
                    return scan;
                }
            }
        }
        let mut scan = MemoScan { len: 0, flags: 0 };
        let mut stack = vec![id];
        while let Some(current) = stack.pop() {
            let Some(element) = self.elements.get(&current) else {
                continue;
            };
            scan.len += 1;
            match element.element_type.as_str() {
                "div" | "text" => {}
                "virtual-list" => scan.flags |= MEMO_HAS_VLIST,
                _ => scan.flags |= MEMO_HAS_CUSTOM,
            }
            if element.custom_props.contains_key("motion") {
                scan.flags |= MEMO_HAS_MOTION;
            }
            // Event listeners (element.events and the tree's delegated set)
            // do NOT disqualify: a cached leaf replays whichever set it
            // recorded, and both mutation paths re-mark every affected
            // subtree_revision — set_event_listener via mark_render_changed,
            // setDelegatedEvents via invalidate_render_caches — so a stale
            // set can never be replayed.
            // A resolved pseudo bucket flips paint on input natively — the
            // same disqualifier as a listener: a cached leaf would replay the
            // state it was recorded under forever.
            if element
                .style
                .as_deref()
                .is_some_and(StyleDesc::has_state_bucket)
            {
                scan.flags |= MEMO_HAS_EVENTS;
            }
            if self.dispatches(element, "mouseDown") && self.dispatches(element, "mouseMove") {
                scan.flags |= MEMO_HAS_CAPTURE;
            }
            stack.extend(element.children.iter().copied());
        }
        if let Some(element) = self.elements.get(&id) {
            element
                .memo_scan
                .set(Some((element.subtree_revision, scan)));
        }
        scan
    }

    /// Recursively destroy an element and all its children.
    /// Returns all destroyed IDs so the caller can clean up JS-side state.
    ///
    /// Unlinks from the parent before removing, then marks the parent chain
    /// changed so caches cannot serve text that is no longer in the tree.
    pub fn destroy_element(&mut self, id: u64) -> Vec<u64> {
        let parent_id = self.elements.get(&id).and_then(|element| element.parent);
        if let Some(parent_id) = parent_id {
            if let Some(parent) = self.elements.get_mut(&parent_id) {
                parent.children.retain(|child| *child != id);
            }
        }
        let mut destroyed = Vec::new();
        self.destroy_element_recursive(id, &mut destroyed);
        // Unbind roots at ANY depth — a subtree destroy can take a window's
        // bound root down with it, not just the top element.
        self.roots.retain(|_, root_id| !destroyed.contains(root_id));
        if let Some(parent_id) = parent_id {
            self.mark_changed(parent_id);
        }
        destroyed
    }

    fn destroy_element_recursive(&mut self, id: u64, destroyed: &mut Vec<u64>) {
        if let Some(element) = self.elements.remove(&id) {
            destroyed.push(id);
            for child_id in element.children {
                self.destroy_element_recursive(child_id, destroyed);
            }
        }
    }

    pub fn append_child(&mut self, parent_id: u64, child_id: u64) {
        // Remove from old parent if any
        let old_parent_id = self.elements.get(&child_id).and_then(|e| e.parent);
        if let Some(old_parent_id) = old_parent_id {
            if let Some(old_parent) = self.elements.get_mut(&old_parent_id) {
                old_parent.children.retain(|c| *c != child_id);
            }
        }
        // Set new parent
        if let Some(child) = self.elements.get_mut(&child_id) {
            child.parent = Some(parent_id);
        }
        // Add to new parent's children
        if let Some(parent) = self.elements.get_mut(&parent_id) {
            parent.children.push(child_id);
        }
        if let Some(old_parent_id) = old_parent_id {
            self.mark_changed(old_parent_id);
        }
        self.mark_changed(parent_id);
    }

    pub fn insert_before(&mut self, parent_id: u64, child_id: u64, before_id: u64) {
        // Remove from old parent if any
        let old_parent_id = self.elements.get(&child_id).and_then(|e| e.parent);
        if let Some(old_parent_id) = old_parent_id {
            if let Some(old_parent) = self.elements.get_mut(&old_parent_id) {
                old_parent.children.retain(|c| *c != child_id);
            }
        }
        // Set new parent
        if let Some(child) = self.elements.get_mut(&child_id) {
            child.parent = Some(parent_id);
        }
        // Insert before the target
        if let Some(parent) = self.elements.get_mut(&parent_id) {
            let pos = parent
                .children
                .iter()
                .position(|c| *c == before_id)
                .unwrap_or(parent.children.len());
            parent.children.insert(pos, child_id);
        }
        if let Some(old_parent_id) = old_parent_id {
            self.mark_changed(old_parent_id);
        }
        self.mark_changed(parent_id);
    }

    /// `moveBefore` — a reparent or same-parent reorder of a live subtree.
    /// `before_id == 0` means move to the end of `parent_id`'s children.
    ///
    /// Detach + re-link, so the subtree and everything keyed by its id
    /// (style layers, events, FocusHandle, custom-element state) survives —
    /// never a destroy+recreate. The child must already exist: unlike the
    /// insert ops, which tolerate an unknown child by linking a dangling id
    /// into `children`, a move of a dead id is a protocol slip and no-ops.
    pub fn move_before(&mut self, parent_id: u64, child_id: u64, before_id: u64) {
        if !self.elements.contains_key(&child_id) {
            return;
        }
        if before_id == 0 {
            self.append_child(parent_id, child_id);
        } else {
            self.insert_before(parent_id, child_id, before_id);
        }
    }

    /// Takes an interned style. Pointer identity is the fast path and covers
    /// every resend, because `StyleTable::intern` returns the same `Arc` for
    /// the same bytes. It is not sufficient on its own: interning keys on raw
    /// bytes, so `{"color":"red","width":10}` and `{"width":10,"color":"red"}`
    /// are two `Arc`s holding the same style. Only a pointer miss pays for the
    /// ~80-field compare, which is what decides whether this repaints.
    pub fn set_style(&mut self, id: u64, style: Arc<StyleDesc>) {
        let mut changed = false;
        if let Some(element) = self.elements.get_mut(&id) {
            let same = element
                .style
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &style) || **current == *style);
            if !same {
                element.style = Some(style);
                changed = true;
            }
        }
        if changed {
            self.mark_render_changed(id);
        }
    }

    /// Store the unresolved token payload beside the interned style. Called
    /// only from the batch path after a successful resolve+intern.
    pub fn set_style_raw(&mut self, id: u64, raw: Box<str>) {
        if let Some(element) = self.elements.get_mut(&id) {
            element.style_raw = Some(raw);
        }
    }

    /// Store the unresolved StyleProps payload (`None` clears the layer).
    /// Same contract as `set_style_raw`: the batch path composes and
    /// resolves every layer after the op loop.
    pub fn set_props_raw(&mut self, id: u64, raw: Option<Box<str>>) {
        if let Some(element) = self.elements.get_mut(&id) {
            element.props_raw = raw;
        }
    }

    /// Bind a recipe to an element (`None` unbinds). Resolution is deferred
    /// to the batch's compose pass like the other style layers.
    pub fn set_recipe(&mut self, id: u64, binding: Option<RecipeBinding>) {
        if let Some(element) = self.elements.get_mut(&id) {
            element.recipe = binding;
        }
    }

    /// Register a recipe and return the ids of elements bound to it, so the
    /// batch path can re-resolve them.
    pub fn register_recipe(&mut self, name: &str, recipe: crate::recipe::Recipe) -> Vec<u64> {
        self.recipes.insert(name.into(), recipe);
        self.elements
            .values()
            .filter(|element| {
                element
                    .recipe
                    .as_ref()
                    .is_some_and(|binding| &*binding.name == name)
            })
            .map(|element| element.id)
            .collect()
    }

    /// Replace an element's class token list — `setClass` sends the whole
    /// `class` attr, so the list replaces rather than merges. Returns whether
    /// it changed; the batch path uses that to queue a re-resolve. The bump
    /// is unconditional like a style write: classes are the selector-match
    /// input, so a changed list invalidates the subtree even when resolution
    /// happens to land on the same fields.
    pub fn set_class(&mut self, id: u64, value: &str) -> bool {
        let tokens: Vec<String> = value.split_ascii_whitespace().map(str::to_string).collect();
        let changed = match self.elements.get_mut(&id) {
            Some(element) if element.classes != tokens => {
                element.classes = tokens;
                true
            }
            _ => false,
        };
        if changed {
            self.mark_render_changed(id);
        }
        changed
    }

    /// Ids whose stylesheet resolution may differ after a sheet
    /// register/unregister: every element carrying classes, plus the whole
    /// tree when `broad` — a rule with no class comp (tag, `id`, universal)
    /// can match classless elements too.
    pub fn sheet_restyle_targets(&self, broad: bool) -> Vec<u64> {
        self.elements
            .values()
            .filter(|element| broad || !element.classes.is_empty())
            .map(|element| element.id)
            .collect()
    }

    pub fn set_text(&mut self, id: u64, content: String) {
        let mut changed = false;
        if let Some(element) = self.elements.get_mut(&id) {
            if element.content.as_ref() != Some(&content) {
                element.content = Some(content);
                changed = true;
            }
        }
        if changed {
            self.mark_changed(id);
        }
    }

    pub fn set_event_listener(&mut self, id: u64, event_type: String, has_handler: bool) {
        let changed = match self.elements.get_mut(&id) {
            Some(element) if has_handler => element.events.insert(event_type),
            Some(element) => element.events.remove(&event_type),
            None => false,
        };
        if changed {
            // Listeners are baked into a cached view's dispatch ranges: the
            // subtree must re-render or the replay keeps the stale set.
            self.mark_render_changed(id);
        }
    }

    /// Set a custom prop on an element (for non-div/text elements).
    ///
    /// Custom props never change the searchable text of a subtree: a native
    /// element's strings are matched at paint, not collected into a group. The
    /// one exception is `highlight` itself appearing or disappearing, which
    /// changes which subtrees an ancestor skips.
    /// Returns whether the prop value actually changed — the batch path uses
    /// it to know a `theme`/`color` write dirties the subtree's resolved
    /// styles.
    pub fn set_custom_prop(&mut self, id: u64, key: String, value: serde_json::Value) -> bool {
        let mut changed = false;
        let is_highlight = key == "highlight";
        let was_declaration = self
            .elements
            .get(&id)
            .is_some_and(|element| element.custom_props.contains_key("highlight"));
        if let Some(element) = self.elements.get_mut(&id) {
            // `autoFocus` applies to every element type, so it is lifted out of
            // the custom-prop map that only custom elements read.
            if key == "autoFocus" {
                element.auto_focus = value.as_bool().unwrap_or(false);
                return false;
            }
            if key == "testId" {
                element.test_id = value.as_str().map(str::to_string);
                return false;
            }
            if value.is_null() {
                changed = element.custom_props.remove(&key).is_some();
            } else {
                if element.custom_props.get(&key) != Some(&value) {
                    element.custom_props.insert(key, value);
                    changed = true;
                }
            }
        }
        if !changed {
            return false;
        }
        self.mark_render_changed(id);
        let is_declaration = self
            .elements
            .get(&id)
            .is_some_and(|element| element.custom_props.contains_key("highlight"));
        if is_highlight && was_declaration != is_declaration {
            // Only the ancestors: `GroupList::collect` skips a nested
            // declaration's subtree, so which subtrees exist changed for them.
            // This element's own groups are unaffected by its own query.
            if let Some(parent) = self.elements.get(&id).and_then(|element| element.parent) {
                self.mark_changed(parent);
            }
        }
        true
    }

    /// Read a custom prop value from an element.
    pub fn get_custom_prop(&self, id: u64, key: &str) -> Option<&serde_json::Value> {
        self.elements.get(&id)?.custom_props.get(key)
    }

    pub fn to_json(
        &self,
        bounds: &std::collections::HashMap<u64, crate::automation::ElementBounds>,
    ) -> serde_json::Value {
        self.to_json_detail(bounds, true)
    }

    /// Locator tree. Skip style maps so a 5k-row list is not 100ms of JSON.
    pub fn to_automation_json(
        &self,
        bounds: &std::collections::HashMap<u64, crate::automation::ElementBounds>,
    ) -> serde_json::Value {
        self.to_json_detail(bounds, false)
    }

    fn to_json_detail(
        &self,
        bounds: &std::collections::HashMap<u64, crate::automation::ElementBounds>,
        include_details: bool,
    ) -> serde_json::Value {
        match self.root_id() {
            Some(root_id) => element_to_json(root_id, self, bounds, include_details),
            None => serde_json::Value::Null,
        }
    }
}

fn element_to_json(
    id: u64,
    tree: &RetainedTree,
    bounds: &std::collections::HashMap<u64, crate::automation::ElementBounds>,
    include_details: bool,
) -> serde_json::Value {
    let Some(element) = tree.elements.get(&id) else {
        return serde_json::Value::Null;
    };

    let mut obj = serde_json::Map::new();
    obj.insert(
        "type".to_string(),
        serde_json::Value::String(element.element_type.clone()),
    );
    obj.insert("id".to_string(), serde_json::json!(element.id));

    if let Some(ref test_id) = element.test_id {
        obj.insert(
            "testId".to_string(),
            serde_json::Value::String(test_id.clone()),
        );
    }

    if let Some(ref content) = element.content {
        obj.insert(
            "text".to_string(),
            serde_json::Value::String(content.clone()),
        );
    }

    if let Some(rect) = bounds.get(&id) {
        obj.insert(
            "bounds".to_string(),
            serde_json::json!({
                "x": rect.x,
                "y": rect.y,
                "width": rect.width,
                "height": rect.height,
            }),
        );
    }

    if include_details {
        if let Some(ref style) = element.style {
            // `as_ref`, not the `Arc`. Serializing the pointer needs serde's
            // `rc` feature, which we never asked for; it only compiles because
            // gpui happens to enable it, and would break when gpui stops.
            if let Ok(style_json) = serde_json::to_value(style.as_ref()) {
                if let serde_json::Value::Object(ref map) = style_json {
                    let filtered: serde_json::Map<String, serde_json::Value> = map
                        .iter()
                        .filter(|(_, v)| !v.is_null())
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    if !filtered.is_empty() {
                        obj.insert("style".to_string(), serde_json::Value::Object(filtered));
                    }
                }
            }
        }

        if !element.events.is_empty() {
            let mut events: Vec<String> = element.events.iter().cloned().collect();
            events.sort();
            obj.insert("events".to_string(), serde_json::json!(events));
        }

        if !element.custom_props.is_empty() {
            let custom: serde_json::Map<String, serde_json::Value> = element
                .custom_props
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            obj.insert("customProps".to_string(), serde_json::Value::Object(custom));
        }
    }

    if !element.children.is_empty() {
        let children: Vec<serde_json::Value> = element
            .children
            .iter()
            .map(|&cid| element_to_json(cid, tree, bounds, include_details))
            .filter(|v| !v.is_null())
            .collect();
        if !children.is_empty() {
            obj.insert("children".to_string(), serde_json::Value::Array(children));
        }
    }

    serde_json::Value::Object(obj)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(tree: &mut RetainedTree, json: &str) {
        crate::renderer::apply_batch_to_tree(tree, json.as_bytes()).expect("valid batch");
    }

    fn tree_with_child() -> RetainedTree {
        let mut tree = RetainedTree::new();
        tree.create_element(1, "div".to_string());
        tree.create_element(2, "text".to_string());
        tree.create_element(3, "text".to_string());
        tree.append_child(1, 2);
        tree.append_child(2, 3);
        tree.set_text(3, "hello".to_string());
        tree
    }

    #[test]
    fn destroy_unlinks_from_parent() {
        let mut tree = tree_with_child();
        let destroyed = tree.destroy_element(2);
        assert_eq!(destroyed, vec![2, 3]);
        assert_eq!(tree.elements[&1].children, Vec::<u64>::new());
        assert!(!tree.elements.contains_key(&3));
    }

    #[test]
    fn destroy_bumps_the_parent_chain_revision() {
        let mut tree = tree_with_child();
        let before = tree.elements[&1].subtree_revision;
        tree.destroy_element(2);
        assert!(
            tree.elements[&1].subtree_revision > before,
            "destroying a child must invalidate a subtree_revision cache on the parent"
        );
    }

    #[test]
    fn destroying_the_root_clears_it() {
        let mut tree = tree_with_child();
        tree.roots.insert(0, 1);
        tree.destroy_element(1);
        assert_eq!(tree.root_id(), None);
        assert!(tree.elements.is_empty());
    }

    /// The whole point of `search_revision`: `highlight` is a custom prop, so
    /// keying the group cache on `subtree_revision` means every find-bar
    /// keystroke re-walks and re-folds the subtree it exists to avoid.
    #[test]
    fn a_query_change_does_not_move_search_revision() {
        let mut tree = tree_with_child();
        tree.set_custom_prop(
            1,
            "highlight".to_string(),
            serde_json::json!({"query": "a"}),
        );
        let search = tree.elements[&1].search_revision;
        let subtree = tree.elements[&1].subtree_revision;

        tree.set_custom_prop(
            1,
            "highlight".to_string(),
            serde_json::json!({"query": "ab"}),
        );
        assert_eq!(tree.elements[&1].search_revision, search, "same text");
        assert!(
            tree.elements[&1].subtree_revision > subtree,
            "still repaints"
        );
    }

    #[test]
    fn style_does_not_move_search_revision() {
        let mut tree = tree_with_child();
        let search = tree.elements[&1].search_revision;
        let style = tree.styles.intern(br##"{"color":"#fff"}"##).unwrap();
        tree.set_style(3, style);
        assert_eq!(tree.elements[&1].search_revision, search);
        assert!(tree.elements[&1].subtree_revision > 0);
    }

    // ── Style interning ──────────────────────────────────────────────

    #[test]
    fn equal_style_bytes_share_one_allocation() {
        let mut tree = tree_with_child();
        let first = tree.styles.intern(br#"{"color":"red"}"#).unwrap();
        let second = tree.styles.intern(br#"{"color":"red"}"#).unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(tree.styles.len(), 1);

        let other = tree.styles.intern(br#"{"color":"blue"}"#).unwrap();
        assert!(!Arc::ptr_eq(&first, &other));
        assert_eq!(tree.styles.len(), 2);
    }

    /// Re-sending the same style must not repaint. `commitUpdate` resends the
    /// full style on every commit, so without this every commit would dirty
    /// every element it touched.
    #[test]
    fn resending_the_same_style_is_not_a_change() {
        let mut tree = tree_with_child();
        let style = tree.styles.intern(br#"{"color":"red"}"#).unwrap();
        tree.set_style(3, style);
        let revision = tree.elements[&3].subtree_revision;

        let same = tree.styles.intern(br#"{"color":"red"}"#).unwrap();
        tree.set_style(3, same);
        assert_eq!(tree.elements[&3].subtree_revision, revision);

        let different = tree.styles.intern(br#"{"color":"blue"}"#).unwrap();
        tree.set_style(3, different);
        assert!(tree.elements[&3].subtree_revision > revision);
    }

    /// The table must not grow without bound. A dragged element produces a
    /// distinct style every frame, so the sweep is what keeps this safe.
    #[test]
    fn sweep_releases_styles_no_element_references() {
        let mut tree = tree_with_child();
        for frame in 0..50 {
            let payload = format!(r#"{{"left":{frame}}}"#);
            let style = tree.styles.intern(payload.as_bytes()).unwrap();
            tree.set_style(3, style);
            tree.styles.sweep();
            assert_eq!(tree.styles.len(), 1, "frame {frame} leaked a style");
        }
    }

    /// A drag through the batch entry point must keep the style table bounded.
    #[test]
    fn a_drag_through_apply_batch_stays_bounded() {
        let mut tree = tree_with_child();
        for frame in 0..1_000 {
            apply(
                &mut tree,
                &format!(r#"[["setStyle",3,{{"left":{frame}}}]]"#),
            );
            assert!(
                tree.styles.len() <= STYLE_SWEEP_FLOOR * 2,
                "frame {frame} grew the table to {}",
                tree.styles.len(),
            );
        }
    }

    /// Growth alone never fires again once the tree collapses: `swept_at` stays
    /// at the high-water mark and `count` cannot climb past it, because
    /// re-interning an existing style does not add an entry. Destroying the
    /// tree must reclaim the table anyway.
    #[test]
    fn destroying_the_tree_releases_its_styles() {
        let mut tree = RetainedTree::new();
        tree.create_element(1, "div".to_string());
        tree.roots.insert(0, 1);

        let wide = STYLE_SWEEP_FLOOR * 4;
        for index in 0..wide {
            let child = 100 + index as u64;
            tree.create_element(child, "div".to_string());
            tree.append_child(1, child);
            let style = tree
                .styles
                .intern(format!(r#"{{"left":{index}}}"#).as_bytes())
                .unwrap();
            tree.set_style(child, style);
        }
        assert_eq!(tree.styles.len(), wide, "every style is still live");

        tree.destroy_element(1);
        assert!(tree.elements.is_empty(), "the tree is gone");

        // Exactly what `apply_batch_to_tree` does after a batch that destroyed
        // the root. Nothing new is interned, so only the element count can
        // trigger this.
        let live_elements = tree.elements.len();
        tree.styles.maybe_sweep(live_elements);
        assert_eq!(tree.styles.len(), 0, "the destroyed tree kept its styles");
    }

    /// A style table larger than the tree must not re-sweep on every commit.
    #[test]
    fn the_shrink_sweep_does_not_thrash() {
        let mut tree = RetainedTree::new();
        for index in 0..(STYLE_SWEEP_FLOOR * 4) {
            let id = index as u64 + 1;
            tree.create_element(id, "div".to_string());
            let style = tree
                .styles
                .intern(format!(r#"{{"left":{index}}}"#).as_bytes())
                .unwrap();
            tree.set_style(id, style);
        }
        let live = tree.styles.len();
        let live_elements = tree.elements.len();
        tree.styles.maybe_sweep(live_elements);
        assert_eq!(tree.styles.len(), live, "a full table must survive a sweep");
    }

    #[test]
    fn sweep_keeps_a_style_two_elements_still_use() {
        let mut tree = tree_with_child();
        let style = tree.styles.intern(br#"{"color":"red"}"#).unwrap();
        tree.set_style(2, style.clone());
        tree.set_style(3, style);
        tree.styles.sweep();
        assert_eq!(tree.styles.len(), 1);

        let replacement = tree.styles.intern(br#"{"color":"blue"}"#).unwrap();
        tree.set_style(3, replacement);
        tree.styles.sweep();
        assert_eq!(tree.styles.len(), 2, "element 2 still holds red");

        let replacement = tree.styles.intern(br#"{"color":"blue"}"#).unwrap();
        tree.set_style(2, replacement);
        tree.styles.sweep();
        assert_eq!(tree.styles.len(), 1, "red is now unreferenced");
    }

    /// Sharing must never let one element's animation restyle another.
    #[test]
    fn a_shared_style_is_never_mutated_through() {
        let mut tree = tree_with_child();
        let style = tree.styles.intern(br#"{"color":"red"}"#).unwrap();
        tree.set_style(2, style.clone());
        tree.set_style(3, style);

        // This is what the motion path does: copy out, then mutate the copy.
        let mut animated = tree.elements[&3].style.as_deref().cloned().unwrap();
        animated.color = Some("green".to_string());

        assert_eq!(
            tree.elements[&2].style.as_ref().unwrap().color.as_deref(),
            Some("red")
        );
        assert_eq!(
            tree.elements[&3].style.as_ref().unwrap().color.as_deref(),
            Some("red")
        );
    }

    /// A nested declaration appearing changes which subtrees an ancestor skips,
    /// so the ancestor's collected groups really did change.
    #[test]
    fn a_nested_declaration_appearing_moves_the_ancestor() {
        let mut tree = tree_with_child();
        let search = tree.elements[&1].search_revision;
        tree.set_custom_prop(
            2,
            "highlight".to_string(),
            serde_json::json!({"query": "a"}),
        );
        assert!(tree.elements[&1].search_revision > search);

        // Changing that nested query does not.
        let after = tree.elements[&1].search_revision;
        tree.set_custom_prop(
            2,
            "highlight".to_string(),
            serde_json::json!({"query": "b"}),
        );
        assert_eq!(tree.elements[&1].search_revision, after);
    }

    #[test]
    fn text_and_structure_move_search_revision() {
        let mut tree = tree_with_child();
        let search = tree.elements[&1].search_revision;
        tree.set_text(3, "changed".to_string());
        assert!(tree.elements[&1].search_revision > search);

        let after = tree.elements[&1].search_revision;
        tree.destroy_element(3);
        assert!(tree.elements[&1].search_revision > after);
    }

    #[test]
    fn set_text_bumps_every_ancestor() {
        let mut tree = tree_with_child();
        let before = tree.elements[&1].subtree_revision;
        tree.set_text(3, "changed".to_string());
        assert!(tree.elements[&1].subtree_revision > before);
        // An unchanged value must not invalidate anything.
        let after = tree.elements[&1].subtree_revision;
        tree.set_text(3, "changed".to_string());
        assert_eq!(tree.elements[&1].subtree_revision, after);
    }
}
