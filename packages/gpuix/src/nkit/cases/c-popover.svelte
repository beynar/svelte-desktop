<script>
	import Popover from '../Popover.svelte';
	let open = $state(false);
	let clicks = $state(0);
</script>
<div style="padding:60px">
	<div onclick={() => clicks++}>clk-probe</div>
	<Popover bind:open>
		{#snippet trigger()}<div>pop-trig</div>{/snippet}
		<div>pop-body</div>
	</Popover>
</div>
<div style="position:absolute;left:300px;top:300px">outside-spot</div>
<div>pop-state={open} clicks={clicks}</div>
