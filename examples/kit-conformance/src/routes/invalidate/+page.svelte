<script lang="ts">
	import { invalidate } from '$app/navigation';
	let { data } = $props();
</script>

<p id="n">{data.n}</p>
<button id="again" onclick={() => invalidate('app:counter')}>again</button>
