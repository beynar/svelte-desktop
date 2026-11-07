// nkit theming — the svelai <Theme>/ThemeState model on the style-prop lane.
//
// ThemeState mirrors svelai's: theme selection (theme/resolvedTheme/system),
// runtime designTokens compiled onto the token tables, the resolved motion
// scale, the component-theme registry, responsive props, and a window-event
// registry. One module-level `current` is the fallback when no <Theme> wraps
// the tree — leaf utilities (transitions, componentTheme) read it.
//
// Registry entry shape (components={{ button: {…} }}):
//   { size:'large'…      → variant-prop defaults (top-level, non-slot keys)
//     root: {…}|{base,variant:{…}}  → slot StyleProps (also `slots.{name}`, `style`=root)
//     motion: {in,out,duration,easing}
//     override: true     → drop the recipe base for that component }

import { getContext, setContext, onMount, onDestroy } from 'svelte';
import { emit, deferCall } from '../native.ts';
import { onPlatformEvent } from '../gdom.ts';
import {
	PALETTE, SPACING, RADIUS, FONT_SIZE, CONTROL_H, ICON,
	applyPalette, applyDesignTokens, setDefaultColor, clearTokenCaches,
	registerPalette, paletteByName,
} from './tokens.js';
import { isNativeStyle, envify, reportIssues, checkStyleProps } from './style.js';
import { resolveSide, toMotionProps, toGpuixEase } from './motion.js';

export { toGpuixEase };

const KEY = 'nkit:theme';

// svelai defaultMotionTokens verbatim (tailwind/scales.js)
export const MOTION_DEFAULTS = {
	duration: { instant: 0, fast: 100, normal: 200, slow: 300, slower: 500 },
	easing: { standard: 'cubicInOut', enter: 'cubicOut', exit: 'cubicIn', emphasized: 'backOut' },
};

const BREAKPOINTS = [['xs', 0], ['sm', 640], ['md', 768], ['lg', 1024], ['xl', 1280]];
const breakpointOf = (w) => { let b = 'xs'; for (const [k, min] of BREAKPOINTS) if (w >= min) b = k; return b; };
const BP_ORD = { base: 0, xs: 0, sm: 1, md: 2, lg: 3, xl: 4 };

const deepAssign = (dst, src) => {
	for (const k in src ?? {}) {
		const v = src[k];
		if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) deepAssign(dst[k], v);
		else dst[k] = v;
	}
	return dst;
};

export class ThemeState {
	// ── options (Theme.svelte assigns from props) ──
	themes = $state(['light', 'dark']);
	forcedTheme = $state(undefined);
	enableSystem = $state(true);
	enableColorScheme = $state(true);
	attribute = $state('data-theme');
	value = $state(undefined);          // Record<theme, attrValue>
	colorScheme = $state(undefined);    // Record<theme,'light'|'dark'> for custom names
	storageKey = $state('theme');
	designTokens = $state({});          // Record<theme, tokens>
	motionTokens = $state(undefined);   // <Theme motion> partial
	components = $state({});            // <Theme components> registry
	spinnerVariant = $state('default');
	reduceMotion = $state(undefined);   // undefined → OS pref
	transitionOnChange = $state(true);
	themeTransition = $state(undefined);
	size = $state(undefined);           // global default component size
	density = $state(undefined);
	defaultColor = $state('neutral');   // reactive mirror of tokens.setDefaultColor
	defaultColorBase = $state(undefined); // <Theme defaultColor> — under designTokens[t].defaultColor
	onThemeChange = $state(undefined);  // persist hook: (theme) => void
	onSystemResolve = $state(undefined);// detect hook: () => 'light'|'dark'

	// ── live state ──
	#theme = $state('system');          // the selection ('system' or a name)
	system = $state('dark');            // detected OS scheme
	osReduced = $state(false);
	vw = $state(1024);                  // viewport — Theme.svelte keeps it synced
	vh = $state(768);

