<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Table from '../../Table.svelte';
	import VirtualList from '../../VirtualList.svelte';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const w = $derived(s({ w: 440, bg: 'surface-recessed', radius: 'md', borderW: 1, border: 'neutral-muted' }));
	const lw = $derived(s({ w: 440, h: 160, bg: 'surface-recessed', radius: 'md', borderW: 1, border: 'neutral-muted' }));
	const rowS = $derived(s({ row: true, px: 'md', control: 'sm', items: 'center', text: 'sm', fg: 'neutral', borderB: 1, border: 'neutral-muted' }));
	const columns = [
		{ key: 'name', label: 'Name', width: 140 },
		{ key: 'role', label: 'Role' },
		{ key: 'status', label: 'Status', width: 90 },
	];
	const rows = [
		{ name: 'Ada Lovelace', role: 'Engineer', status: 'Active' },
		{ name: 'Grace Hopper', role: 'Admiral', status: 'Active' },
		{ name: 'Alan Turing', role: 'Cryptographer', status: 'Away' },
	];
	const big = Array.from({ length: 2000 }, (_, i) => `row ${i + 1} — virtualized`);
</script>

<ComponentPage title="Table / VirtualList" description="plain table + 2k-row virtual list (native windowing)">
	{#snippet demo()}
		<div use:applyStyle={w}><Table {columns} {rows} onselect={() => {}} /></div>
		<div use:applyStyle={lw}>
			<VirtualList items={big} estimatedItemHeight={29}>
				{#snippet row(item)}<div use:applyStyle={rowS}>{item}</div>{/snippet}
			</VirtualList>
		</div>
	{/snippet}
</ComponentPage>
