<!-- One board's Kanban; a board restored from a past session is made the first time it shows. -->
<script lang="ts">
	import { Kanban } from 'entasis/kanban';
	import { boardFor, boards } from '#lib/data.svelte';

	let { id }: { id: string } = $props();
	$effect.pre(() => void boardFor(id));
	const board = $derived(boards[id]);
</script>

{#if board}
	<Kanban bind:columns={() => board.columns, (columns) => (board.columns = columns)} columnHeight="calc(100vh - 15rem)" />
{/if}
