<script>
	import Breadcrumbs from '../Breadcrumbs.svelte';
	import Pagination from '../Pagination.svelte';
	let nav = $state('');
	let pg = $state(1);
</script>
<Breadcrumbs items={[{ label: 'bc-home', value: 'home' }, { label: 'bc-lib', value: 'lib' }, { label: 'bc-cur' }]} onnavigate={(it) => (nav = it.value)} />
<Pagination bind:page={pg} pages={5} />
<div>nav={nav} pg={pg}</div>
