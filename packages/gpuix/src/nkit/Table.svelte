<script>
	import { style, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { componentTheme } from './theming.svelte.js';
	import { tableTheme } from './recipes/nav.js';

	let {
		columns = [],          // [{key, label, width?, align?}]
		rows = [],             // [{…colKey: cell, id?}]
		selected = $bindable(null),
		onselect,
		class: klass = '',
		style: instStyle = null,
		theme = null,
		...rest
	} = $props();

	const ct = componentTheme('table', () => theme, ['headerRow', 'headerCell', 'row', 'cell']);
	const vp = $derived(ct.props({}));
	const rootS = $derived(mergeStyleDesc(style(ct.root(tableTheme.root, vp, instStyle)), resolveTokens(klass)));
	const headRowS = $derived(style(ct.slot('headerRow', tableTheme.headerRow, vp)));
	const headCellS = $derived(style(ct.slot('headerCell', tableTheme.headerCell, vp)));
	const rowS = (sel, clk) => style(ct.slot('row', tableTheme.row, { ...vp, selected: sel, clickable: clk }));
	const cellS = $derived(style(ct.slot('cell', tableTheme.cell, vp)));
</script>

<div use:applyStyle={rootS} {...rest}>
	<div use:applyStyle={headRowS}>
		{#each columns as c}
			<div use:applyStyle={mergeStyleDesc(headCellS, c.width ? style({ w: c.width, grow: 0, shrink: 0 }) : null)}>{c.label ?? c.key}</div>
		{/each}
	</div>
	{#each rows as r, ri}
		<div
			use:applyStyle={rowS(selected === (r.id ?? ri), !!onselect)}
			onclick={() => { selected = r.id ?? ri; onselect?.(r); }}
		>
			{#each columns as c}
				<div use:applyStyle={mergeStyleDesc(cellS, c.width ? style({ w: c.width, grow: 0, shrink: 0 }) : null)}>{r[c.key]}</div>
			{/each}
		</div>
	{/each}
</div>
