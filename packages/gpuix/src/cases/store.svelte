<script>
	import { writable } from 'svelte/store';
	const w = writable('storeval');
</script>
<div><span>{$w}</span></div>
