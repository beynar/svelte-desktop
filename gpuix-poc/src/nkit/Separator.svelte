<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { separatorTheme } from './recipes/display.js';

	let { orientation = 'horizontal', class: klass = '', style = null, theme = null, ...rest } = $props();
	const ct = useComponentTheme('separator', theme);
	const vp = $derived(ct.props({ orientation }));
	const resolved = $derived(
		mergeStyleDesc(s(ct.root(separatorTheme, vp, style)), resolveTokens(klass)),
	);
</script>

<div use:applyStyle={resolved} role="separator" {...rest}></div>
