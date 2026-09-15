<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { checkboxTheme } from './recipes/form.js';
	import { icons } from './icons.js';

	let {
		checked = $bindable(null),
		defaultChecked = false,
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

	const ct = useComponentTheme('checkbox', theme, ['check', 'label']);
	const vp = $derived(ct.props({ color, disabled }));
	const ctx = $derived({ color: vp.color });
	checked ??= defaultChecked || defaultValue || false;
	const toggle = () => {
		if (disabled) return;
		checked = !checked;
		onchange?.(checked);
		onValueChange?.(checked);
	};
	const keyToggle = (e) => {
		const k = e.key ?? e.detail?.key;
		if (k === 'enter' || k === 'space') { toggle(); e.preventDefault?.(); }
		onkeydown?.(e);
	};
	const boxS = $derived(
		mergeStyleDesc(s(ct.root(checkboxTheme.box, { ...vp, checked }, style), ctx), resolveTokens(klass, ctx)),
	);
	const checkS = $derived(s(ct.slot('check', checkboxTheme.check, vp), ctx));
	const labelS = $derived(s(ct.slot('label', checkboxTheme.label, vp), ctx));
</script>

<span style="display:flex;align-items:center;gap:8px">
	<div
		use:applyStyle={boxS}
		use:nativeProps={{ tabIndex: disabled ? undefined : 0 }}
		onclick={(e) => { toggle(); onclick?.(e); }}
		onkeydown={keyToggle}
		role="checkbox" aria-checked={checked} {...rest}
	>
		{#if checked}<svg use:nativeProps={{ source: icons.check }} use:applyStyle={checkS}></svg>{/if}
	</div>
	{#if label}<span use:applyStyle={labelS} onclick={toggle}>{label}</span>{/if}
</span>
