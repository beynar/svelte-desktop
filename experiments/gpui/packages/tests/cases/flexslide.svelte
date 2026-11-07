<script lang="ts">
	import { slide } from 'svelte/transition';
	let open = $state(true);
</script>

<div style="width: 400px;">
	<div class="stage">
		{#if open}
			<div class="chip slide-chip" out:slide={{ duration: 160 }}>slide</div>
		{/if}
	</div>
	<button onclick={() => (open = !open)}>toggle</button>
</div>

<style>
	.stage {
		position: relative;
		height: 72px;
		border-radius: 8px;
		background-color: #232329;
		border-width: 1px;
		border-color: #2e2e36;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
	}
	.chip {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 8px 18px;
		border-radius: 8px;
		font-size: 12px;
		font-weight: 600;
		color: #ffffff;
	}
	.slide-chip {
		background-color: #30d158;
	}
</style>
