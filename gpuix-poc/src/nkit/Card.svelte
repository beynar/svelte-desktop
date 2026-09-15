<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { cardTheme } from './recipes/card.js';

	let {
		variant ,
		color,
		size ,
		density ,
		title,
		description,
		onclick,
		children,
		footer,
		action,              // snippet — right side of the header
		class: klass = '',
		style = null,
		theme = null,
		...rest
	} = $props();

	const ct = useComponentTheme('card', theme, ['header', 'title', 'description', 'content', 'footer']);
	const vp = $derived(ct.props({ variant, color, size, density, clickable: !!onclick }));
	const ctx = $derived({ color: vp.color });
	const root = $derived(
		mergeStyleDesc(
			s(ct.root(cardTheme.root, vp, style), ctx),
			resolveTokens(klass, ctx),
		),
	);
	const head = $derived(s(ct.slot('header', cardTheme.header, { ...vp, hasAction: !!action, hasBorder: !!title }), ctx));
	const titleS = $derived(s(ct.slot('title', cardTheme.title, vp), ctx));
	const descS = $derived(s(ct.slot('description', cardTheme.description, vp), ctx));
	const contentS = $derived(s(ct.slot('content', cardTheme.content, vp), ctx));
	const footerS = $derived(s(ct.slot('footer', cardTheme.footer, vp), ctx));
</script>

<div use:applyStyle={root} {onclick} {...rest}>
	{#if title || description || action}
		<div use:applyStyle={head}>
			<div>
				{#if title}<div use:applyStyle={titleS}>{title}</div>{/if}
				{#if description}<div use:applyStyle={descS}>{description}</div>{/if}
			</div>
			{#if action}{@render action()}{/if}
		</div>
	{/if}
	{#if children}<div use:applyStyle={contentS}>{@render children()}</div>{/if}
	{#if footer}<div use:applyStyle={footerS}>{@render footer()}</div>{/if}
</div>
