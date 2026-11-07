<script lang="ts">
	import { cn } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		orientation = "horizontal",
		"data-slot": dataSlot = "separator",
		...restProps
	}: Record<string, any> = $props();
</script>

<div
	bind:this={ref}
	role="separator"
	aria-orientation={orientation}
	data-slot={dataSlot}
	data-horizontal={orientation === "horizontal" ? "" : undefined}
	data-vertical={orientation === "vertical" ? "" : undefined}
	class={cn(
		"shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch",
		className
	)}
	{...restProps}
></div>
