<script lang="ts">
	import { page } from '$app/state';
	let { data } = $props();
</script>

<p id="server">{data.server}</p>
<p id="server-only">{data.serverOnly}</p>
<p id="hook">{data.hookRan}</p>
<p id="universal">{data.universal}</p>
<p id="fetched">{data.fetched}</p>
<p id="query">{data.query}</p>
<p id="env">{data.env}</p>
<p id="url">{page.url.pathname}</p>
{#await data.streamed}
	<p id="streamed">pending</p>
{:then v}
	<p id="streamed">{v}</p>
{/await}
