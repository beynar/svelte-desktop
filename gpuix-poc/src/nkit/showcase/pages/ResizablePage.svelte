<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Resizable from '../../Resizable.svelte';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const controls = [{ key: 'direction', type: 'select', options: ['horizontal', 'vertical'], value: 'horizontal' }];
	const paneA = $derived(s({ col: true, items: 'center', justify: 'center', h: 'full', bg: 'surface-raised', fg: 'neutral-readable', text: 'sm' }));
	const paneB = $derived(s({ col: true, items: 'center', justify: 'center', h: 'full', bg: 'surface-recessed', fg: 'neutral-readable', text: 'sm' }));
	const paneC = $derived(s({ col: true, items: 'center', justify: 'center', h: 'full', bg: 'surface-raised', fg: 'neutral-readable', text: 'sm' }));
</script>

<ComponentPage title="Resizable" description="drag dividers — panes rebalance pairwise" {controls}>
	{#snippet demo(p)}
		<div style="width:560px;height:200px;display:flex">
			<Resizable direction={p.direction} panes={3} sizes={[35, 40, 25]}>
				{#snippet pane(i)}
					<div use:applyStyle={i === 0 ? paneA : i === 1 ? paneB : paneC}>pane {i + 1}</div>
				{/snippet}
			</Resizable>
		</div>
	{/snippet}
</ComponentPage>
