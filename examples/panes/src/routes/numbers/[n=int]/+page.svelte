<script lang="ts">
	import { page } from '$app/state';
	import Alive from '#lib/Alive.svelte';
</script>

<svelte:head><title>Number {page.params.n}</title></svelte:head>

<h1>Number {page.params.n}</h1>
<p>A <code>keepAlive</code> route with a matcher: each number has its own tab.</p>
<Alive />
