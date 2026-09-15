<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { fade } from './transitions.js';
	import { tabsTheme } from './recipes/nav.js';

	let {
		tabs,                  // [{value, label, disabled?}] — `items` is the svelai alias
		items,
		value = $bindable(null),
		defaultValue,
		variant ,
		placement = 'top',     // top | bottom — bar position relative to the panel
		color,
		onchange,
		onValueChange,
		class: klass = '',
		style = null,
		theme = null,
		children,            // optional panel content snippet: (value) => node
		...rest
	} = $props();

	const list = $derived(items ?? tabs ?? []);
	const ct = useComponentTheme('tabs', theme, ['list', 'trigger', 'panel']);
	const vp = $derived(ct.props({ variant, color, placement }));
	const ctx = $derived({ color: vp.color });
	value ??= defaultValue ?? list[0]?.value;
	// tabs may populate async — default once a value exists
	$effect(() => {
		if (value == null && list.length) value = list[0].value;
	});
	const listS = $derived(mergeStyleDesc(s(ct.slot('list', tabsTheme.list, vp, style)), resolveTokens(klass, ctx)));
	const triggerS = (active, dis) => s(ct.slot('trigger', tabsTheme.trigger, { ...vp, active, disabled: dis }), ctx);
	const panelS = $derived(s(ct.slot('panel', tabsTheme.panel, vp), ctx));
	const pick = (t) => {
		if (t.disabled || value === t.value) return;
		value = t.value;
		onchange?.(t.value);
		onValueChange?.(t.value);
	};
	const keyNav = (t, e) => {
		const k = e.key ?? e.detail?.key;
		const i = list.indexOf(t);
		if (k === 'right' || k === 'arrowright') {
			for (let n = i + 1; n < list.length; n++) if (!list[n].disabled) return pick(list[n]);
		} else if (k === 'left' || k === 'arrowleft') {
			for (let n = i - 1; n >= 0; n--) if (!list[n].disabled) return pick(list[n]);
		} else if (k === 'enter' || k === 'space') pick(t);
	};
</script>

<div style="display:flex;flex-direction:column;flex:1" {...rest}>
	{#if placement === 'bottom'}
		{#key value}
			<div
				use:applyStyle={panelS} role="tabpanel"
				transition:fade={{
					duration: ct.state.preferReducesMotion ? 0 : ct.state.motion.duration.fast,
					easing: ct.state.motion.easing.standard,
				}}
			>{@render children?.(value)}</div>
		{/key}
	{/if}
	<div use:applyStyle={listS} role="tablist">
		{#each list as t}
			{@const active = value === t.value}
			<div
				use:applyStyle={triggerS(active, t.disabled)}
				use:nativeProps={{ tabIndex: t.disabled ? undefined : 0 }}
				onclick={() => pick(t)}
				onkeydown={(e) => keyNav(t, e)}
				role="tab" aria-selected={active}
			>{t.label ?? t.value}</div>
		{/each}
	</div>
	{#if placement !== 'bottom'}
		{#key value}
			<div
				use:applyStyle={panelS} role="tabpanel"
				transition:fade={{
					duration: ct.state.preferReducesMotion ? 0 : ct.state.motion.duration.fast,
					easing: ct.state.motion.easing.standard,
				}}
			>
				{@render children?.(value)}
			</div>
		{/key}
	{/if}
</div>
