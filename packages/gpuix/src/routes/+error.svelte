<script>
	let { status, error } = $props();
</script>

<div style="color: #f87171">error {status}: {error?.message}</div>
