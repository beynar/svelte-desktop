<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { icons } from './icons.js';

	// Numbered step indicator — steps = [{label, description?}]; `current` is the active index.
	let {
		steps = [],
		current = $bindable(0),
		defaultValue,
		orientation = 'horizontal',
		color,
		clickable = false,     // completed steps can be clicked back to
		onchange,
		onValueChange,
		class: klass = '',
		style = null,
		theme = null,
		...rest
	} = $props();

	current ??= defaultValue ?? 0;
	const ct = useComponentTheme('stepper', theme, ['step', 'circle', 'label', 'line']);
	const vp = $derived(ct.props({ color, orientation }));
	const ctx = $derived({ color: vp.color });
	const rootS = $derived(
		mergeStyleDesc(s(ct.root({ gap: 'sm', ...(vp.orientation === 'horizontal' ? { row: true } : { col: true }) }, vp, style)), resolveTokens(klass, ctx)),
	);
	const stepS = $derived(s(ct.slot('step', { row: true, items: 'center', gap: 'sm' }, vp)));
	const circleS = (state) =>
		s(
			ct.slot('circle', {
				w: 24, h: 24, radius: 'full', items: 'center', justify: 'center', shrink: 0,
				text: 'xs', fontW: 600,
				...(state === 'done'
					? { bg: 'color', fg: 'color-contrast' }
					: state === 'active'
						? { bg: 'color-muted', fg: 'color-muted-readable', borderW: 1, border: 'color' }
						: { bg: 'surface-floating', fg: 'neutral-readable' }),
			}, vp),
			ctx,
		);
	const labelS = (state) =>
		s(ct.slot('label', { text: 'sm', fontW: state === 'active' ? 600 : 400, fg: state === 'pending' ? 'neutral-readable' : 'neutral' }, vp), ctx);
	const lineS = $derived(
		s(ct.slot('line', vp.orientation === 'horizontal' ? { h: 1, w: 24, bg: 'neutral-muted' } : { w: 1, h: 24, bg: 'neutral-muted' }, vp)),
	);
	const go = (i, state) => {
		if (!clickable || state !== 'done' || i === current) return;
		current = i;
		onchange?.(i);
		onValueChange?.(i);
	};
</script>

<div use:applyStyle={rootS} role="list" {...rest}>
	{#each steps as step, i}
		{@const state = i < current ? 'done' : i === current ? 'active' : 'pending'}
		<div
			use:applyStyle={stepS}
			use:nativeProps={{ tabIndex: clickable && state === 'done' ? 0 : undefined }}
			onclick={() => go(i, state)}
			onkeydown={(e) => { const k = e.key ?? e.detail?.key; if (k === 'enter' || k === 'space') go(i, state); }}
			role="listitem" aria-current={state === 'active' ? 'step' : undefined}
		>
			<div use:applyStyle={circleS(state)}>
				{#if state === 'done'}<svg use:nativeProps={{ source: icons.check }} use:applyStyle={s({ icon: 'sm' }, ctx)}></svg>{:else}{i + 1}{/if}
			</div>
			<div>
				<div use:applyStyle={labelS(state)}>{step.label}</div>
				{#if step.description}<div use:applyStyle={s({ text: 'xs', fg: 'neutral-readable' })}>{step.description}</div>{/if}
			</div>
		</div>
		{#if i < steps.length - 1}<div use:applyStyle={lineS}></div>{/if}
	{/each}
</div>
