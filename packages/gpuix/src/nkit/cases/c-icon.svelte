<script>
	import Icon from '../Icon.svelte';
	const raw = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 2l12 12"/></svg>`;
</script>
<div>
	<Icon name="check" />
	<Icon source={raw} size={24} />
	<Icon viewBox="0 0 16 16"><path d="M2 2l12 12" stroke="currentColor" stroke-width="2"/></Icon>
	<div>icon-mounted</div>
</div>
