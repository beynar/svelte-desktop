<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { skeletonTheme } from './recipes/display.js';
	import { useComponentTheme } from './theming.svelte.js';

	let { shape, w = 'full', h, class: klass = '', style = null, theme = null, ...rest } = $props();

	const ct = useComponentTheme('skeleton', theme);
	const vp = $derived(ct.props({ shape }));
	const th = ct.state;

	// shimmer lane: infinite alternate opacity pulse on the native side
	const shimmer = (el) => {
		if (th.preferReducesMotion) return;
		const a = el.animate?.(
			[{ opacity: 0.55 }, { opacity: 1 }],
			{ duration: th.motion.duration.slower * 2 || 1000, iterations: Infinity, direction: 'alternate' },
		);
		return { destroy: () => a?.cancel?.() };
	};

	const resolved = $derived(
		mergeStyleDesc(
			s(ct.root(skeletonTheme, { ...vp, style: { w, ...(h != null ? { h } : {}), ...(style ?? {}) } })),
			resolveTokens(klass),
		),
	);
</script>

<div use:applyStyle={resolved} use:shimmer aria-hidden="true" {...rest}></div>
