<script>
	// <Theme> — the svelai Theme component, native lane. Wrap the app once;
	// the children snippet receives the shared ThemeState.
	//
	//   <Theme themes={['light','dark']} defaultTheme="system" storageKey="theme"
	//          designTokens={{light:{radius:'large'}, dark:{radius:'small'}}}
	//          motion={{duration:{normal:150}, easing:{standard:'quintOut'}}}
	//          components={{button:{root:{base:{radius:'full'}}}}}
	//          spinnerVariant="circles" reduceMotion={false}>
	//     {#snippet children(theme)} … {@render page()} {/snippet}
	//   </Theme>
	//
	// Browser-only props adapt natively: `attribute`/`value` land on the root
	// element as a custom prop; `storageKey` persists to
	// ~/.config/nkit/<key>.json; `enableSystem` polls macOS AppleInterfaceStyle;
	// `colorScheme` maps custom theme names onto the light/dark palette.
	// `transition` runs an opacity dip on the root view across a theme swap.

	import { onMount, onDestroy } from 'svelte';
	import {
		ThemeState, provideTheme, installTheme, applyResolvedTheme, themeState,
		applyTokenOverrides,
	} from './theming.svelte.js';
	import { registerPalette } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { s } from './style.js';

	let {
		children,
		themes = ['light', 'dark'],
		defaultTheme,
		enableSystem = true,
		systemTheme,                 // alias for enableSystem (docs name it both ways)
		enableColorScheme = true,
		syncColorScheme,             // alias
		forcedTheme,
		attribute = 'data-theme',
		value,
		colorScheme,
		storageKey = 'theme',
		designTokens = {},
		motion,
		components = {},
		spinnerVariant = 'default',
		reduceMotion,
		transition,
		transitionOnChange = true,
		disableTransitionOnChange,   // svelte-themes name (inverted)
		size,
		density,
		defaultColor,                // global accent default for controls that omit `color`
		tokens,                      // raw token-table overrides (nkit extension)
		palettes,                    // {name: palette} → registerPalette (extension)
		onSystemResolve,             // custom OS-scheme detection hook: () => 'light'|'dark'
		class: klass = '',
		style = null,
		...rest
	} = $props();

	const th = new ThemeState();
	const prev = themeState();

	// options → th (assignment effect below tracks prop changes)
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
	th.initTheme(defaultTheme ?? (th.enableSystem ? 'system' : 'light'));

	// ── persistence — ~/.config/nkit/<storageKey>.json ──
	const persistPath = storageKey ? `${(globalThis.Bun?.env ?? globalThis.process?.env ?? {}).HOME ?? ''}/.config/nkit/${storageKey}.json` : null;
	const persist = (t) => {
		if (!persistPath || !globalThis.Bun) return;
		try { globalThis.Bun.write(persistPath, JSON.stringify({ theme: t })); } catch { /* preference only */ }
	};
	th.onThemeChange = persist;

	// ── OS detection — macOS interface style + reduceMotion ──
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

	provideTheme(th);
	if (palettes) for (const n in palettes) registerPalette(n, palettes[n]);
	if (tokens) applyTokenOverrides(tokens);

	// prop → th sync — one effect per field so a change to one prop doesn't
	// clobber fields callers mutated through the ThemeState API (th.size = …)
	$effect(() => { th.forcedTheme = forcedTheme; });
	$effect(() => { th.themes = themes; });
	$effect(() => { th.designTokens = designTokens; });
	$effect(() => { th.motionTokens = motion; });
	$effect(() => { th.components = components; });
	$effect(() => { th.spinnerVariant = spinnerVariant; });
	$effect(() => { th.reduceMotion = reduceMotion; });
	$effect(() => { th.size = size; });
	$effect(() => { th.density = density; });
	$effect(() => { th.defaultColorBase = defaultColor; });
	$effect(() => { th.onSystemResolve = onSystemResolve; });
	$effect(() => {
		void th.resolvedTheme;
		void th.designTokens;
		void th.defaultColorBase;
		void th.currentBreakpoint; // fluid typeScale follows the viewport
		applyResolvedTheme(th);
	});

	let rootEl = $state(null);
	let lastResolved = th.resolvedTheme;
	// theme-change transition: a quick opacity dip on the root view
	$effect(() => {
		const r = th.resolvedTheme;
		if (r === lastResolved || !rootEl) return;
		lastResolved = r;
		if (!th.themeTransition || !th.transitionOnChange || th.preferReducesMotion) return;
		rootEl.animate?.(
			[{ opacity: 0.55 }, { opacity: 1 }],
			{ duration: Math.max(120, th.motion.duration.normal) },
		);
	});

	onMount(() => {
		// restore persisted selection
		if (persistPath && globalThis.Bun) {
			globalThis.Bun.file(persistPath).json()
				.then((j) => { if (j?.theme && !forcedTheme) th.initTheme(j.theme); })
				.catch(() => {});
		}
		// system theme + viewport polling
		const t = setInterval(() => {
			if (th.enableSystem && th.theme === 'system') osDetect();
			const w = globalThis.window;
			if (w && (w.innerWidth !== th.vw || w.innerHeight !== th.vh)) {
				th.vw = w.innerWidth; th.vh = w.innerHeight;
			}
		}, 1500);
		return () => clearInterval(t);
	});
	onDestroy(() => installTheme(prev));

	const rootS = $derived(s({ col: true, flex1: true, minW: 0, minH: 0, ...(style ?? {}) }));
	const themedProps = $derived(
		Object.fromEntries(
			Object.entries({
				[attribute]: th.themeValue,
				colorScheme: th.enableColorScheme ? th.palette : undefined,
				reduceMotion: th.preferReducesMotion || undefined,
			}).filter(([, v]) => v !== undefined),
		),
	);
	const winEvent = (type) => (e) => th.emit(type, e);
	const downEvent = (e) => { th.emit('pointerdown', e); th.emit('mousedown', e); };
</script>

<svelte:window
	onkeydown={winEvent('keydown')}
	onkeyup={winEvent('keyup')}
	onmousedown={downEvent}
/>

<div
	bind:this={rootEl}
	use:applyStyle={rootS}
	use:nativeProps={themedProps}
	class={klass}
	{...rest}
>
	{@render children?.(th)}
</div>
