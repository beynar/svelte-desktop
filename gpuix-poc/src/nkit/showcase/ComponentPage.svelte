<script>
	import { s } from '../style.js';
	import { applyStyle } from '../apply.js';
	import SegmentedControl from '../SegmentedControl.svelte';
	import Switch from '../Switch.svelte';
	import Input from '../Input.svelte';

	// controls: [{key, label?, type:'select'|'toggle'|'text'|'number', options?, value}]
	let { title, description, controls = [], demo, extra } = $props();

	let values = $state(Object.fromEntries(controls.map((c) => [c.key, c.value])));

	const titleS = $derived(s({ text: 'xl', fontW: 600, fg: 'neutral' }));
	const descS = $derived(s({ text: 'sm', fg: 'neutral-readable' }));
	const panelS = $derived(s({ col: true, gap: 'lg', w: 220, shrink: 0, borderL: 1, border: 'neutral-muted', pl: 'lg' }));
	const ctrlS = $derived(s({ col: true, gap: 'xs' }));
	const ctrlLabelS = $derived(s({ text: 'xs', fontW: 600, fg: 'neutral-readable' }));
	const stageS = $derived(s({ col: true, flex1: true, gap: 'layout-md', p: 'layout-md', overflowY: 'scroll' }));
	const demoS = $derived(s({ col: true, gap: 'lg', items: 'start' }));
</script>

<div style="display:flex;flex-direction:row;flex:1;overflow:hidden">
	<div use:applyStyle={stageS}>
		<div use:applyStyle={s({ col: true, gap: 'xs' })}>
			<div use:applyStyle={titleS}>{title}</div>
			{#if description}<div use:applyStyle={descS}>{description}</div>{/if}
		</div>
		<div use:applyStyle={demoS}>{@render demo?.(values)}</div>
		{@render extra?.()}
	</div>
	{#if controls.length}
		<div use:applyStyle={panelS}>
			{#each controls as c}
				<div use:applyStyle={ctrlS}>
					<div use:applyStyle={ctrlLabelS}>{c.label ?? c.key}</div>
					{#if c.type === 'select'}
						<SegmentedControl
							options={c.options.map((o) => ({ value: o, label: o }))}
							bind:value={values[c.key]}
							size="small"
						/>
					{:else if c.type === 'toggle'}
						<Switch bind:on={values[c.key]} />
					{:else if c.type === 'text'}
						<Input bind:value={values[c.key]} size="small" />
					{:else if c.type === 'number'}
						<Input bind:value={values[c.key]} size="small" onchange={(v) => (values[c.key] = +v || 0)} />
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
