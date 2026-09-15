<script>
	import { getRequestEvent, refreshAll } from '#kit';
	import { query } from '#remote';
	let { data, form } = $props();

	// remote query — runs through handle; getRequestEvent works inside it
	const rq = query(() => getRequestEvent().locals.user)();
</script>

<div style="color: #e5e7eb">
	serverside — session:{data.session} · ip:{data.ip} · ev:{data.evUser} ·
	read:{data.readOk} · loads:{data.loads} · rq:{rq.current ?? '…'}
</div>
<form method="POST" action="?/setcookie">
	<button>set cookie</button>
</form>
<div
	style="backgroundColor: #3b82f6; borderRadius: 6px; padding: 8px; color: #fff"
	onclick={() => refreshAll()}
>
	refreshAll
</div>
