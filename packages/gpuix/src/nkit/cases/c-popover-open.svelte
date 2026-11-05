<script>
	import Popover from '../Popover.svelte';
</script>
<div style="padding:60px">
	<Popover open={true}>
		{#snippet trigger()}<div>pop-trig</div>{/snippet}
		<div>pop-body</div>
	</Popover>
</div>
