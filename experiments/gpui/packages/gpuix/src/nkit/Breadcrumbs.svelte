<script>
	import { style, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { componentTheme } from './theming.svelte.js';
	import { breadcrumbsTheme } from './recipes/nav.js';

	let { items = [], onnavigate, class: klass = '', style: instStyle = null, theme = null, ...rest } = $props();
	const ct = componentTheme('breadcrumbs', () => theme, ['link', 'sep']);
	const vp = $derived(ct.props({}));
	const rootS = $derived(mergeStyleDesc(style(ct.root(breadcrumbsTheme.root, vp, instStyle)), resolveTokens(klass)));
	const linkS = (cur) => style(ct.slot('link', breadcrumbsTheme.link, { ...vp, current: cur }));
	const sepS = $derived(style(ct.slot('sep', breadcrumbsTheme.sep, vp)));
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
