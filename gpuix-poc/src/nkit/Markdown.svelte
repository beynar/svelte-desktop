<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';

	let { source = '', theme, onlinkclick, class: klass = '', style = null, ...rest } = $props();
	const resolved = $derived(mergeStyleDesc(s({ ...(style ?? {}) }), resolveTokens(klass)));
</script>

<markdown
	use:applyStyle={resolved}
	use:nativeProps={{ source, ...(theme ? { theme } : {}) }}
	onlinkclick={onlinkclick}
	{...rest}
></markdown>
