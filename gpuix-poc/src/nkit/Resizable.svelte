<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { resizableTheme } from './recipes/nav.js';

	// orientation: 'horizontal' = panes side-by-side, vertical = stacked.
	// sizes = flex-grow weights per pane; dragging rebalances the pair.
	let {
		panes = 2,             // pane count — or array for heterogeneous sizing
		pane,                  // snippet: (index) => node
		direction,             // deprecated — `orientation` is the svelai name
		orientation = 'horizontal',
		sizes = $bindable(null),  // [50, 50, …] percentages
		minSize = 10,
		disabled = false,
		keyboardStep = 2,      // % per arrow press on a focused divider
		resetOnDoubleClick = true,
		onchange,
		onResize,              // svelai: during drag
		onLayoutChange,        // svelai: same as onResize
		onLayoutCommit,        // svelai: after release
		class: klass = '',
		style = null,
		theme = null,
		...rest
	} = $props();

	let el = $state(null);
	let dragging = $state(-1);
	const dir = $derived(direction ?? orientation);
	const count = $derived(Array.isArray(panes) ? panes.length : panes);
	sizes ??= Array(count).fill(100 / count);
	// pane count can change after mount — keep sizes in step
	$effect(() => {
		if (!Array.isArray(sizes) || sizes.length !== count) {
			sizes = Array(count).fill(100 / count);
		}
	});

	const ct = useComponentTheme('resizable', theme, ['pane', 'divider']);
	const vp = $derived(ct.props({ direction: dir, disabled }));
	const groupS = $derived(mergeStyleDesc(s(ct.root(resizableTheme.group, vp, style)), resolveTokens(klass)));
	const paneS = $derived(s(ct.slot('pane', resizableTheme.pane, vp)));
	const dividerS = (i) => s(ct.slot('divider', resizableTheme.divider, { ...vp, dragging: dragging === i }));

	const emit = () => { onchange?.(sizes); onResize?.(sizes); onLayoutChange?.(sizes); };

	function applyAt(i, pct) {
		const combined = sizes[i] + sizes[i + 1];
		const before = sizes.slice(0, i).reduce((a, b) => a + b, 0);
		const next = Math.max(minSize, Math.min(combined - minSize, pct - before));
		sizes = sizes.map((v, j) => (j === i ? next : j === i + 1 ? combined - next : v));
		emit();
	}

	function onDrag(e) {
		// gpui captures the pointer to the mousedown element — moves arrive on
		// the divider while the button is held, wherever the cursor goes.
		const r = el?.getBoundingClientRect();
		if (!r) return;
		const [bx, by, bw, bh] = Array.isArray(r) ? r : [r.x, r.y, r.width, r.height];
		const total = dir === 'horizontal' ? bw : bh;
		const pos = dir === 'horizontal' ? e.x - bx : e.y - by;
		applyAt(dragging, (pos / total) * 100);
	}

	function keyResize(i, e) {
		const k = e.key ?? e.detail?.key;
		const d = k === 'left' || k === 'arrowleft' || k === 'up' || k === 'arrowup' ? -keyboardStep
			: k === 'right' || k === 'arrowright' || k === 'down' || k === 'arrowdown' ? keyboardStep : 0;
		if (!d) return;
		const combined = sizes[i] + sizes[i + 1];
		const next = Math.max(minSize, Math.min(combined - minSize, sizes[i] + d));
		sizes = sizes.map((v, j) => (j === i ? next : j === i + 1 ? combined - next : v));
		emit();
		onLayoutCommit?.(sizes);
		e.preventDefault?.();
	}
</script>

<div bind:this={el} use:applyStyle={groupS} {...rest}>
	{#each Array(count) as _, i}
		<div use:applyStyle={paneS} style="flex-grow:{sizes[i]};flex-basis:0;overflow:hidden">
			{@render pane?.(i)}
		</div>
		{#if i < count - 1}
			<div
				use:applyStyle={dividerS(i)}
				use:nativeProps={{ tabIndex: disabled ? undefined : 0 }}
				onmousedown={() => { if (!disabled) dragging = i; }}
				onmousemove={(e) => { if (dragging === i && e.pressedButton === 0) onDrag(e); }}
				onmouseup={() => { if (dragging === i) { dragging = -1; onLayoutCommit?.(sizes); } }}
				ondblclick={() => { if (resetOnDoubleClick && !disabled) { const even = 100 / count; sizes = sizes.map(() => even); emit(); onLayoutCommit?.(sizes); } }}
				onkeydown={(e) => { if (!disabled) keyResize(i, e); }}
				role="separator" aria-orientation={dir === 'horizontal' ? 'vertical' : 'horizontal'} aria-valuenow={Math.round(sizes[i])}
			></div>
		{/if}
	{/each}
</div>
