<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import Button from './Button.svelte';

	// Joined row of buttons — pass `options` for a data-driven group or
	// use the default slot with your own <Button>s.
	let {
		options = [],          // [{label, value, icon?, disabled?}]
		value = $bindable(null),
		defaultValue,
		variant ,
		color,
		size ,
		disabled = false,
		onchange,
		onValueChange,
		class: klass = '',
		style = null,
		theme = null,
		children,
		...rest
	} = $props();

	value ??= defaultValue;
	const ct = useComponentTheme('buttonGroup', theme);
	const vp = $derived(ct.props({ variant, color, size, disabled }));
	const rootS = $derived(mergeStyleDesc(s(ct.root({ row: true }, vp, style)), resolveTokens(klass)));
	const pick = (o) => {
		if (disabled || o.disabled || value === o.value) return;
		value = o.value;
		onchange?.(o.value);
		onValueChange?.(o.value);
	};
</script>

<div use:applyStyle={rootS} role="group" {...rest}>
	{#if children}
		{@render children()}
	{:else}
		{#each options as o, i}
			{@const ov = o.value ?? o.label ?? i}
			<Button
				variant={value === ov ? 'solid' : vp.variant}
				color={value === ov ? vp.color : 'neutral'}
				size={vp.size}
				disabled={vp.disabled || o.disabled}
				label={o.label ?? o.value}
				onclick={() => pick({ ...o, value: ov })}
				aria-pressed={value === ov}
			/>
		{/each}
	{/if}
</div>
