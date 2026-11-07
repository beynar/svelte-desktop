<script>
	import Sidebar from '../Sidebar.svelte';
	let a = $state('home');
</script>
<Sidebar bind:active={a} items={[{ value: 'home', label: 'sb-home' }, { value: 'settings', label: 'sb-settings' }]} />
<div>sb={a}</div>
