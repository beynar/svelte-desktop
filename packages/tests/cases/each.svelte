<script>let items = $state(['a', 'b', 'c']);</script>
<div>
	{#each items as it (it)}<span>[{it}]</span>{/each}
	<button onclick={() => { items = [items[2], items[0]]; }}>reorder</button>
</div>
