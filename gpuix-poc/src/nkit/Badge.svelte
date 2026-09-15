<script>
	// Badge = Chip preset: small, soft by default
	import Chip from './Chip.svelte';
	let { variant = 'soft', size = 'small', ...rest } = $props();
</script>

<Chip {variant} {size} {...rest} />