	get theme() { return this.#theme; }
	set theme(v) {
		if (!v || v === this.#theme) return;
		this.#theme = v;
		this.onThemeChange?.(v);
	}
	/** set the selection without firing the persist hook (init/restore) */
	initTheme(v) { if (v) this.#theme = v; }
	/** resolved name: forcedTheme > system-resolution > selection */
	get resolvedTheme() {
		if (this.forcedTheme) return this.forcedTheme;
		return this.#theme === 'system' && this.enableSystem ? this.system : this.#theme;
	}
	get systemTheme() { return this.system; }
	/** the attribute value for the resolved theme (value map or the name) */
	get themeValue() { return this.value?.[this.resolvedTheme] ?? this.resolvedTheme; }
	/** which palette the resolved theme drives */
	get palette() {
		const r = this.resolvedTheme;
		return this.colorScheme?.[r] ?? (r === 'light' ? 'light' : 'dark');
	}
	get preferReducesMotion() { return this.reduceMotion ?? this.osReduced; }
	/** resolved motion scale: defaults ← <Theme motion> ← designTokens[t].motion */
	get motion() {
		const out = { duration: { ...MOTION_DEFAULTS.duration }, easing: { ...MOTION_DEFAULTS.easing } };
		deepAssign(out, this.motionTokens);
		deepAssign(out, this.designTokens?.[this.resolvedTheme]?.motion);
		return out;
	}
	/** deprecated svelai alias: normal duration + standard easing */
	get transition() {
		return { duration: this.motion.duration.normal, easing: this.motion.easing.standard };
	}
	get currentBreakpoint() { return breakpointOf(this.vw); }
	get isMobile() { return BP_ORD[this.currentBreakpoint] < BP_ORD.md; }

	/** The native theme declaration for this state — drop it on an element's
	 *  `theme` prop to scope it to that subtree: `<div theme={t.decl}>`. */
	get decl() { return nativeThemeDecl(this); }

	/** {base?,sm?,md?,lg?,xl?} → the value at the largest breakpoint ≤ current */
	resolveResponsiveProps = (props, def) => {
		if (props == null || typeof props !== 'object' || Array.isArray(props)) return props ?? def;
		const cur = BP_ORD[this.currentBreakpoint];
		let best = def, bo = -1;
		for (const k in props) {
			const o = BP_ORD[k];
			if (o !== undefined && o <= cur && o >= bo) { best = props[k]; bo = o; }
		}
		return best;
	};

	/** svelai splitTransition: flat spec → both sides; {in,out} → named sides */
	splitTransition = (props) => {
		if (props == null) return { in: undefined, out: undefined };
		if ('in' in props || 'out' in props) return { in: props.in, out: props.out };
		return { in: props, out: props };
	};

	/** window-event registry (Theme.svelte wires <svelte:window> → emit) */
	#listeners = new Map();
	addEventListener = (type, cb) => {
		let set = this.#listeners.get(type);
		if (!set) this.#listeners.set(type, (set = new Set()));
		set.add(cb);
		return () => set.delete(cb);
	};
	emit = (type, e) => {
		const set = this.#listeners.get(type);
		if (set) for (const cb of [...set]) cb(e);
	};
	get hasListeners() { return this.#listeners.size > 0; }
}

// ── active state (module fallback when no <Theme> is mounted) ──

let current = new ThemeState();
export const themeState = () => current;
export const motionReduced = () => current.preferReducesMotion;

/** svelai useTheme — nearest Theme's state, else the module fallback */
export function useTheme() {
	return getContext(KEY) ?? current;
}

/** svelai useDefaultColor — call inside $derived */
export function useDefaultColor(color) {
	return color ?? useTheme().defaultColor ?? 'neutral';
}

/** apply the resolved theme's palette + designTokens + caches — Theme.svelte
 *  calls this inside an $effect; safe to call after mutating options too.
 *  `global=false` (a nested scope) derives only the state's own fields —
 *  the shared token tables belong to the root theme, so a scoped override
 *  never flips every mounted env's JS-side resolution. */
export function applyResolvedTheme(state = current, global = true) {
	const dt = state.designTokens?.[state.resolvedTheme];
	const dc = dt?.defaultColor ?? state.defaultColorBase ?? 'neutral';
	state.defaultColor = dc;
	if (!global) return;
	applyPalette(state.palette);
	applyDesignTokens(dt);
	setDefaultColor(dc);
}

/** install a state as the module-level current (Theme.svelte calls this) */
export function installTheme(state) {
	current = state;
	applyResolvedTheme(state);
}

export function provideTheme(state, global = true) {
	setContext(KEY, state);
	// A nested scope provides context only — installing would flip `current`
	// and the shared token tables while the app theme still owns them.
	if (global) installTheme(state);
}

// ── theme() — the app-level theme as a function call ──────────────────

/** The native theme declaration for a ThemeState: palette mode, role maps
 *  (registered palette overrides merged with designTokens.colors/surface),
 *  designTokens factor knobs, defaultColor, viewport. Ships to Rust through
 *  the `setTheme` op, where it seeds every element's ancestor theme fold. */
export function nativeThemeDecl(th) {
	const dt = th.designTokens?.[th.resolvedTheme] ?? {};
	const pal = paletteByName(th.palette);
	const { surface: palSurface, ...palColors } = pal ?? {};
	const { colors: dtColors, surface: dtSurface, ...dtRest } = dt;
	return {
		mode: th.palette,
		...(pal || dtColors || dtSurface
			? { colors: { ...palColors, ...dtColors }, surface: { ...palSurface, ...dtSurface } }
			: {}),
		...dtRest,
		defaultColor: dt.defaultColor ?? th.defaultColorBase ?? 'neutral',
		viewport: th.vw,
	};
}

/** Shared wiring behind `theme()` and `<Theme>`: ThemeState build, context
 *  provision, OS/system detection, persistence, platform listeners. `global`
 *  gates the `setTheme` op emit — `theme()` is the app-level lane (no element
 *  needed); `<Theme>` passes false and scopes through its own element prop. */
function setupTheme(options = {}, global = true) {
	const {
		themes = ['light', 'dark'], defaultTheme, enableSystem = true, systemTheme,
		enableColorScheme = true, syncColorScheme, forcedTheme,
		attribute = 'data-theme', value, colorScheme, storageKey = 'theme',
		designTokens = {}, motion, components = {}, spinnerVariant = 'default',
		reduceMotion, transition, transitionOnChange = true,
		disableTransitionOnChange, size, density, defaultColor, tokens, palettes,
		onSystemResolve,
	} = options;
	const th = new ThemeState();
	const prev = themeState();
	// Read before provideTheme installs th: a theme() call under an existing
	// theme context is the scoped lane — it overrides the parent for its
	// descendants (context + `theme` prop) and must not clobber the app-level
	// declaration the outer theme() already shipped through `setTheme`.
	const parentCtx = getContext(KEY);
	// `isRoot` — no theme context above us: this state owns `current`, the
	// shared token tables, and (for theme()) the `setTheme` emit. A nested
	// call is a scope: context + decl only, no global writes.
	const isRoot = parentCtx == null;
	const emitGlobal = global && isRoot;
	th.themes = themes;
	th.enableSystem = systemTheme ?? enableSystem;
	th.enableColorScheme = syncColorScheme ?? enableColorScheme;
	th.attribute = attribute;
	th.value = value;
	th.colorScheme = colorScheme;
	th.storageKey = storageKey;
	th.designTokens = designTokens;
	th.motionTokens = motion;
	th.components = components;
	th.spinnerVariant = spinnerVariant;
	th.reduceMotion = reduceMotion;
	th.themeTransition = transition;
	th.transitionOnChange = disableTransitionOnChange != null ? !disableTransitionOnChange : transitionOnChange;
	th.size = size;
	th.density = density;
	th.defaultColorBase = defaultColor;
	th.onSystemResolve = onSystemResolve; // before first osDetect
	// forcedTheme is an override, not the selection — the selection seeds from
	// defaultTheme/system and stays stable if forcedTheme is lifted
	th.forcedTheme = forcedTheme;
	// A nested scope (theme() under a parent context, or a nested <Theme>)
	// inherits the parent's resolved theme — `theme({components:{…}})` means
	// "same theme, overridden components", not "re-detect the OS scheme".
	th.initTheme(defaultTheme ?? parentCtx?.resolvedTheme ?? (th.enableSystem ? 'system' : 'light'));

	// ── persistence — ~/.config/nkit/<storageKey>.json — app-level only:
	// a nested theme() is a scoped override, not the user's global pref ──
	const persistPath = emitGlobal && storageKey
		? `${(globalThis.Bun?.env ?? globalThis.process?.env ?? {}).HOME ?? ''}/.config/nkit/${storageKey}.json`
		: null;
	const persist = (t) => {
		if (!persistPath || !globalThis.Bun) return;
		try { globalThis.Bun.write(persistPath, JSON.stringify({ theme: t })); } catch { /* preference only */ }
	};
	th.onThemeChange = persist;

	// ── OS detection — macOS interface style + reduceMotion ──
	// On the native runtime the live source is the `appearanceChanged` platform
	// event (subscribed in onMount via gdom's platform tap — gpuix can't import
	// @svelte-desktop/platform; the dep direction is platform → gpuix). The
	// `defaults read` spawnSync stays as the documented fallback for contexts
	// where platform events never flow (headless/test/quickgui/browser).
	let sawAppearanceEvent = false;
	const osDetect = () => {
		const custom = th.onSystemResolve?.();
		if (custom === 'light' || custom === 'dark') { th.system = custom; return; }
		const B = globalThis.Bun;
		if (!B?.spawnSync || process?.platform !== 'darwin') return;
		try {
			th.system = B.spawnSync(['defaults', 'read', '-g', 'AppleInterfaceStyle']).exitCode === 0 ? 'dark' : 'light';
		} catch { /* non-macOS or no defaults */ }
		try {
			th.osReduced = B.spawnSync(['defaults', 'read', 'com.apple.universalaccess', 'reduceMotion']).stdout?.toString().trim() === '1';
		} catch { /* default false */ }
	};
	osDetect();

	// Native initial read: `theme.get` returns the same appearance_json the
	// event carries — it covers an appearanceChanged emitted before this
	// component subscribed. deferCall only fires once a renderer is bound, and
	// `platformCall` exists only on the real GpuixRenderer — TestGpuixRenderer
	// and the quickgui sink fall through to the spawnSync path untouched.
	deferCall((r) => {
		const call = r.platformCall?.bind(r);
		if (!call) return;
		try {
			const reply = JSON.parse(call(JSON.stringify({ id: 0, service: 'theme', op: 'get', args: {} })));
			if (reply?.ok && typeof reply.value?.dark === 'boolean') th.system = reply.value.dark ? 'dark' : 'light';
		} catch { /* transport hiccup — the spawnSync baseline stands */ }
		try {
			const reply = JSON.parse(call(JSON.stringify({ id: 0, service: 'system', op: 'getAccessibility', args: {} })));
			if (reply?.ok && typeof reply.value?.reduceMotion === 'boolean') th.osReduced = reply.value.reduceMotion;
		} catch { /* same */ }
	});

	provideTheme(th, isRoot);
	// palette/token registration is a global registry — scopes don't write it
	if (isRoot) {
		if (palettes) for (const n in palettes) registerPalette(n, palettes[n]);
		if (tokens) applyTokenOverrides(tokens);
	}

	$effect(() => {
		void th.resolvedTheme;
		void th.designTokens;
		void th.defaultColorBase;
		void th.currentBreakpoint; // fluid typeScale follows the viewport
		applyResolvedTheme(th, isRoot);
	});
	if (emitGlobal) {
		$effect(() => { emit('setTheme', nativeThemeDecl(th)); });
	}

	onMount(() => {
		// restore persisted selection
		if (persistPath && globalThis.Bun) {
			globalThis.Bun.file(persistPath).json()
				.then((j) => { if (j?.theme && !forcedTheme) th.initTheme(j.theme); })
				.catch(() => {});
		}
		// system theme: `appearanceChanged` is authoritative on native. The
		// payload is appearance_json {appearance, dark} — the `dark` bool maps
		// onto the same 'dark'/'light' system value the poll produced. First
		// event also permanently retires the spawnSync fallback below.
		const offAppearance = onPlatformEvent((type, data) => {
			const name = type.startsWith('platform:') ? type.slice(9) : type;
			if (name !== 'appearanceChanged') return;
			sawAppearanceEvent = true;
			const custom = th.onSystemResolve?.();
			if (custom === 'light' || custom === 'dark') { th.system = custom; return; }
			const dark = data?.dark;
			if (typeof dark === 'boolean') th.system = dark ? 'dark' : 'light';
		});
		// window-event registry → th.emit, what <svelte:window> did for <Theme>
		const w = globalThis.window;
		const keydown = (e) => th.emit('keydown', e);
		const keyup = (e) => th.emit('keyup', e);
		const down = (e) => { th.emit('pointerdown', e); th.emit('mousedown', e); };
		w?.addEventListener?.('keydown', keydown);
		w?.addEventListener?.('keyup', keyup);
		w?.addEventListener?.('mousedown', down);
		// Viewport polling always runs; the osDetect arm is the non-native
		// fallback — once an appearanceChanged event has been seen the platform
		// event owns `system` and the spawnSync poll is off for good.
		const t = setInterval(() => {
			if (!sawAppearanceEvent && th.enableSystem && th.theme === 'system') osDetect();
			if (w && (w.innerWidth !== th.vw || w.innerHeight !== th.vh)) {
				th.vw = w.innerWidth; th.vh = w.innerHeight;
			}
		}, 1500);
		return () => {
			clearInterval(t);
			offAppearance();
			w?.removeEventListener?.('keydown', keydown);
			w?.removeEventListener?.('keyup', keyup);
			w?.removeEventListener?.('mousedown', down);
		};
	});
	onDestroy(() => {
		// Only the state that installed itself restores — a nested scope never
		// installed, and a stale parent must not undo a live successor.
		if (isRoot && current === th) {
			installTheme(prev);
			if (emitGlobal) emit('setTheme', nativeThemeDecl(prev));
		}
	});
	return th;
}

/** theme(options) — the theme as a function call. Call it at init in a
 *  component: it builds the ThemeState, provides it to descendants, wires
 *  OS/system detection + persistence, and ships the resolved declaration
 *  straight to Rust through the `setTheme` op — no wrapper element, no
 *  attachment. Returns the ThemeState (reactive):
 *
 *      const app = theme({ defaultTheme: 'dark', components: {…} });
 *      app.resolvedTheme   // 'dark'
 *      app.theme = 'light' // selects + persists
 *
 *  Nested under an existing theme context the same call scopes instead:
 *  it provides a new ThemeState for its descendants and skips the global
 *  emit — drop `t.decl` on the subtree's root element to scope the native
 *  resolution too:
 *
 *      const t = theme({ designTokens: { dark: { colors: { primary: '#f0f' } } } });
 *      <div theme={t.decl}>…</div>
 *
 *  `<Theme>` stays as the component form of the scoped lane. */
export function theme(options = {}) {
	return setupTheme(options, true);
}

/** Internal variant for <Theme>: same wiring without the global `setTheme`
 *  emit — the component scopes through its element's `theme` prop instead. */
export function setupScopedTheme(options = {}) {
	return setupTheme(options, false);
}

// ── component theme ladder ────────────────────────────────────────────
// slot entry resolution: `e` may be StyleProps, or {base, <axis>:{<val>:props}}

const RESERVED = new Set(['slots', 'style', 'motion', 'override', 'props']);

function slotEntry(entry, name) {
	if (!entry) return undefined;
	return entry.slots?.[name] ?? entry[name] ?? (name === 'root' ? entry.style : undefined);
}

/** prop defaults: entry's top-level keys that aren't slots/reserved */
function propDefaults(entry, slotNames) {
	const out = {};
	for (const k in entry ?? {}) {
		if (RESERVED.has(k) || k === 'root' || slotNames.has(k)) continue;
		out[k] = entry[k];
	}
	return out;
}

/** Is this level entry a bare StyleProps frag or a structured
 *  {base, <axis>:{<value>:props}} map? A bare frag's keys all live in the
 *  StyleProps vocabulary; a variant-map key (`variant:{danger:{…}}`) drops
 *  in the prop walk. Cached per entry — registry/theme objects are stable
 *  references and this runs per slot per render. */
const bareEntryCache = new WeakMap();
function isBareProps(e, label) {
	let v = bareEntryCache.get(e);
	if (v === undefined) {
		if (typeof e !== 'object' || Array.isArray(e)) v = false;
		else if (e.base !== undefined || e.override !== undefined) v = false;
		else {
			const dropped = checkStyleProps(e);
			v = dropped.length === 0;
			// A "structured" entry whose keys aren't variant maps is a typo'd
			// bare frag — surface it rather than silently contributing nothing.
			if (!v && !Object.values(e).some((x) => x && typeof x === 'object'))
				reportIssues(label, dropped);
		}
		bareEntryCache.set(e, v);
	}
	return v;
}

/** one slot entry → ordered fragments: base + variant maps selected by vp.
 *  Nothing merges in JS — fragments ride the stream and the engine resolves
 *  conflicts natively (null deletes a level's fields, buckets merge
 *  key-wise, ring state spans the stream). `take` unwraps envelopes so a
 *  level entry can carry style()/recipe() output. */
function pushSlotFrags(frags, e, vp, take, label) {
	if (e == null) return;
	if (isNativeStyle(e) || typeof e !== 'object' || Array.isArray(e)) { take(e); return; }
	if (isBareProps(e, label)) { frags.push(e); return; }
	take(e.base);
	for (const axis in e) {
		if (axis === 'base' || axis === 'override') continue;
		const sel = e[axis]?.[vp[axis]] ?? e[axis]?.[String(vp[axis])];
		if (sel != null) take(sel);
	}
}

/**
 * componentTheme(name, instTheme, slots) — the component theme ladder:
 *   recipe defaults → theme `components` registry (theme context — nested
 *   theme() scopes it per subtree) → instance `theme` prop → (root) instance
 *   `style` prop.
 * `instTheme` takes the prop value or a getter — pass `() => theme` so a
 * replaced object stays visible (a captured value freezes the instance
 * level at init).
 * Call at component init; the returned fns are reactive-safe ($derived).
 */
export function componentTheme(name, instTheme, slots = []) {
	const th = getContext(KEY) ?? current;
	const slotNames = new Set(['root', ...slots]);
	const inst = typeof instTheme === 'function' ? instTheme : () => instTheme;
	const levels = () => [th.components?.[name], inst()];
	return {
		state: th,
		/** resolved variant-prop values: global defaults < registry < subtree
		 *  < instance-theme prop defaults < defined instance props */
		props(vprops = {}) {
			const out = {};
			if (vprops.color === undefined) out.color = th.defaultColor ?? 'neutral';
			if (vprops.size === undefined && th.size !== undefined) out.size = th.size;
			if (vprops.density === undefined && th.density !== undefined) out.density = th.density;
			for (const L of levels()) deepAssign(out, propDefaults(L, slotNames));
			for (const k in vprops) if (vprops[k] !== undefined) out[k] = vprops[k];
			return out;
		},
		/** resolved slot style (hand to `style()`): recipe(vp) → per-level
		 *  base+variants → inst. A recipe call returns a native binding — the
		 *  engine resolves base/variants/compounds in Rust; the level
		 *  overrides ride behind it as ordered fragments, unmerged. */
		slot(name, recipeOrProps, vp, instStyle) {
			const frags = [];
			const lv = levels();
			let binding = null;
			// one fragment in — envs unwrap to their stream and carry a recipe
			// binding up to the (single) `setRecipe` slot; garbage warns+drops
			const take = (f) => {
				if (f == null || f === false) return;
				if (isNativeStyle(f)) {
					if (f.__recipe) {
						if (binding) reportIssues(name, [`recipe '${f.__recipe.name}' dropped — one binding per element`]);
						else binding = f.__recipe;
					}
					frags.push(...f.__frags);
				} else if (typeof f === 'object' && !Array.isArray(f)) frags.push(f);
				else if (f !== true) reportIssues(name, [`non-style fragment dropped (${JSON.stringify(f)?.slice(0, 40) ?? typeof f})`]);
			};
			if (!lv.some((l) => l?.override)) {
				// multi-slot recipes take the shared tuple then pick the slot
				const base = typeof recipeOrProps === 'function'
					? (recipeOrProps.__slots ? recipeOrProps(vp)[name]?.() ?? null : recipeOrProps(vp))
					: recipeOrProps;
				if (isNativeStyle(base)) {
					binding = base.__recipe;
					frags.push(...base.__frags);
				} else take(base);
			}
			for (const L of lv) pushSlotFrags(frags, slotEntry(L, name), vp ?? {}, take, name);
			if (name === 'root') take(instStyle);
			return envify({ __native: true, __recipe: binding, __frags: frags, __ctx: null });
		},
		/** root slot + the instance `style` escape hatch landing last */
		root(recipeOrProps, vp, instStyle) {
			return this.slot('root', recipeOrProps, vp, instStyle);
		},
		/** resolved motion spec — see motion.js componentMotion for `transition` prop handling */
		motion: (presetResolver, vprops, instTransition) =>
			resolveComponentMotion(name, presetResolver, vprops, instTransition, levels(), th),
	};
}

const SIDES = new Set(['in', 'out']);
const stripSides = (m = {}) => {
	const out = {};
	for (const k in m) if (!SIDES.has(k)) out[k] = m[k];
	return out;
};

/** motion ladder: preset → registry → subtree → instance theme.motion →
 *  instance `transition` prop (named side replaces; flat replaces both).
 *  Token names still resolve through the live scale; reduceMotion → 0 last. */
export function resolveComponentMotion(name, presetResolver, vprops, instTransition, lv = [current.components?.[name]], th = current) {
	const base = typeof presetResolver === 'function' ? presetResolver(vprops ?? {}) : (presetResolver ?? {});
	let inS = { ...stripSides(base), ...(base.in ?? {}) };
	let outS = { ...stripSides(base), ...(base.out ?? {}) };
	for (const L of lv) {
		const m = L?.motion;
		if (!m) continue;
		const flat = stripSides(m);
		inS = { ...inS, ...flat, ...(m.in ?? {}) };
		outS = { ...outS, ...flat, ...(m.out ?? {}) };
	}
	const t = th.splitTransition(instTransition);
	if (t.in) inS = { ...inS, ...t.in };
	if (t.out) outS = { ...outS, ...t.out };
	const scale = th.motion, reduced = th.preferReducesMotion;
	return {
		in: toMotionProps(inS, scale, reduced),
		out: resolveSide(outS, outS, scale, reduced),
		spec: { in: inS, out: outS },
	};
}

// ── token overrides (low-level escape hatch, also used by Theme) ──────

/** merge token-table overrides — colors into PALETTE, plus spacing/radius/
 *  fontSize/control/icon scales — then invalidate every resolve cache. */
export function applyTokenOverrides(tokens = {}) {
	const { colors, spacing, radius, fontSize, control, icon } = tokens;
	if (colors) deepAssign(PALETTE, colors);
	if (spacing) deepAssign(SPACING, spacing);
	if (radius) deepAssign(RADIUS, radius);
	if (fontSize) deepAssign(FONT_SIZE, fontSize);
	if (control) deepAssign(CONTROL_H, control);
	if (icon) deepAssign(ICON, icon);
	clearTokenCaches();
}
