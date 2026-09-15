<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { emptyTheme } from './recipes/display.js';
	import { icons } from './icons.js';

	let {
		icon = 'file',
		media,                   // snippet — replaces icon when provided
		mediaVariant = 'plain',  // plain | framed (muted tile behind media)
		title,
		description,
		note,                    // smaller helper line under the description
		actions,                 // snippet — buttons row
		size ,
		bordered = false,
		class: klass = '',
		style = null,
		theme = null,
		children,
		...rest
	} = $props();

	const ct = useComponentTheme('empty', theme, ['icon', 'iconWrap', 'title', 'description', 'note', 'actions']);
	const vp = $derived(ct.props({ size, bordered }));
	const rootS = $derived(mergeStyleDesc(s(ct.root(emptyTheme.root, vp, style)), resolveTokens(klass)));
	const iconS = $derived(s(ct.slot('icon', emptyTheme.icon, vp)));
	const iconWrapS = $derived(s(ct.slot('iconWrap', emptyTheme.iconWrap, vp)));
	const titleS = $derived(s(ct.slot('title', emptyTheme.title, vp)));
	const descS = $derived(s(ct.slot('description', emptyTheme.description, vp)));
	const noteS = $derived(s(ct.slot('note', emptyTheme.note, vp)));
	const actionsS = $derived(s(ct.slot('actions', emptyTheme.actions, vp)));
</script>

<div use:applyStyle={rootS} {...rest}>
	{#if media}
		<div use:applyStyle={mediaVariant === 'framed' ? iconWrapS : null}>{@render media()}</div>
	{:else if icon}
		<svg use:nativeProps={{ source: icons[icon] ?? icon }} use:applyStyle={mediaVariant === 'framed' ? iconWrapS : iconS}></svg>
	{/if}
	{#if title}<div use:applyStyle={titleS}>{title}</div>{/if}
	{#if description}<div use:applyStyle={descS}>{description}</div>{/if}
	{@render children?.()}
	{#if note}<div use:applyStyle={noteS}>{note}</div>{/if}
	{#if actions}<div use:applyStyle={actionsS}>{@render actions()}</div>{/if}
</div>
