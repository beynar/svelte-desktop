<script>
	// <Theme> — the svelai Theme component, native lane. Wrap the app once;
	// the children snippet receives the shared ThemeState. The function form
	// is `theme(options)` — same wiring shipped through the `setTheme` op
	// instead of a wrapper element (see theming.svelte.js). <Theme> remains
	// the scoped-subtree lane: its element carries the `theme` custom prop,
	// which folds over the app-level declaration through the ancestor cascade.
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
	// ~/.config/nkit/<key>.json; `enableSystem` tracks macOS appearance via the
	// `appearanceChanged` platform event (defaults-read poll = non-native
	// fallback);
	// `colorScheme` maps custom theme names onto the light/dark palette.
	// `transition` runs an opacity dip on the root view across a theme swap.

	import {
		setupScopedTheme, nativeThemeDecl,
	} from './theming.svelte.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { style } from './style.js';

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
		style: instStyle = null,
		...rest
	} = $props();

	const th = setupScopedTheme({
		themes, defaultTheme, enableSystem, systemTheme, enableColorScheme,
		syncColorScheme, forcedTheme, attribute, value, colorScheme, storageKey,
		designTokens, motion, components, spinnerVariant, reduceMotion,
		transition, transitionOnChange, disableTransitionOnChange, size,
		density, defaultColor, tokens, palettes, onSystemResolve,
	});

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

	const rootS = $derived(style({ col: true, flex1: true, minW: 0, minH: 0, ...(instStyle ?? {}) }));
	// The `theme` custom prop is the scoped lane: it folds over the app-level
	// `setTheme` declaration for this subtree only (ancestor cascade), so a
	// nested <Theme> themes just its children.
	const themedProps = $derived(
		Object.fromEntries(
			Object.entries({
				[attribute]: th.themeValue,
				colorScheme: th.enableColorScheme ? th.palette : undefined,
				reduceMotion: th.preferReducesMotion || undefined,
				theme: nativeThemeDecl(th),
			}).filter(([, v]) => v !== undefined),
		),
	);
</script>

<div
	bind:this={rootEl}
	use:applyStyle={rootS}
	use:nativeProps={themedProps}
	class={klass}
	{...rest}
>
	{@render children?.(th)}
</div>
