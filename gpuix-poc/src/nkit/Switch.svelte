<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { switchTheme } from './recipes/form.js';

	let {
		on = $bindable(null),
		checked,                 // alias for `on`
		defaultValue,
		disabled = false,
		color,
		label,
		onchange,
		onValueChange,
		onclick,
		onkeydown,
		class: klass = '',
		style = null,
		theme = null,
		...rest
	} = $props();

	const ct = useComponentTheme('switch', theme, ['knob', 'label']);
	const vp = $derived(ct.props({ color, disabled }));
	const ctx = $derived({ color: vp.color });
	on ??= checked ?? defaultValue ?? false;
	const toggle = () => {
		if (disabled) return;
		on = !on;
		onchange?.(on);
		onValueChange?.(on);
	};
	const keyToggle = (e) => {
		const k = e.key ?? e.detail?.key;
		if (k === 'enter' || k === 'space') { toggle(); e.preventDefault?.(); }
		onkeydown?.(e);
	};
	const trackS = $derived(
		mergeStyleDesc(s(ct.root(switchTheme.track, { ...vp, on }, style), ctx), resolveTokens(klass, ctx)),
	);
	const knobS = $derived(s(ct.slot('knob', switchTheme.knob, { ...vp, style: { left: on ? 19 : 1 } }), ctx));
	const labelS = $derived(s(ct.slot('label', switchTheme.label, vp), ctx));
</script>

<span style="display:flex;align-items:center;gap:8px">
	<div
		use:applyStyle={trackS}
		use:nativeProps={{ tabIndex: disabled ? undefined : 0 }}
		onclick={(e) => { toggle(); onclick?.(e); }}
		onkeydown={keyToggle}
		role="switch" aria-checked={on} {...rest}
	>
		<div use:applyStyle={knobS}></div>
	</div>
	{#if label}<span use:applyStyle={labelS} onclick={toggle}>{label}</span>{/if}
</span>
