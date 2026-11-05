<script>
	// Renders the router's layout chain: each level's component receives
	// `data` + `params`; layouts wrap deeper levels via implicit `children` —
	// the Svelte 5 equivalent of +layout.svelte's {@render children()}.
	import Shell from './Shell.svelte';
	import { page } from './runtime.js';
	let { router, levels = router.levels } = $props();
</script>

{#if levels.length}
	{@const [head, ...rest] = levels}
	{#if !head.component}
		<Shell {router} levels={rest} />
	{:else}
		{@const C = head.component}
		{#if rest.length}
			<C data={head.data} params={page.params}><Shell {router} levels={rest} /></C>
		{:else if head.error}
			<C data={head.data} params={page.params} status={head.error.status} error={head.error} />
		{:else}
			<C data={head.data} params={page.params} form={page.form} />
		{/if}
	{/if}
{/if}
