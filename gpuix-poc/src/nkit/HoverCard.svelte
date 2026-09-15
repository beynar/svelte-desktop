<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { hoverCardTheme, hoverCardMotion } from './recipes/overlay.js';
	import { anchorAt } from './overlay.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { fso } from './transitions.js';

	let {
		side ,
		align ,
		delay = 300,
		class: klass = '',
		style = null,
		theme = null,
		transition,
		trigger,
		children,
		...rest
	} = $props();

	import { onDestroy } from 'svelte';

	const ct = useComponentTheme('hoverCard', theme);
	const vp = $derived(ct.props({ side, align }));
	const mv = $derived(ct.motion(hoverCardMotion, {}, transition));
	let triggerEl = $state(null);
	let show = $state(false);
	let timer = null;
	const enter = () => { clearTimeout(timer); timer = setTimeout(() => (show = true), delay); };
	const leave = () => { clearTimeout(timer); timer = setTimeout(() => (show = false), 150); }; // grace to reach the card
	onDestroy(() => clearTimeout(timer));
	const contentS = $derived(mergeStyleDesc(s(ct.root(hoverCardTheme, vp, style)), resolveTokens(klass)));
	const anchoredProps = $derived.by(() => {
		void show; // re-derive on every open — rect reads are untracked
		const r = triggerEl?.getBoundingClientRect?.();
		if (!r) return { side, align };
		const y = side === 'top' ? r.y - 4 : r.y + r.height + 4;
		return anchorAt(r.x, y, { side, align });
	});
</script>

<span bind:this={triggerEl} style="display:flex;align-self:flex-start" onmouseenter={enter} onmouseleave={leave}>
	{@render trigger?.()}
</span>
{#if show && triggerEl}
	<anchored
		use:nativeProps={{ ...anchoredProps, motion: mv?.in ?? undefined }}
		use:applyStyle={contentS}
		out:fso={mv?.out ? { ...mv.spec?.out, duration: mv.out.ms, easing: mv.out.transition.ease } : { duration: 0 }}
		onmouseenter={() => clearTimeout(timer)}
		onmouseleave={leave}
		{...rest}
	>{@render children?.()}</anchored>
{/if}
