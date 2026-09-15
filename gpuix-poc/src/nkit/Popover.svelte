<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { useComponentTheme } from './theming.svelte.js';
	import Layer from './Layer.svelte';
	import { popoverTheme, popoverMotion } from './recipes/overlay.js';

	let {
		open = $bindable(null),
		defaultOpen = false,
		side ,
		align ,
		position,               // 'bottom-start' style — overrides side/align
		gap,                    // px — `offset` is the svelai name
		offset,
		fitTrigger = false,     // content width = trigger width
		openOnHover = false,
		closeOnEscape = true,
		trigger,
		class: klass = '',
		style = null,
		theme = null,           // instance theme: {root/panel: StyleProps, motion}
		transition,             // instance FSO transition — wins the motion ladder
		children,
		onclose,
		onOpenChange,
	} = $props();

	open ??= defaultOpen;
	const ct = useComponentTheme('popover', theme, ['panel']);
	const vp = $derived(ct.props({ side, align }));
	const [pSide, pAlign] = $derived(
		position ? position.split('-') : [vp.side, vp.align],
	);
	const mv = $derived(ct.motion(popoverMotion, vp, transition));
	const effGap = $derived(offset ?? gap ?? 6);
	let triggerEl = $state(null);
	let closedAt = 0; // a press that dismissed the layer must not re-open it
	const contentS = $derived(mergeStyleDesc(s(ct.root(popoverTheme, vp, style)), resolveTokens(klass)));
	const setOpen = (v) => { if (open === v) return; open = v; onOpenChange?.(v); if (!v) { closedAt = Date.now(); onclose?.(); } };
	const toggle = () => { if (open) setOpen(false); else if (Date.now() - closedAt >= 300) setOpen(true); };
	const onKey = (e) => {
		if (open && closeOnEscape && (e.key === 'escape' || e.detail?.key === 'escape')) setOpen(false);
	};
	// fitTrigger: constrain the floating box to the trigger's width
	const fitS = $derived.by(() => {
		if (!fitTrigger || !open) return null;
		const r = triggerEl?.getBoundingClientRect?.();
		return r ? { w: r.width } : null;
	});
</script>

<svelte:window onkeydown={onKey} />
<div style="display:flex;position:relative;align-items:start;align-self:flex-start">
	<span
		bind:this={triggerEl}
		style="display:flex;align-self:flex-start"
		onclick={toggle}
		onmouseenter={() => { if (openOnHover) setOpen(true); }}
		onmouseleave={() => { if (openOnHover) setOpen(false); }}
	>
		{@render trigger?.()}
	</span>
	<Layer
		{open}
		side={pSide} align={pAlign} gap={effGap}
		onclose={() => setOpen(false)}
		style={mergeStyleDesc(contentS, fitS)}
		motion={mv}
	>
		{#snippet content()}{@render children?.()}{/snippet}
	</Layer>
</div>
