<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { listScrollTop } from '../native.js';

	let {
		items = [],
		estimatedItemHeight = 32,
		row,                   // snippet: (item, index) => node
		overdrawRows = 3,      // extra rows rendered above/below the viewport
		followTail = false,
		overdraw,
		onscroll,
		onvisiblerange,
		class: klass = '',
		style = null,
		theme = null,
		...rest
	} = $props();

	const ct = useComponentTheme('virtualList', theme);
	let el = $state(null);
	let range = $state({ start: 0, end: 60 });
	const windowItems = $derived(items.slice(range.start, range.end));
	const resolved = $derived(
		mergeStyleDesc(s(ct.root({ flex1: true }, ct.props({}), style)), resolveTokens(klass)),
	);
	// windowStart is the alignment contract: children[0] is item `windowStart`.
	const props = $derived({
		itemCount: items.length,
		estimatedItemHeight,
		windowStart: range.start,
		...(followTail ? { followTail: true } : {}),
		...(overdraw != null ? { overdraw } : {}),
	});

	function syncRange() {
		// the visibleRange payload lags a frame — the live anchor is exact.
		const anchor = el?.nativeId != null ? listScrollTop(el.nativeId) : null;
		if (!anchor) return;
		const [itemIndex, , viewportH] = anchor;
		const visible = Math.ceil((viewportH || 0) / estimatedItemHeight) || 6;
		const start = Math.max(0, itemIndex - overdrawRows);
		const end = Math.min(items.length, itemIndex + visible + overdrawRows);
		if (start !== range.start || end !== range.end) range = { start, end };
	}
</script>

<virtual-list
	bind:this={el}
	use:applyStyle={resolved}
	use:nativeProps={props}
	onvisiblerange={(e) => { syncRange(); onvisiblerange?.(e); }}
	onscroll={(e) => { syncRange(); onscroll?.(e); }}
	{...rest}
>
	{#each windowItems as item, i}
		{@render row?.(item, range.start + i)}
	{/each}
</virtual-list>
