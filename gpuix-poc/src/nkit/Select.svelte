<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import Layer from './Layer.svelte';
	import { useComponentTheme } from './theming.svelte.js';
	import { selectTheme } from './recipes/form.js';
	import { selectMotion } from './recipes/overlay.js';
	import { icons } from './icons.js';

	let {
		options = [],          // [{value, label, disabled?}]
		value = $bindable(null),
		defaultValue,
		placeholder = 'Select…',
		color,
		disabled = false,
		onchange,
		onValueChange,
		onOpenChange,
		onclick,
		onkeydown,
		class: klass = '',
		style = null,
		theme = null,
		transition,
		...rest
	} = $props();

	const ct = useComponentTheme('select', theme, ['trigger', 'chevron', 'content', 'item', 'check']);
	const vp = $derived(ct.props({ color }));
	const ctx = $derived({ color: vp.color });
	const mv = $derived(ct.motion(selectMotion, {}, transition));
	let trigger = $state(null);
	let open = $state(false);
	let highlighted = $state(-1);
	let closedAt = 0; // guard: a click that dismissed the layer must not re-open

	const selected = $derived(options.find((o) => o.value === value));
	const triggerS = $derived(
		mergeStyleDesc(s(ct.slot('trigger', selectTheme.trigger, { ...vp, open, disabled }, style), ctx), resolveTokens(klass, ctx)),
	);
	const chevronS = $derived(s(ct.slot('chevron', selectTheme.chevron, vp)));
	const contentS = $derived(s(ct.slot('content', selectTheme.content, vp)));
	const itemS = (hl, sel, dis) => s(ct.slot('item', selectTheme.item, { highlighted: hl, selected: sel, disabled: dis }));
	const checkS = $derived(s(ct.slot('check', selectTheme.check, vp), ctx));

	value ??= defaultValue;
	const setOpen = (v) => { if (open === v) return; open = v; if (!v) closedAt = Date.now(); onOpenChange?.(v); };
	const pick = (o) => {
		if (o.disabled) return;
		value = o.value;
		setOpen(false);
		onchange?.(o.value);
		onValueChange?.(o.value);
	};
	const toggle = () => {
		if (disabled) return;
		if (open) return setOpen(false);
		if (Date.now() - closedAt < 300) return; // the press that closed us
		highlighted = Math.max(0, options.findIndex((o) => o.value === value));
		open = true;
	};
	const onKey = (e) => {
		const key = e.key ?? e.detail?.key;
		if (!open) {
			if (['enter', 'space', 'down', 'arrowdown', 'up', 'arrowup'].includes(key)) { toggle(); e.preventDefault?.(); }
			return;
		}
		if (key === 'escape') setOpen(false);
		else if (key === 'down' || key === 'arrowdown') { highlighted = Math.min(options.length - 1, highlighted + 1); e.preventDefault?.(); }
		else if (key === 'up' || key === 'arrowup') { highlighted = Math.max(0, highlighted - 1); e.preventDefault?.(); }
		else if ((key === 'enter' || key === 'space') && highlighted >= 0) pick(options[highlighted]);
	};
</script>

<div style="display:flex;position:relative;align-items:start;align-self:flex-start">
	<div
		bind:this={trigger}
		use:applyStyle={triggerS}
		use:nativeProps={{ tabIndex: disabled ? undefined : 0 }}
		onclick={(e) => { toggle(); onclick?.(e); }}
		onkeydown={(e) => { onKey(e); onkeydown?.(e); }}
		role="combobox" aria-expanded={open}
		{...rest}
	>
		<span>{selected?.label ?? selected?.value ?? placeholder}</span>
		<svg use:nativeProps={{ source: icons['chevron-down'] }} use:applyStyle={chevronS}></svg>
	</div>

	<Layer {open} side="bottom" align="start" gap={4} onclose={() => setOpen(false)} style={contentS} motion={mv}>
		{#snippet content()}
			{#each options as o, i}
				<div
					use:applyStyle={itemS(i === highlighted, o.value === value, o.disabled)}
					onclick={() => pick(o)}
					onmouseenter={() => (highlighted = i)}
					role="option" aria-selected={o.value === value}
				>
					<span>{o.label ?? o.value}</span>
					{#if o.value === value}<svg use:nativeProps={{ source: icons.check }} use:applyStyle={checkS}></svg>{/if}
				</div>
			{/each}
		{/snippet}
	</Layer>
</div>
