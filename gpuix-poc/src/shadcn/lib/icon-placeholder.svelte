<script lang="ts">
	// registry stub for lucide/tabler/etc icon sets — renders a glyph so the
	// trigger still has a visible affordance
	let { class: className, ...rest }: Record<string, any> = $props();
</script>

<span class={className} style="font-size:15px" {...rest}>☰</span>
