<script>
	import { page, pushState } from '#kit';
	let { data } = $props();
</script>

<div
	style="backgroundColor: #3b82f6; borderRadius: 6px; padding: 8px; color: #fff"
	onclick={() => pushState('/shallow?tab=2', { tab: 2 })}
>
	push shallow state
</div>
<div style="color: #e5e7eb">
	shallow — tab:{page.state.tab ?? 'none'} · search:{page.url.search || 'empty'}
</div>
