<script>
	import { preloadData } from '#kit';
	let loaded = $state('');
</script>

<div
	style="backgroundColor: #3b82f6; borderRadius: 6px; padding: 8px; color: #fff"
	onclick={async () => {
		const r = await preloadData('/item/9');
		loaded = `preloaded:${r.type}:${r.data?.id ?? '-'}:${r.status}`;
	}}
>
	preload /item/9
</div>
<div style="color: #e5e7eb">{loaded}</div>
