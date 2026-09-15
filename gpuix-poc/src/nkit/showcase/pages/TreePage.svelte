<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Tree from '../../Tree.svelte';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	let sel = $state(null);
	const w = $derived(s({ w: 280, bg: 'surface-recessed', radius: 'md', p: 'sm', borderW: 1, border: 'neutral-muted' }));
	const nodes = [
		{ id: 'src', label: 'src', icon: 'folder', children: [
			{ id: 'comp', label: 'components', icon: 'folder', children: [
				{ id: 'btn', label: 'Button.svelte', icon: 'file' },
				{ id: 'card', label: 'Card.svelte', icon: 'file' },
			]},
			{ id: 'app', label: 'App.svelte', icon: 'file' },
		]},
		{ id: 'pkg', label: 'package.json', icon: 'file' },
	];
</script>

<ComponentPage title="Tree" description="expandable nested nodes">
	{#snippet demo()}
		<div use:applyStyle={w}><Tree {nodes} bind:selected={sel} /></div>
	{/snippet}
</ComponentPage>
