<script>
	import View from './View.svelte';

	let {
		orientation = 'vertical',
		gap = 'md',
		align = 'stretch',
		justify = 'start',
		padding,
		wrap = false,
		children,
		...rest
	} = $props();

	const tokens = $derived(
		`flex ${orientation === 'horizontal' ? 'flex-row' : 'flex-col'} gap-${gap} items-${align} justify-${justify}` +
			(wrap ? ' flex-wrap' : '') +
			(padding != null ? ` p-${padding}` : ''),
	);
</script>

<View {tokens} {...rest}>{@render children?.()}</View>
