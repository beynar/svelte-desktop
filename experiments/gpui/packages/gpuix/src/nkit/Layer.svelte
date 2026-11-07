<script>
	import { mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { layerProps } from './overlay.js';
	import { fso } from './transitions.js';

	// Anchored overlay in the gpuix idiom: `anchored` floats relative to its
	// parent element (side/align/gap/fit) — the consumer must nest Layer next to
	// its trigger under a tight wrapper. `at` switches to absolute point anchor.
	// Outside-dismiss: `occlude` + a focused content child → the native side
	// reports `mouseDownOutside` to the focused element; it bubbles here.
	//
	// `motion` = resolved {in: MotionProps, out: {spec,transition,ms}} — enter
	// runs on the GPU (native motion prop), exit through `out:fso` (Svelte
	// keeps the element alive for the outro).
	let {
		open = false,
		at = null,              // {x,y} absolute point (context-menu mode)
		side = 'bottom',
		align = 'center',
		gap = 6,
		onclose,
		motion = null,          // resolved component motion {in,out,spec}
		content,                // snippet rendered inside the floating box
		class: klass = '',
		style = null,
		...rest
	} = $props();

	const anchoredProps = $derived(
		layerProps({ side, align, gap, at }),
	);
	// `style` arrives already resolved (consumers pass StyleDesc) — merge, don't re-resolve
	const contentS = $derived(mergeStyleDesc(style ?? {}, resolveTokens(klass)));
	// out-transition params: raw spec frames + resolved ms/ease (fso accepts both)
	const outParams = $derived(
		motion?.out ? { ...motion.spec?.out, duration: motion.out.ms, easing: motion.out.transition.ease } : { duration: 0 },
	);

	// mouseDownOutside is emitted for elements that own BOTH the listener and a
	// FocusHandle (key/focus listeners + tabIndex). The content div carries all
	// of it; the anchored layer just floats.
	const arm = (el) => {
		el.addEventListener('keydown', (e) => {
			const k = e.key ?? e.detail?.key;
			if (k === 'escape') onclose?.();
		});
		el.addEventListener('focus', () => {});
		el.addEventListener('mousedownoutside', () => onclose?.());
		el.focus();
	};
</script>

{#if open}
	<anchored use:nativeProps={anchoredProps}>
		<div
			use:applyStyle={contentS}
			use:nativeProps={motion?.in ? { tabIndex: 0, motion: motion.in } : { tabIndex: 0 }}
			out:fso={outParams}
			use:arm
			{...rest}
		>
			{@render content?.()}
		</div>
	</anchored>
{/if}
