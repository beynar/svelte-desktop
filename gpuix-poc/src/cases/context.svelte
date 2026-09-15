<script>
	import { setContext, getContext } from 'svelte';
	setContext('k', 'ctx-value');
	const v = getContext('k');
</script>
<div><span>ctx={v}</span></div>
