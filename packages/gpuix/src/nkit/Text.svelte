<script>
	import { style, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { componentTheme } from './theming.svelte.js';

	let {
		size ,
		color ,
		weight,
		align,
		nowrap = false,
		class: klass = '',
		style: instStyle = null,
		theme = null,
		children,
		...rest
	} = $props();
	const ct = componentTheme('text', () => theme);
	const resolved = $derived(
		mergeStyleDesc(
			mergeStyleDesc(style(ct.root({}, {})), style(instStyle ?? {})),
			resolveTokens(
				`text-${size} text-${color}` +
					(weight ? ` font-${weight}` : '') +
					(align ? ` text-${align}` : '') +
					(nowrap ? ' whitespace-nowrap' : '') +
					(klass ? ` ${klass}` : ''),
			),
		),
	);
</script>

<span use:applyStyle={resolved} {...rest}>{@render children?.()}</span>
