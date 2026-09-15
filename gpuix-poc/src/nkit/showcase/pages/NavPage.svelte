<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Breadcrumbs from '../../Breadcrumbs.svelte';
	import Pagination from '../../Pagination.svelte';
	import Stepper from '../../Stepper.svelte';
	import ButtonGroup from '../../ButtonGroup.svelte';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const controls = [
		{ key: 'siblingCount', type: 'select', options: ['0', '1', '2'], value: '1' },
		{ key: 'showFirstLast', type: 'toggle', value: true },
	];
	let page = $state(2);
	let step = $state(1);
	const col = $derived(s({ col: true, gap: 'layout-md' }));
	const cap = $derived(s({ text: 'xs', fg: 'neutral-readable' }));
</script>

<ComponentPage title="Breadcrumbs / Pagination / Stepper / ButtonGroup" {controls}>
	{#snippet demo(p)}
		<div use:applyStyle={col}>
			<div use:applyStyle={cap}>breadcrumbs</div>
			<Breadcrumbs items={[{ label: 'Home' }, { label: 'Library' }, { label: 'Components' }]} />
			<div use:applyStyle={cap}>stepper</div>
			<Stepper
				bind:current={step}
				clickable
				steps={[
					{ label: 'Account', description: 'Basics' },
					{ label: 'Profile', description: 'Details' },
					{ label: 'Review' },
				]}
			/>
			<div use:applyStyle={cap}>pagination</div>
			<Pagination bind:page totalPages={9} siblingCount={+p.siblingCount} showFirstLast={p.showFirstLast} />
			<div use:applyStyle={cap}>button group</div>
			<ButtonGroup options={[{ label: 'Day' }, { label: 'Week' }, { label: 'Month' }]} defaultValue="Day" />
		</div>
	{/snippet}
</ComponentPage>
