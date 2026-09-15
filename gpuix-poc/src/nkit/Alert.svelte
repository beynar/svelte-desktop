<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { alertTheme } from './recipes/display.js';
	import { icons } from './icons.js';

	let {
		color ,
		variant ,        // soft | solid | outline
		size ,
		title,
		description,
		icon,
		dismissible = false,
		onDismiss,
		class: klass = '',
		style = null,
		theme = null,
		children,
		...rest
	} = $props();

	let dismissed = $state(false);
	const ct = useComponentTheme('alert', theme, ['icon', 'title', 'body', 'close']);
	const vp = $derived(ct.props({ color, variant, size, dismissible }));
	const ctx = $derived({ color: vp.color });
	const resolved = $derived(
		mergeStyleDesc(s(ct.root(alertTheme.root, vp, style), ctx), resolveTokens(klass, ctx)),
	);
	const iconS = $derived(s(ct.slot('icon', alertTheme.icon, vp), ctx));
	const titleS = $derived(s(ct.slot('title', alertTheme.title, vp), ctx));
	const bodyS = $derived(s(ct.slot('body', alertTheme.body, vp), ctx));
	const closeS = $derived(s(ct.slot('close', alertTheme.close, vp), ctx));
	const defaultIcon = $derived(icons[vp.color === 'danger' ? 'error' : vp.color === 'warning' ? 'warning' : vp.color === 'success' ? 'success' : 'info']);
	const dismiss = () => { dismissed = true; onDismiss?.(); };
</script>

{#if !dismissed}
	<div use:applyStyle={resolved} role="alert" {...rest}>
		<svg use:nativeProps={{ source: icons[icon] ?? icon ?? defaultIcon }} use:applyStyle={iconS}></svg>
		<div use:applyStyle={bodyS}>
			{#if title}<div use:applyStyle={titleS}>{title}</div>{/if}
			{#if description}<div>{description}</div>{/if}
			{@render children?.()}
		</div>
		{#if dismissible}
			<svg use:nativeProps={{ source: icons.x, tabIndex: 0 }} use:applyStyle={closeS} onclick={dismiss} role="button" aria-label="Dismiss" />
		{/if}
	</div>
{/if}
