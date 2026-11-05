<script>
	let { children, data } = $props();
</script>

<div class="shell">{@render children()}</div>

<style>
	.shell {
		color: #e5e7eb;
		padding: 8px;
	}
	.shell:hover {
		color: #fff;
	}
</style>
