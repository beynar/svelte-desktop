<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { kbdTheme } from './recipes/display.js';

	let { class: klass = '', style = null, theme = null, children, ...rest } = $props();
	const ct = useComponentTheme('kbd', theme);
	const vp = $derived(ct.props({}));
	const resolved = $derived(mergeStyleDesc(s(ct.root(kbdTheme, vp, style)), resolveTokens(klass)));
</script>

<span use:applyStyle={resolved} {...rest}>{@render children?.()}</span>
