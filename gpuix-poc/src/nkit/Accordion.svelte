<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { accordionTheme } from './recipes/nav.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { slide } from './transitions.js';
	import { icons } from './icons.js';

	let {
		items = [],            // [{value, title, disabled?, content — string | snippet}]
		open = $bindable(null), // array of open values
		defaultValue,          // initial open values when unbound
		oneAtATime = false,    // svelai name; `single` kept as alias
		single = false,
		variant ,   // classic | card | outline
		splitted = false,      // gaps between items
		size ,
		density ,
		icon,                  // 'chevron' | 'plus' | custom icon name | null hides
		onValueChange,
		onchange,
		class: klass = '',
		style = null,
		theme = null,
		...rest
	} = $props();

	open ??= defaultValue ?? [];
	const ct = useComponentTheme('accordion', theme, ['item', 'trigger', 'content', 'chevron']);
	const vp = $derived(ct.props({ variant, splitted, size, density }));
	const exclusive = $derived(oneAtATime || single);
	const rootS = $derived(mergeStyleDesc(s(ct.root(accordionTheme.root, vp, style)), resolveTokens(klass)));
	const itemS = $derived(s(ct.slot('item', accordionTheme.item, vp)));
	const triggerS = (dis) => s(ct.slot('trigger', accordionTheme.trigger, { ...vp, disabled: dis }));
	const contentS = $derived(s(ct.slot('content', accordionTheme.content, vp)));
	const chevS = $derived(s(ct.slot('chevron', accordionTheme.chevron, vp)));

	const isOpen = (v) => open.includes(v);
	const toggle = (it) => {
		if (it.disabled) return;
		open = exclusive
			? isOpen(it.value) ? [] : [it.value]
			: isOpen(it.value) ? open.filter((v) => v !== it.value) : [...open, it.value];
		onValueChange?.(open);
		onchange?.(open);
	};
	const iconName = $derived(icon === undefined ? 'chevron' : icon);
</script>

<div use:applyStyle={rootS} {...rest}>
	{#each items as it}
		<div use:applyStyle={itemS}>
			<div
				use:applyStyle={triggerS(it.disabled)}
				use:nativeProps={{ tabIndex: it.disabled ? undefined : 0 }}
				onclick={() => toggle(it)}
				onkeydown={(e) => { const k = e.key ?? e.detail?.key; if (k === 'enter' || k === 'space') { toggle(it); e.preventDefault?.(); } }}
				role="button" aria-expanded={isOpen(it.value)}
			>
				<span>{it.title}</span>
				{#if iconName === 'plus'}
					<svg use:nativeProps={{ source: isOpen(it.value) ? icons.minus : icons.plus }} use:applyStyle={chevS}></svg>
				{:else if iconName === 'chevron'}
					<svg use:nativeProps={{ source: isOpen(it.value) ? icons['chevron-up'] : icons['chevron-down'] }} use:applyStyle={chevS}></svg>
				{:else if iconName}
					<svg use:nativeProps={{ source: icons[iconName] ?? iconName }} use:applyStyle={chevS}></svg>
				{/if}
			</div>
			{#if isOpen(it.value)}
				<div
					use:applyStyle={contentS}
					transition:slide={{
						duration: ct.state.preferReducesMotion ? 0 : ct.state.motion.duration.normal,
						easing: ct.state.motion.easing.standard,
					}}
				>
					{#if typeof it.content === 'function'}{@render it.content()}{:else}{it.content}{/if}
				</div>
			{/if}
		</div>
	{/each}
</div>
