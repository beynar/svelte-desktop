<script>
	import { s, mergeStyleDesc } from './style.js';
	import { resolveTokens } from './tokens.js';
	import { applyStyle, nativeProps } from './apply.js';
	import { useComponentTheme } from './theming.svelte.js';
	import { fso } from './transitions.js';
	import { dialogTheme, dialogMotion } from './recipes/overlay.js';
	import { layerProps } from './overlay.js';
	import { icons } from './icons.js';

	let {
		open = $bindable(null),
		defaultOpen = false,
		title,
		description,
		size ,
		closable = true,          // show the × close button
		closeButton,              // snippet — custom close button replaces the ×
		closeOnOutside,           // deprecated alias — `closeOnClickOutside` is the svelai name
		closeOnClickOutside = true,
		closeOnEscape = true,
		scroll = false,           // content scrolls when taller than the card
		trigger,                  // snippet — opens on click
		onclose,
		onOpenChange,
		footer,
		class: klass = '',
		style = null,
		theme = null,
		transition,               // instance FSO transition — top of the motion ladder
		children,
		...rest
	} = $props();

	open ??= defaultOpen;
	const ct = useComponentTheme('dialog', theme, ['card', 'title', 'description', 'footer', 'head', 'close', 'scrim']);
	const vp = $derived(ct.props({ size, scroll }));
	const mv = $derived(ct.motion(dialogMotion, vp, transition));
	const cardS = $derived(mergeStyleDesc(s(ct.slot('card', dialogTheme.card, vp, style)), resolveTokens(klass)));
	const titleS = $derived(s(ct.slot('title', dialogTheme.title, vp)));
	const descS = $derived(s(ct.slot('description', dialogTheme.description, vp)));
	const footerS = $derived(s(ct.slot('footer', dialogTheme.footer, vp)));
	const headS = $derived(s(ct.slot('head', { row: true, items: 'start', justify: 'between', gap: 'md' }, vp)));
	const closeS = $derived(s(ct.slot('close', { icon: 'sm', fg: 'neutral-readable', cursor: 'pointer', shrink: 0, hover: { fg: 'neutral' } }, vp)));
	// full-viewport layer: the scrim IS the wrapper (bg + centered card)
	const scrim = $derived(
		s(ct.slot('scrim', {
			position: 'absolute', left: 0, top: 0,
			w: window.innerWidth, h: window.innerHeight,
			bg: 'black/55', flex: true, direction: 'column', items: 'center', justify: 'center',
		}, vp)),
	);
	const outsideEnabled = $derived(closeOnOutside ?? closeOnClickOutside);
	const setOpen = (v) => { if (open === v) return; open = v; onOpenChange?.(v); if (!v) onclose?.(); };
	const onKey = (e) => {
		if (open && closeOnEscape && (e.key === 'escape' || e.detail?.key === 'escape')) setOpen(false);
	};
	// outro params for the anchored layer (spec frames + resolved timing)
	const outParams = $derived(
		mv?.out ? { ...mv.spec?.out, duration: mv.out.ms, easing: mv.out.transition.ease } : { duration: 0 },
	);
</script>

<svelte:window onkeydown={onKey} />
{#if trigger}
	<span style="display:flex;align-self:flex-start" onclick={() => setOpen(true)}>{@render trigger()}</span>
{/if}
{#if open}
	<anchored use:nativeProps={layerProps({ at: { x: 0, y: 0 } })} out:fso={outParams}>
		<div
			use:applyStyle={scrim}
			use:nativeProps={{ autoFocus: true, tabIndex: 0 }}
			onmousedown={(e) => { if (outsideEnabled && e.target === e.currentTarget) setOpen(false); }}
		>
			<div
				use:applyStyle={cardS}
				use:nativeProps={mv?.in ? { motion: mv.in } : {}}
				role="dialog" aria-modal="true"
				{...rest}
			>
				{#if title || closable || description}
					<div use:applyStyle={headS}>
						<div>
							{#if title}<div use:applyStyle={titleS}>{title}</div>{/if}
							{#if description}<div use:applyStyle={descS}>{description}</div>{/if}
						</div>
						{#if closeButton}
							{@render closeButton({ close: () => setOpen(false) })}
						{:else if closable}
							<svg
								use:nativeProps={{ source: icons.x, tabIndex: 0 }}
								use:applyStyle={closeS}
								onclick={() => setOpen(false)}
								role="button" aria-label="Close"
							/>
						{/if}
					</div>
				{/if}
				{@render children?.()}
				{#if footer}<div use:applyStyle={footerS}>{@render footer()}</div>{/if}
			</div>
		</div>
	</anchored>
{/if}
