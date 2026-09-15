<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { recipe } from './recipe.js';

	const diffWrapTheme = recipe({
		base: { bg: 'surface-recessed', radius: 'md', borderW: 1, border: 'neutral-muted', overflow: 'hidden' },
	});

	let {
		patch = '',
		wordDiff = true,
		collapsedPaths,
		scroll = false,
		maxLines,
		theme,
		framed = true,
		ontogglefile,
		onshowmore,
		onlineclick,
		class: klass = '',
		style = null,
		...rest
	} = $props();

	const wrapS = $derived(mergeStyleDesc(s(diffWrapTheme({ style })), resolveTokens(klass)));
	const bare = $derived(mergeStyleDesc(s(style ?? {}), resolveTokens(klass)));
	const props = $derived({
		patch, wordDiff,
		...(collapsedPaths ? { collapsedPaths } : {}),
		...(scroll ? { scroll: true } : {}),
		...(maxLines != null ? { maxLines } : {}),
		...(theme ? { theme } : {}),
	});
</script>

{#if framed}
	<div use:applyStyle={wrapS}>
		<diff use:nativeProps={props} {ontogglefile} {onshowmore} {onlineclick} {...rest}></diff>
	</div>
{:else}
	<diff use:nativeProps={props} use:applyStyle={bare} {ontogglefile} {onshowmore} {onlineclick} {...rest}></diff>
{/if}
