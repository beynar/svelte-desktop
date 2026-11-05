<script lang="ts">
	import { greet, double, bumped, bump, rename, whoami, buildInfo, slow } from '#lib/conformance.remote';
	let slowResult = $state<number | string | null>(null);
</script>

<p id="greet">{await greet('desktop')}</p>
<p id="batch">{JSON.stringify(await Promise.all([double(1), double(2), double(3)]))}</p>
<p id="bumped">{await bumped()}</p>
<p id="whoami">{await whoami()}</p>
<p id="prerender">{JSON.stringify(await buildInfo())}</p>
<button id="bump" onclick={() => bump(1)}>bump</button>
<form {...rename} id="rename"><input {...rename.fields.name.as('text')} /><button>rename</button></form>
<p id="rename-result">{JSON.stringify(rename.result ?? null)}</p>
<button id="slow" onclick={() => slow(11000).then((v) => (slowResult = v), (e) => (slowResult = `error: ${e.message}`))}>slow</button>
<p id="slow-result">{slowResult}</p>
