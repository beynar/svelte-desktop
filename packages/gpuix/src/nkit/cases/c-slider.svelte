<script>
	import Slider from '../Slider.svelte';
	let v = $state(0);
</script>
<div style="width:200px">
	<Slider bind:value={v} />
</div>
<div>sl={v}</div>
