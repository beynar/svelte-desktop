<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';

	let {
		size ,
		color ,
		weight,
		align,
		nowrap = false,
		class: klass = '',
		style = null,
		theme = null,
		children,
		...rest
	} = $props();
	const ct = useComponentTheme('text', theme);
	const resolved = $derived(
		mergeStyleDesc(
			mergeStyleDesc(s(ct.root({}, {})), s(style ?? {})),
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
