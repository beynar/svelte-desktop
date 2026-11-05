<script lang="ts">
	import { page } from '$app/state';
	import Alive from '#lib/Alive.svelte';
</script>

<svelte:head><title>Live {page.params.id}</title></svelte:head>

<h1>Live {page.params.id}</h1>
<Alive />
