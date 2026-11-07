<script>
	import { tick } from 'svelte';
	let n = $state(0); let after = $state('?');
	async function go() { n = 42; await tick(); after = 'ticked'; }
</script>
<div><button onclick={go}>go</button><span>n={n} {after}</span></div>
