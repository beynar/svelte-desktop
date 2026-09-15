<script>
	let { data, params } = $props();
</script>

<div style="color: #e5e7eb">
	item {data.id} → doubled {data.doubled} (param {params.id}) · tab:{data.tab}
</div>
<a href="/" style="color: #60a5fa">← home</a>
