<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Sidebar from '../../Sidebar.svelte';

	const controls = [{ key: 'collapsed', type: 'toggle', value: false }];
	let active = $state('home');
	const items = [
		{ type: 'section', label: 'Main' },
		{ value: 'home', label: 'Home', icon: 'folder' },
		{ value: 'files', label: 'Files', icon: 'file' },
		{ value: 'search', label: 'Search', icon: 'search' },
		{ type: 'section', label: 'Manage' },
		{ value: 'settings', label: 'Settings', icon: 'info' },
	];
</script>

<ComponentPage title="Sidebar" description="sections + icons + collapsed rail" {controls}>
	{#snippet demo(p)}
		<Sidebar {items} bind:active collapsed={p.collapsed} style={{ h: 360, borderW: 1, border: 'neutral-muted', radius: 'md' }} />
	{/snippet}
</ComponentPage>
