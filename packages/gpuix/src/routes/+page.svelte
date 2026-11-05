<script>
	import { goto, invalidate, navigating } from '#kit';
	let { data } = $props();
</script>

<div style="color: #e5e7eb; fontSize: 13px">
	home — {data.greeting} · n={data.n} · notes-in-db:{data.noteCount} · via-data:{data.viaData} ·
	psv:{data.psv} psrv:{data.psrv}
</div>
<div
	style="backgroundColor: #3b82f6; borderRadius: 6px; padding: 8px; color: #fff"
	onclick={() => invalidate('home')}
>
	reload home load
</div>
<div
	style="backgroundColor: #374151; borderRadius: 6px; padding: 8px; color: #fff"
	onclick={() => goto('/item/42')}
>
	goto /item/42
</div>
<form method="POST" action="/action?/named">
	<input name="note" value="xpage" />
	<button style="color: #fff">cross-page post</button>
</form>
<div style="color: #9ca3af; fontSize: 12px">
	navigating: {navigating.to?.url.pathname ?? 'idle'}
</div>
