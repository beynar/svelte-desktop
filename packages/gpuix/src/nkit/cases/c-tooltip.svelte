<script>
	import Tooltip from '../Tooltip.svelte';
	import HoverCard from '../HoverCard.svelte';
</script>
<div style="padding:100px">
	<Tooltip text="tt-text" delay={50}><div>tt-host</div></Tooltip>
	<HoverCard delay={50}>
		{#snippet trigger()}<div>hc-host</div>{/snippet}
		<div>hc-body</div>
	</HoverCard>
</div>
