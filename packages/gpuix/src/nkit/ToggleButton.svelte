<script>
	import Button from './Button.svelte';

	let {
		pressed = $bindable(null),
		value,                 // svelai name for `pressed`
		defaultValue,
		variant ,
		color,
		size ,
		onchange,
		onValueChange,
		onclick,
		...rest
	} = $props();

	pressed ??= value ?? defaultValue ?? false;
</script>

<Button
	variant={pressed ? 'solid' : variant}
	{color}
	{size}
	aria-pressed={pressed}
	onclick={(e) => {
		pressed = !pressed;
		onchange?.(pressed);
		onValueChange?.(pressed);
		onclick?.(e);
	}}
	{...rest}
/>
