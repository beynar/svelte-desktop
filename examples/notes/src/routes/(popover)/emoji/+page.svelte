<script lang="ts">
	import PopoverContent from '@svelte-desktop/shell/platform/PopoverContent.svelte';
	import { broadcast, closePopover } from '@svelte-desktop/shell/platform';
	const emojis = ['😀', '🎉', '✅', '🔥', '💡', '📌', '🚀', '❤️', '👀', '🙏', '☕️', '🌈'];
	async function pick(e: string) {
		await broadcast('emoji', e);
		await closePopover();
	}
</script>

<PopoverContent>
	<div style="display:grid; grid-template-columns:repeat(6, 1fr); gap:4px">
		{#each emojis as e (e)}
			<button style="font-size:20px; padding:4px" onclick={() => pick(e)}>{e}</button>
		{/each}
	</div>
</PopoverContent>
