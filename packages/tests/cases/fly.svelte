<script>
	import { fly, scale } from 'svelte/transition';
	let flyOn = $state(true);
	let scaleOn = $state(true);
</script>
<div>
	{#if flyOn}
		<div
			class="flybox"
			style="width: 100px; height: 40px; position: absolute; left: 20px; top: 60px; background: red"
			in:fly={{ y: -60, duration: 160 }}
			out:fly={{ y: -60, duration: 160 }}
		>
			<span>flyme</span>
		</div>
	{/if}
	<button onclick={() => (flyOn = !flyOn)}>flytoggle</button>
	{#if scaleOn}
		<div
			class="scalebox"
			style="width: 80px; height: 80px; position: absolute; left: 200px; top: 200px; background: blue"
			in:scale={{ start: 0, duration: 160 }}
			out:scale={{ start: 0, duration: 160 }}
		>
			<span>scaleme</span>
		</div>
	{/if}
	<button onclick={() => (scaleOn = !scaleOn)}>scaletoggle</button>
</div>
