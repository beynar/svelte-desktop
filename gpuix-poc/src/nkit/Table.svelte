<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { tableTheme } from './recipes/nav.js';

	let {
		columns = [],          // [{key, label, width?, align?}]
		rows = [],             // [{…colKey: cell, id?}]
		selected = $bindable(null),
		onselect,
		class: klass = '',
		style = null,
		theme = null,
		...rest
	} = $props();

	const ct = useComponentTheme('table', theme, ['headerRow', 'headerCell', 'row', 'cell']);
	const vp = $derived(ct.props({}));
	const rootS = $derived(mergeStyleDesc(s(ct.root(tableTheme.root, vp, style)), resolveTokens(klass)));
	const headRowS = $derived(s(ct.slot('headerRow', tableTheme.headerRow, vp)));
	const headCellS = $derived(s(ct.slot('headerCell', tableTheme.headerCell, vp)));
	const rowS = (sel, clk) => s(ct.slot('row', tableTheme.row, { ...vp, selected: sel, clickable: clk }));
	const cellS = $derived(s(ct.slot('cell', tableTheme.cell, vp)));
</script>

<div use:applyStyle={rootS} {...rest}>
	<div use:applyStyle={headRowS}>
		{#each columns as c}
			<div use:applyStyle={mergeStyleDesc(headCellS, c.width ? s({ w: c.width, grow: 0, shrink: 0 }) : null)}>{c.label ?? c.key}</div>
		{/each}
	</div>
	{#each rows as r, ri}
		<div
			use:applyStyle={rowS(selected === (r.id ?? ri), !!onselect)}
			onclick={() => { selected = r.id ?? ri; onselect?.(r); }}
		>
			{#each columns as c}
				<div use:applyStyle={mergeStyleDesc(cellS, c.width ? s({ w: c.width, grow: 0, shrink: 0 }) : null)}>{r[c.key]}</div>
			{/each}
		</div>
	{/each}
</div>
