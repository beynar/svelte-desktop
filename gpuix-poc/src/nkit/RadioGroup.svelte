<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { radioTheme } from './recipes/form.js';

	let {
		options = [],          // [{value, label, disabled?}]
		value = $bindable(null),
		defaultValue,
		disabled = false,
		color,
		onchange,
		onValueChange,
		class: klass = '',
		style = null,
		theme = null,
		...rest
	} = $props();

	const ct = useComponentTheme('radioGroup', theme, ['circle', 'dot', 'label']);
	const vp = $derived(ct.props({ color, disabled }));
	const ctx = $derived({ color: vp.color });
	const groupS = $derived(mergeStyleDesc(s(ct.root(radioTheme.group, vp, style)), resolveTokens(klass, ctx)));
	const circleS = (checked, dis) => s(ct.slot('circle', radioTheme.circle, { ...vp, checked, disabled: vp.disabled || dis }), ctx);
	const dotS = $derived(s(ct.slot('dot', radioTheme.dot, vp), ctx));
	const labelS = $derived(s(ct.slot('label', radioTheme.label, vp), ctx));
	value ??= defaultValue;
	const pick = (o) => {
		if (disabled || o.disabled || value === o.value) return;
		value = o.value;
		onchange?.(o.value);
		onValueChange?.(o.value);
	};
	const keyPick = (o, e) => {
		const k = e.key ?? e.detail?.key;
		if (k === 'enter' || k === 'space') { pick(o); e.preventDefault?.(); }
	};
</script>

<div use:applyStyle={groupS} role="radiogroup" {...rest}>
	{#each options as o}
		{@const checked = value === o.value}
		<span style="display:flex;align-items:center;gap:8px">
			<div
				use:applyStyle={circleS(checked, o.disabled)}
				use:nativeProps={{ tabIndex: disabled || o.disabled ? undefined : 0 }}
				onclick={() => pick(o)}
				onkeydown={(e) => keyPick(o, e)}
				role="radio" aria-checked={checked}
			>
				{#if checked}<div use:applyStyle={dotS}></div>{/if}
			</div>
			{#if o.label != null}<span use:applyStyle={labelS} onclick={() => pick(o)}>{o.label}</span>{/if}
		</span>
	{/each}
</div>
