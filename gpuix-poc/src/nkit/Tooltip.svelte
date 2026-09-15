<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { tooltipTheme, tooltipMotion } from './recipes/overlay.js';
	import { anchorAt } from './overlay.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { fso } from './transitions.js';

	let {
		text,
		side,                  // top | bottom | left | right — `position` accepts 'top-center' style
		position,
		align ,
		delay = 400,
		open = $bindable(null), // controlled mode — hover drives it when unbound
		defaultOpen = false,
		onOpenChange,
		class: klass = '',
		style = null,
		theme = null,
		transition,
		children,
		...rest
	} = $props();

	import { onDestroy } from 'svelte';

	const ct = useComponentTheme('tooltip', theme);
	const vp = $derived(ct.props({ side, align }));
	const mv = $derived(ct.motion(tooltipMotion, {}, transition));
	const [pSide, pAlign] = $derived(position ? position.split('-') : [vp.side ?? 'top', vp.align]);
	let triggerEl = $state(null);
	let hovered = $state(false);
	const show = $derived(open ?? (defaultOpen || hovered));
	let timer = null;
	const setHover = (v) => { if (open == null) hovered = v; onOpenChange?.(v); };
	const enter = () => { clearTimeout(timer); timer = setTimeout(() => setHover(true), delay); };
	const leave = () => { clearTimeout(timer); setHover(false); };
	onDestroy(() => clearTimeout(timer));
	const contentS = $derived(mergeStyleDesc(s(ct.root(tooltipTheme, vp, style)), resolveTokens(klass)));
	const outParams = $derived(
		mv?.out ? { ...mv.spec?.out, duration: mv.out.ms, easing: mv.out.transition.ease } : { duration: 0 },
	);
	const anchoredProps = $derived.by(() => {
		void show; // re-derive on every open — rect reads are untracked
		const r = triggerEl?.getBoundingClientRect?.();
		if (!r) return { side: pSide, align: pAlign };
		return anchorAt(r.x + r.width / 2, pSide === 'top' ? r.y : r.y + r.height, { side: pSide, align: pAlign });
	});
</script>

<span
	bind:this={triggerEl}
	style="display:flex;align-self:flex-start"
	onmouseenter={enter}
	onmouseleave={leave}
>
	{@render children?.()}
</span>
{#if show && triggerEl}
	<anchored
		use:nativeProps={{ ...anchoredProps, deferred: true, motion: mv?.in ?? undefined }}
		use:applyStyle={contentS}
		out:fso={outParams}
		{...rest}
	>{text}</anchored>
{/if}
