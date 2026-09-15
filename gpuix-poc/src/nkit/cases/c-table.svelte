<script>
	import Table from '../Table.svelte';
	let sel = $state(null);
</script>
<Table
	bind:selected={sel}
	columns={[{ key: 'name', label: 'col-name' }, { key: 'role', label: 'col-role' }]}
	rows={[{ name: 'row-ada', role: 'eng' }, { name: 'row-grace', role: 'adm' }]}
	onselect={(r) => (sel = r.name)}
/>
<div>tsel={sel}</div>
