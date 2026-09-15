<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import Layer from './Layer.svelte';
	import { menuTheme, menuMotion } from './recipes/overlay.js';

	let {
		open = $bindable(false),
		items = [],          // [{label, icon?, danger?, disabled?, onselect?} | 'separator' | {type:'label', label}]
		side = 'bottom',
		align = 'start',
		at = null,           // {x, y} absolute anchor — context-menu mode
		trigger,
		onclose,
		onOpenChange,
		class: klass = '',
		style = null,
		theme = null,
		transition,
		...rest
	} = $props();

	const ct = useComponentTheme('menu', theme, ['content', 'item', 'separator', 'label']);
	const mv = $derived(ct.motion(menuMotion, {}, transition));
	let triggerEl = $state(null);
	let closedAt = 0; // a press that dismissed the layer must not re-open it
	const contentS = $derived(mergeStyleDesc(s(ct.slot('content', menuTheme.content, {}, style)), resolveTokens(klass)));
	const itemS = (it) => s(ct.slot('item', menuTheme.item, { danger: it.danger, disabled: it.disabled }));
	const sepS = $derived(s(ct.slot('separator', menuTheme.separator, {})));
	const labelS = $derived(s(ct.slot('label', menuTheme.label, {})));
	const setOpen = (v) => { if (open === v) return; open = v; onOpenChange?.(v); };
	const close = () => { setOpen(false); closedAt = Date.now(); onclose?.(); };
	const toggle = () => { if (open) close(); else if (Date.now() - closedAt >= 300) setOpen(true); };
</script>

<div style="display:flex;position:relative;align-items:start;align-self:flex-start">
	{#if trigger}
		<span bind:this={triggerEl} style="display:flex;align-self:flex-start" onclick={toggle}>
			{@render trigger()}
		</span>
	{/if}
	<Layer {open} {at} {side} {align} onclose={close} style={contentS} motion={mv} {...rest}>
	{#snippet content()}
		{#each items as it}
			{#if it === 'separator'}
				<div use:applyStyle={sepS}></div>
			{:else if it.type === 'label'}
				<div use:applyStyle={labelS}>{it.label}</div>
			{:else}
				<div
					use:applyStyle={itemS(it)}
					use:nativeProps={{ tabIndex: it.disabled ? undefined : 0 }}
					onclick={() => { if (!it.disabled) { it.onselect?.(); close(); } }}
					onkeydown={(e) => { const k = e.key ?? e.detail?.key; if ((k === 'enter' || k === 'space') && !it.disabled) { it.onselect?.(); close(); e.preventDefault?.(); } }}
					role="menuitem" aria-disabled={it.disabled || undefined}
				>{it.label}</div>
			{/if}
		{/each}
	{/snippet}
	</Layer>
</div>
