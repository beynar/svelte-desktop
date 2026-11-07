<script>
	// Tintable svg icon — the kit's icon API.
	//
	//   <Icon name="check" />                    — built-in set + registerIcons()
	//   <Icon source={searchSvg} />              — raw markup (`?raw` file import)
	//   <Icon src="/abs/icon.svg" />             — file path or data:image/svg+xml URL
	//   <Icon viewBox="0 0 16 16"><path d="…"/></Icon> — nested markup
	//
	// Content precedence: children > source > name. `size` is 'small'|'normal'
	// |'large' (icon scale) or a px number. `color` names a palette color to
	// tint with — omitted, the icon inherits the parent's color, so stylesheet
	// color rules (and :hover variants) tint it like real currentColor.
	// Decorative by default — `label` promotes it to an accessible image
	// (role=img + aria-label). `class` feeds both channels: utility tokens
	// resolve to styles AND the raw string lands as DOM classes.
	import { style, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { componentTheme } from './theming.svelte.js';
	import { iconTheme } from './recipes/display.js';
	import { icons } from './icons.js';

	let {
		name = undefined,
		source = undefined,
		src = undefined,
		size = undefined, // 'small'|'normal'|'large' | px number
		color = undefined, // palette ctx — omitted → theme defaultColor
		viewBox = '0 0 24 24', // serialized root attr — only used with children
		label = undefined,
		class: klass = '',
		style: instStyle = null,
		theme = null,
		children,
		...rest
	} = $props();

	const ct = componentTheme('icon', () => theme);
	// px numbers aren't a variant — only named sizes go through the recipe
	const px = $derived(typeof size === 'number' ? size : undefined);
	const vp = $derived(ct.props({ size: px ? undefined : size, color }));
	const ctx = $derived({ color: vp.color });
	const resolved = $derived(
		mergeStyleDesc(
			mergeStyleDesc(style(ct.root(iconTheme, vp, instStyle), ctx), px ? style({ w: px, h: px }) : null),
			vp.color != null ? style({ fg: 'color' }, ctx) : null,
			resolveTokens(klass, ctx),
		),
	);

	const warned = new Set();
	const markup = $derived.by(() => {
		const m = source ?? (name ? icons[name] : undefined);
		if (name && !icons[name] && !warned.has(name)) {
			warned.add(name);
			console.warn(`[Icon] unknown icon name '${name}' — registered: ${Object.keys(icons).join(', ')}`);
		}
		return m;
	});
	// nativeProps ships every key — build the object so unset channels stay absent
	const iconProps = $derived(
		children ? {} : markup ? { source: markup } : src ? { src } : {},
	);
</script>

<svg
	use:applyStyle={resolved}
	use:nativeProps={iconProps}
	class={klass || undefined}
	viewBox={children ? viewBox : undefined}
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
	{...rest}
>
	{@render children?.()}
</svg>
