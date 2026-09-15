<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { paginationTheme } from './recipes/nav.js';
	import Button from './Button.svelte';

	let {
		page = $bindable(null),
		pages,                 // `totalPages` is the svelai name
		totalPages,
		siblingCount = 1,      // page buttons each side of current
		boundaryCount = 1,     // always-visible pages at each end
		showFirstLast = false,
		showPrevNext = true,
		showSummary = true,
		disabled = false,
		color,
		size ,
		defaultValue,
		onchange,
		onValueChange,
		class: klass = '',
		style = null,
		theme = null,
		...rest
	} = $props();

	const count = $derived(totalPages ?? pages ?? 1);
	const ct = useComponentTheme('pagination', theme, ['info']);
	const vp = $derived(ct.props({ color, size, disabled }));
	page ??= defaultValue ?? 1;
	const rootS = $derived(mergeStyleDesc(s(ct.root(paginationTheme.root, vp, style)), resolveTokens(klass)));
	const infoS = $derived(s(ct.slot('info', paginationTheme.info, vp)));
	const btnSize = $derived(['small', 'normal', 'large'].includes(vp.size) ? vp.size : 'normal');
	const go = (p) => {
		const next = Math.max(1, Math.min(count, p));
		if (next === page) return;
		page = next;
		onchange?.(page);
		onValueChange?.(page);
	};

	// svelai-style item list: boundaries + siblings + ellipsis markers —
	// short ranges render in full (no point eliding 3 of 5 pages)
	const items = $derived.by(() => {
		const out = [];
		if (count <= boundaryCount * 2 + siblingCount * 2 + 3) {
			for (let i = 1; i <= count; i++) out.push(i);
			return out;
		}
		const push = (p) => { if (!out.includes(p)) out.push(p); };
		for (let i = 1; i <= Math.min(boundaryCount, count); i++) push(i);
		for (let i = Math.max(1, page - siblingCount); i <= Math.min(count, page + siblingCount); i++) push(i);
		for (let i = Math.max(1, count - boundaryCount + 1); i <= count; i++) push(i);
		out.sort((a, b) => a - b);
		const list = [];
		for (let i = 0; i < out.length; i++) {
			if (i && out[i] - out[i - 1] > 1) list.push('…');
			list.push(out[i]);
		}
		return list;
	});
</script>

<div use:applyStyle={rootS} role="navigation" aria-label="Pagination" {...rest}>
	{#if showFirstLast}
		<Button variant="ghost" size={btnSize} label="«" disabled={disabled || page <= 1} onclick={() => go(1)} />
	{/if}
	{#if showPrevNext}
		<Button variant="ghost" size={btnSize} label="←" disabled={disabled || page <= 1} onclick={() => go(page - 1)} />
	{/if}
	{#each items as it}
		{#if it === '…'}
			<span use:applyStyle={infoS}>…</span>
		{:else}
			<Button
				variant={page === it ? 'soft' : 'ghost'}
				color={page === it ? vp.color : 'neutral'}
				size={btnSize} squared
				label={String(it)}
				disabled={disabled}
				onclick={() => go(it)}
			/>
		{/if}
	{/each}
	{#if showPrevNext}
		<Button variant="ghost" size={btnSize} label="→" disabled={disabled || page >= count} onclick={() => go(page + 1)} />
	{/if}
	{#if showFirstLast}
		<Button variant="ghost" size={btnSize} label="»" disabled={disabled || page >= count} onclick={() => go(count)} />
	{/if}
	{#if showSummary}<span use:applyStyle={infoS}>{page} / {count}</span>{/if}
</div>
