<script>
	let { data, children } = $props();
	let clicks = $state(0); // survives navigation if the layout isn't remounted
</script>

<div style="display: flex; flexDirection: column; gap: 10px; padding: 20px; backgroundColor: #0f1115; height: 600px">
	<div style="color: #e5e7eb; fontSize: 14px">
		app chrome — user:{data.user} · server-user:{data.serverUser ?? '…'}
	</div>
	<div
		style="color: #fbbf24; fontSize: 12px"
		onclick={() => clicks++}
	>
		layout-clicks:{clicks}
	</div>
	<div style="display: flex; flexDirection: row; gap: 12px; color: #60a5fa; fontSize: 12px">
		<a href="/" style="color: #60a5fa">home</a>
		<a href="/about" style="color: #60a5fa">about</a>
		<a href="/item/7" style="color: #60a5fa">item 7</a>
	</div>
	{@render children()}
</div>
