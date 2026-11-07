<script>
	import { style, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { componentTheme } from './theming.svelte.js';
	import { separatorTheme } from './recipes/display.js';

	let { orientation = 'horizontal', class: klass = '', style: instStyle = null, theme = null, ...rest } = $props();
	const ct = componentTheme('separator', () => theme);
	const vp = $derived(ct.props({ orientation }));
	const resolved = $derived(
		mergeStyleDesc(style(ct.root(separatorTheme, vp, instStyle)), resolveTokens(klass)),
	);
</script>

<div use:applyStyle={resolved} role="separator" {...rest}></div>
