<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { segmentedTheme } from './recipes/form.js';
	import { icons } from './icons.js';

	let {
		options,               // [{value, label, icon?, disabled?}] — `items` is the svelai alias
		items,
		value = $bindable(null),
		defaultValue,
		size ,
		color,
		disabled = false,
		onchange,
		onValueChange,
		class: klass = '',
		style = null,
		theme = null,
		...rest
	} = $props();

	const opts = $derived(items ?? options ?? []);
	const ct = useComponentTheme('segmentedControl', theme, ['item']);
	const vp = $derived(ct.props({ size, color, disabled }));
	const ctx = $derived({ color: vp.color });
	value ??= defaultValue;
	const rootS = $derived(mergeStyleDesc(s(ct.root(segmentedTheme.root, vp, style)), resolveTokens(klass, ctx)));
	const itemS = (active, dis) => s(ct.slot('item', segmentedTheme.item, { ...vp, active, disabled: vp.disabled || dis }), ctx);
	const pick = (o) => {
		if (disabled || o.disabled || value === o.value) return;
		value = o.value;
		onchange?.(o.value);
		onValueChange?.(o.value);
	};
</script>

<div use:applyStyle={rootS} role="tablist" aria-disabled={disabled || undefined} {...rest}>
	{#each opts as o}
		{@const active = value === o.value}
		<div
			use:applyStyle={itemS(active, o.disabled)}
			use:nativeProps={{ tabIndex: disabled || o.disabled ? undefined : 0 }}
			onclick={() => pick(o)}
			onkeydown={(e) => { const k = e.key ?? e.detail?.key; if (k === 'enter' || k === 'space') { pick(o); e.preventDefault?.(); } }}
			role="tab" aria-selected={active}
		>{#if o.icon && icons[o.icon]}<svg use:nativeProps={{ source: icons[o.icon] }} style="width:14px;height:14px"></svg>{/if}{o.label ?? o.value}</div>
	{/each}
</div>
