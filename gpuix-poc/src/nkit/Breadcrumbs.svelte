<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { breadcrumbsTheme } from './recipes/nav.js';

	let { items = [], onnavigate, class: klass = '', style = null, theme = null, ...rest } = $props();
	const ct = useComponentTheme('breadcrumbs', theme, ['link', 'sep']);
	const vp = $derived(ct.props({}));
	const rootS = $derived(mergeStyleDesc(s(ct.root(breadcrumbsTheme.root, vp, style)), resolveTokens(klass)));
	const linkS = (cur) => s(ct.slot('link', breadcrumbsTheme.link, { ...vp, current: cur }));
	const sepS = $derived(s(ct.slot('sep', breadcrumbsTheme.sep, vp)));
</script>

<div use:applyStyle={rootS} {...rest}>
	{#each items as it, i}
		{@const last = i === items.length - 1}
		<span
			use:applyStyle={linkS(last)}
			onclick={() => { if (!last) onnavigate?.(it); }}
		>{it.label}</span>
		{#if !last}<span use:applyStyle={sepS}>/</span>{/if}
	{/each}
</div>
