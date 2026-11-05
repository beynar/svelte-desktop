<script lang="ts">
	import { pushState } from '$app/navigation';
	import { page } from '$app/state';
	import Alive from '#lib/Alive.svelte';
</script>

<svelte:head><title>Thread {page.params.id}</title></svelte:head>

<h1>Thread {page.params.id}</h1>
<Alive />
<p><a href="/threads/{Number(page.params.id) + 1}">Next thread</a> · <a href="/threads/{Number(page.params.id) + 1}" target="_blank">in a new tab</a></p>
<button data-shallow onclick={() => pushState('?filter=open', {})}>Filter (its address only)</button>
