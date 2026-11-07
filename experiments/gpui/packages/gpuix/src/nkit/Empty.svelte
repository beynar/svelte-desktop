<script>
	import { style, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { componentTheme } from './theming.svelte.js';
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
		style: instStyle = null,
		theme = null,
		children,
		...rest
	} = $props();

	const ct = componentTheme('empty', () => theme, ['icon', 'iconWrap', 'title', 'description', 'note', 'actions']);
	const vp = $derived(ct.props({ size, bordered }));
	const rootS = $derived(mergeStyleDesc(style(ct.root(emptyTheme.root, vp, instStyle)), resolveTokens(klass)));
	const iconS = $derived(style(ct.slot('icon', emptyTheme.icon, vp)));
	const iconWrapS = $derived(style(ct.slot('iconWrap', emptyTheme.iconWrap, vp)));
	const titleS = $derived(style(ct.slot('title', emptyTheme.title, vp)));
	const descS = $derived(style(ct.slot('description', emptyTheme.description, vp)));
	const noteS = $derived(style(ct.slot('note', emptyTheme.note, vp)));
	const actionsS = $derived(style(ct.slot('actions', emptyTheme.actions, vp)));
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
