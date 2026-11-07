<script>
	import { slide } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	let open = $state(true);
	let sideOpen = $state(true);
	let chipOpen = $state(true);

	// mirror of app/+layout collapseX — horizontal collapse via width
	function collapseX(node, { duration = 160 } = {}) {
		const w = parseFloat(getComputedStyle(node).width) || 200;
		return {
			duration,
			easing: cubicOut,
			css: (t) =>
				`overflow: hidden; width: ${t * w}px; border-right-width: ${t}px; opacity: ${t}`,
		};
	}
</script>
<div>
	{#if open}
		<div
			class="panel"
			style="height: 60px; width: 120px"
			in:slide={{ duration: 160 }}
			out:slide={{ duration: 160 }}
		>
			<span>sliding</span>
		</div>
	{/if}
	<button onclick={() => (open = !open)}>toggle</button>
	{#if chipOpen}
		<div
			class="chip"
			style="display: flex; align-items: center; padding: 8px 18px; font-size: 12px;"
			in:slide={{ duration: 160 }}
			out:slide={{ duration: 160 }}
		>
			<span>chiptext</span>
		</div>
	{/if}
	<button onclick={() => (chipOpen = !chipOpen)}>chiptoggle</button>
	{#if sideOpen}
		<div
			class="rail"
			style="width: 200px; border-right-width: 1px"
			in:collapseX={{ duration: 160 }}
			out:collapseX={{ duration: 160 }}
		>
			<span>railcontent</span>
		</div>
	{/if}
	<button onclick={() => (sideOpen = !sideOpen)}>side</button>
</div>
