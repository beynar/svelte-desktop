<script>let mode = $state('a');</script>
<div>
	{#if mode === 'a'}<span>AAA</span>
	{:else if mode === 'b'}<span>BBB</span>
	{:else}<span>CCC</span>{/if}
	<button onclick={() => (mode = mode === 'a' ? 'b' : 'c')}>swap</button>
</div>
