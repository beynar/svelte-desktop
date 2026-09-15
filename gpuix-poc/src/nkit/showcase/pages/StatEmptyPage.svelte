<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Stat from '../../Stat.svelte';
	import Empty from '../../Empty.svelte';
	import Button from '../../Button.svelte';
	import { s, mergeStyleDesc } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const controls = [{ key: 'trend', type: 'select', options: ['up', 'down', 'flat'], value: 'up' }];
	const row = $derived(s({ row: true, gap: 'layout-lg' }));
	const panel = $derived(s({ bg: 'surface-raised', radius: 'md', borderW: 1, border: 'neutral-muted' }));
</script>

<ComponentPage title="Stat / Empty" description="KPI blocks and zero states" {controls}>
	{#snippet demo(p)}
		<div use:applyStyle={row}>
			<div use:applyStyle={mergeStyleDesc(panel, s({ p: 'lg' }))}><Stat label="Revenue" value="$48.2k" delta="+12.4%" trend={p.trend} /></div>
			<div use:applyStyle={mergeStyleDesc(panel, s({ p: 'lg' }))}><Stat label="Active users" value="8,213" delta="+3.1%" trend="up" /></div>
			<div use:applyStyle={mergeStyleDesc(panel, s({ p: 'lg' }))}><Stat label="Churn" value="1.9%" delta="-0.4%" trend="down" /></div>
		</div>
		<Empty icon="search" title="No results" description="Try adjusting your filters" style={{ w: 420 }}>
			<Button variant="soft" size="small" label="Clear filters" />
		</Empty>
	{/snippet}
</ComponentPage>
