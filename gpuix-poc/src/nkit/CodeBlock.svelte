<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { recipe } from './recipe.js';

	const codeWrapTheme = recipe({
		base: { bg: 'surface-recessed', radius: 'md', p: 'lg', borderW: 1, border: 'neutral-muted', overflow: 'hidden' },
	});

	let {
		code = '',
		language,
		path,
		showLineNumbers = false,
		theme,
		framed = true,
		class: klass = '',
		style = null,
		...rest
	} = $props();

	const wrapS = $derived(mergeStyleDesc(s(codeWrapTheme({ style })), resolveTokens(klass)));
	const bare = $derived(mergeStyleDesc(s(style ?? {}), resolveTokens(klass)));
	const props = $derived({ code, ...(language ? { language } : {}), ...(path ? { path } : {}), showLineNumbers, ...(theme ? { theme } : {}) });
</script>

{#if framed}
	<div use:applyStyle={wrapS}>
		<code use:nativeProps={props} {...rest}></code>
	</div>
{:else}
	<code use:nativeProps={props} use:applyStyle={bare} {...rest}></code>
{/if}
