<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { slide } from './transitions.js';
	import { icons } from './icons.js';

	let {
		open = $bindable(null),
		defaultOpen = false,
		disabled = false,
		trigger,               // snippet — header content (or `title`)
		title,
		showChevron = true,
		onOpenChange,
		class: klass = '',
		style = null,
		theme = null,
		children,
		...rest
	} = $props();

	open ??= defaultOpen;
	const ct = useComponentTheme('collapsible', theme, ['trigger', 'chevron', 'content']);
	const vp = $derived(ct.props({ disabled }));
	const rootS = $derived(mergeStyleDesc(s(ct.root({ col: true }, vp, style)), resolveTokens(klass)));
	const triggerS = $derived(
		s(ct.slot('trigger', { row: true, justify: 'between', items: 'center', w: 'full', cursor: 'pointer', select: 'none', fg: 'neutral', fontW: 500, text: 'sm', ...(disabled ? { opacity: 0.5, pointerEvents: 'none' } : {}) }, vp)),
	);
	const chevS = $derived(s(ct.slot('chevron', { icon: 'md', fg: 'neutral-readable', shrink: 0 }, vp)));
	const toggle = () => { if (disabled) return; open = !open; onOpenChange?.(open); };
</script>

<div use:applyStyle={rootS} {...rest}>
	<div
		use:applyStyle={triggerS}
		use:nativeProps={{ tabIndex: disabled ? undefined : 0 }}
		onclick={toggle}
		onkeydown={(e) => { const k = e.key ?? e.detail?.key; if (k === 'enter' || k === 'space') { toggle(); e.preventDefault?.(); } }}
		role="button" aria-expanded={open}
	>
		{#if trigger}{@render trigger()}{:else}<span>{title}</span>{/if}
		{#if showChevron}<svg use:nativeProps={{ source: icons[open ? 'chevron-up' : 'chevron-down'] }} use:applyStyle={chevS}></svg>{/if}
	</div>
	{#if open}
		<div
			use:applyStyle={s(ct.slot('content', {}, vp))}
			transition:slide={{
				duration: ct.state.preferReducesMotion ? 0 : ct.state.motion.duration.normal,
				easing: ct.state.motion.easing.standard,
			}}
		>{@render children?.()}</div>
	{/if}
</div>
