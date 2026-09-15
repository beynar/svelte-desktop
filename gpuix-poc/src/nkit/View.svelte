<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';

	let { tokens = '', color, style, theme = null, children, ...rest } = $props();
	const ct = useComponentTheme('view', theme);
	// `style` accepts StyleProps or raw StyleDesc names — s() resolves both
	const resolved = $derived(mergeStyleDesc(s(ct.root({}, ct.props({}), style)), resolveTokens(tokens, { color })));
</script>

<div use:applyStyle={resolved} {...rest}>{@render children?.()}</div>
