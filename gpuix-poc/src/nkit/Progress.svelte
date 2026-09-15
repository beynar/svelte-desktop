<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { progressTheme } from './recipes/display.js';
	import { useComponentTheme } from './theming.svelte.js';

	let {
		value = 0,
		max = 100,
		color,
		showLabel = false,
		class: klass = '',
		style = null,
		theme = null,
		...rest
	} = $props();

	const ct = useComponentTheme('progress', theme, ['track', 'fill', 'label']);
	const vp = $derived(ct.props({ color }));
	const ctx = $derived({ color: vp.color });
	const th = ct.state;

	const pct = $derived(max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0);
	const trackS = $derived(mergeStyleDesc(s(ct.slot('track', progressTheme.track, vp, style)), resolveTokens(klass, ctx)));
	const fillS = $derived(s(ct.slot('fill', progressTheme.fill, vp), ctx));
	const labelS = $derived(s(ct.slot('label', progressTheme.label, vp)));

	// WAAPI lane: width transitions between % steps (native motion needs px).
	// The action owns the width — initial set on mount, animate on change.
	const fillAnim = (el, arg) => {
		const setW = (p) => { el.style.props.set('width', `${p}%`); el.style.push?.(); };
		const pctOf = (a) => (a.max > 0 ? Math.max(0, Math.min(100, (a.value / a.max) * 100)) : 0);
		let last = pctOf(arg);
		setW(last);
		return {
			update(next) {
				const from = last, to = pctOf(next);
				last = to;
				if (th.preferReducesMotion || from === to) { setW(to); return; }
				el.animate?.([{ width: `${from}%` }, { width: `${to}%` }], { duration: th.motion.duration.normal });
			},
		};
	};
	// action args can't see value/max — drive updates via a $derived object
	const animArg = $derived({ value, max });
</script>

<div use:applyStyle={trackS} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} {...rest}>
	<div use:applyStyle={fillS} use:fillAnim={animArg}></div>
</div>
{#if showLabel}<div use:applyStyle={labelS}>{Math.round(pct)}%</div>{/if}
