<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { treeTheme } from './recipes/nav.js';
	import { icons } from './icons.js';
	import Tree from './Tree.svelte';

	let {
		nodes = [],            // [{id, label, icon?, children?}]
		selected = $bindable(null),
		color,
		depth = 0,
		onselect,
		class: klass = '',
		style = null,
		theme = null,
		...rest
	} = $props();

	const ct = useComponentTheme('tree', theme, ['item']);
	const vp = $derived(ct.props({ color }));
	const ctx = $derived({ color: vp.color });
	let expanded = $state(new Set());
	const rootS = $derived(mergeStyleDesc(s(ct.root(treeTheme.root, vp, depth ? {} : { ...(style ?? {}) }), ctx), depth ? null : resolveTokens(klass, ctx)));
	const itemS = (sel) => s(ct.slot('item', treeTheme.item, { ...vp, selected: sel }), ctx);
	const toggle = (id) => {
		const next = new Set(expanded);
		next.has(id) ? next.delete(id) : next.add(id);
		expanded = next;
	};
	const activate = (n) => {
		if (n.children) return toggle(n.id); // parents expand/collapse; leaves select
		if (selected !== n.id) { selected = n.id; onselect?.(n); }
	};
</script>

<div use:applyStyle={rootS} {...rest}>
	{#each nodes as n}
		<div
			use:applyStyle={mergeStyleDesc(itemS(selected === n.id), s({ pl: 8 + depth * 16 }))}
			onclick={() => activate(n)}
		>
			{#if n.children}
				<svg use:nativeProps={{ source: expanded.has(n.id) ? icons['chevron-down'] : icons['chevron-right'] }} use:applyStyle={s({ icon: 'sm' })}></svg>
			{:else}
				<span use:applyStyle={s({ icon: 'sm' })}></span>
			{/if}
			{#if n.icon}<svg use:nativeProps={{ source: icons[n.icon] ?? n.icon }} use:applyStyle={s({ icon: 'sm' })}></svg>{/if}
			<span>{n.label}</span>
		</div>
		{#if n.children && expanded.has(n.id)}
			<Tree nodes={n.children} bind:selected color={vp.color} depth={depth + 1} {onselect} />
		{/if}
	{/each}
</div>
