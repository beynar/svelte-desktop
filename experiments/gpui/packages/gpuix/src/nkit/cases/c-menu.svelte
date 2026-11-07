<script>
	import Menu from '../Menu.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	let sel = $state('');
</script>
<div style="padding:60px">
	<Menu items={[{ label: 'mi-edit', onselect: () => (sel = 'edit') }, 'separator', { label: 'mi-del', danger: true, onselect: () => (sel = 'del') }]}>
		{#snippet trigger()}<div>menu-trig</div>{/snippet}
	</Menu>
	<ContextMenu items={[{ label: 'ctx-item', onselect: () => (sel = 'ctx') }]}>
		<div>ctx-zone</div>
	</ContextMenu>
</div>
<div>msel={sel}</div>
