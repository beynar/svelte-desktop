<script lang="ts">
	import { Kanban } from 'entasis/kanban';
	import { board } from '#lib/data.svelte';
</script>

<div class="h-full overflow-x-auto p-6">
	<Kanban bind:columns={board.columns} columnHeight="calc(100vh - 12rem)" />
</div>
