<script>
	let { status, error } = $props();
</script>

<div class="err">error {status}: {error?.message ?? 'unknown'}</div>
