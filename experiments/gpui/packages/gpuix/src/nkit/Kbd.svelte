<script>
	import { style, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { componentTheme } from './theming.svelte.js';
	import { kbdTheme } from './recipes/display.js';

	let { class: klass = '', style: instStyle = null, theme = null, children, ...rest } = $props();
	const ct = componentTheme('kbd', () => theme);
	const vp = $derived(ct.props({}));
	const resolved = $derived(mergeStyleDesc(style(ct.root(kbdTheme, vp, instStyle)), resolveTokens(klass)));
</script>

<span use:applyStyle={resolved} {...rest}>{@render children?.()}</span>
