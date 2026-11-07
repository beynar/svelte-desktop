<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Separator from '../../Separator.svelte';
	import Kbd from '../../Kbd.svelte';
	import { style, mergeStyleDesc } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const controls = [{ key: 'orientation', type: 'select', options: ['horizontal', 'vertical'], value: 'horizontal' }];
	const box = $derived(style({ bg: 'surface-raised', radius: 'sm' }));
	const col = $derived(style({ col: true, gap: 'md', w: 'full' }));
	const row = $derived(style({ row: true, gap: 'md', h: 48, items: 'center' }));
</script>

<ComponentPage title="Separator / Kbd" description="layout primitives" {controls}>
	{#snippet demo(p)}
		{#if p.orientation === 'horizontal'}
			<div use:applyStyle={col}>
				<div use:applyStyle={mergeStyleDesc(box, style({ h: 24 }))}></div>
				<Separator orientation="horizontal" />
				<div use:applyStyle={mergeStyleDesc(box, style({ h: 24 }))}></div>
			</div>
		{:else}
			<div use:applyStyle={row}>
				<div use:applyStyle={mergeStyleDesc(box, style({ w: 64 }))}></div>
				<Separator orientation="vertical" />
				<div use:applyStyle={mergeStyleDesc(box, style({ w: 64 }))}></div>
			</div>
		{/if}
		<div use:applyStyle={style({ row: true, gap: 'xs', items: 'center' })}>
			<Kbd>⌘</Kbd><Kbd>K</Kbd><span use:applyStyle={style({ text: 'sm', fg: 'neutral-readable' })}>to open command palette</span>
		</div>
	{/snippet}
</ComponentPage>
