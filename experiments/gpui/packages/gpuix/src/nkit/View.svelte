<script>
	import { style, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { componentTheme } from './theming.svelte.js';

	let { tokens = '', color, style: instStyle, theme = null, children, ...rest } = $props();
	const ct = componentTheme('view', () => theme);
	// `style` accepts StyleProps or raw StyleDesc names — style() resolves both
	const resolved = $derived(mergeStyleDesc(style(ct.root({}, ct.props({}), instStyle)), resolveTokens(tokens, { color })));
</script>

<div use:applyStyle={resolved} {...rest}>{@render children?.()}</div>
