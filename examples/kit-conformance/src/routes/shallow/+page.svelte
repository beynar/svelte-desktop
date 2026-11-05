<script lang="ts">
	import { pushState } from '$app/navigation';
	import { page } from '$app/state';
</script>

<button id="push" onclick={() => pushState('', { modal: 'open' })}>push</button>
<p id="state">{JSON.stringify(page.state)}</p>
