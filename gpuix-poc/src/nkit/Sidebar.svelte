<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { sidebarTheme } from './recipes/nav.js';
	import { icons } from './icons.js';

	let {
		items = [],            // [{icon, label, value, onselect?}] — or {type:'section', label}
		active = $bindable(null),
		defaultValue,          // initial active value when unbound
		collapsed = false,
		collapsible = false,   // renders a collapse toggle in the header
		side = 'left',         // left | right — mirrored divider edge
		size ,       // small | normal | large → 200/240/300px
		density ,
		width,                 // explicit px — overrides size
		color,
		onValueChange,
		class: klass = '',
		style = null,
		theme = null,
		header,
		footer,
		...rest
	} = $props();

	active ??= defaultValue;
	const ct = useComponentTheme('sidebar', theme, ['section', 'item', 'icon']);
	const vp = $derived(ct.props({ collapsed, size, density, color }));
	const ctx = $derived({ color: vp.color });
	const rootS = $derived(
		mergeStyleDesc(
			s(ct.root(sidebarTheme.root, vp, { ...(width != null ? { w: width } : {}), ...(style ?? {}) }), ctx),
			resolveTokens(klass, ctx),
		),
	);
	const sectionS = $derived(s(ct.slot('section', sidebarTheme.section, vp)));
	const itemS = (act) => s(ct.slot('item', sidebarTheme.item, { ...vp, active: act }), ctx);
	const iconS = $derived(s(ct.slot('icon', sidebarTheme.icon, vp)));
	const toggleS = $derived(s({ row: true, items: 'center', control: 'md', radius: 'sm', cursor: 'pointer', fg: 'neutral-readable', hover: { bg: 'surface-floating' } }));
	const select = (it) => {
		if (active === it.value) { it.onselect?.(it.value); return; }
		active = it.value;
		it.onselect?.(it.value);
		onValueChange?.(it.value);
	};
</script>

<div use:applyStyle={rootS} data-side={side} {...rest}>
	{#if header}{@render header()}{/if}
	{#if collapsible}
		<div
			use:applyStyle={toggleS}
			use:nativeProps={{ tabIndex: 0 }}
			onclick={() => (collapsed = !collapsed)}
			onkeydown={(e) => { const k = e.key ?? e.detail?.key; if (k === 'enter' || k === 'space') { collapsed = !collapsed; e.preventDefault?.(); } }}
			role="button" aria-label="Toggle sidebar"
		>
			<svg use:nativeProps={{ source: icons[side === 'right' ? 'chevron-right' : 'chevron-left'] }} use:applyStyle={iconS}></svg>
			{#if !collapsed}<span>Collapse</span>{/if}
		</div>
	{/if}
	{#each items as it}
		{#if it.type === 'section'}
			{#if !collapsed}<div use:applyStyle={sectionS}>{it.label}</div>{/if}
		{:else}
			<div
				use:applyStyle={itemS(active === it.value)}
				use:nativeProps={{ tabIndex: 0 }}
				onclick={() => select(it)}
				onkeydown={(e) => { const k = e.key ?? e.detail?.key; if (k === 'enter' || k === 'space') { select(it); e.preventDefault?.(); } }}
				role="button" title={it.label}
			>
				{#if it.icon}<svg use:nativeProps={{ source: icons[it.icon] ?? it.icon }} use:applyStyle={iconS}></svg>{/if}
				{#if !collapsed}<span>{it.label}</span>{/if}
			</div>
		{/if}
	{/each}
	<div style="flex:1"></div>
	{@render footer?.()}
</div>
