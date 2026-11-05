<script lang="ts">
	// passthrough stand-in for bits-ui primitives that need a real DOM
	// (Sheet/Tooltip) — renders children inline; the child-snippet API is
	// honored so callers keep working
	let { children, child, ...rest }: Record<string, any> = $props();
</script>

{#if child}
	{@render child({ props: rest })}
{:else}
	<div {...rest}>{@render children?.()}</div>
{/if}
