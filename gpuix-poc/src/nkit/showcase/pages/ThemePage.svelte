<script>
	import ComponentPage from '../ComponentPage.svelte';
	import ComponentTheme from '../../ComponentTheme.svelte';
	import Button from '../../Button.svelte';
	import Chip from '../../Chip.svelte';
	import Spinner from '../../Spinner.svelte';
	import { useTheme } from '../../theming.svelte.js';
	import { fade, fly } from '../../transitions.js';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';

	const th = useTheme();

	const controls = [
		{ key: 'spinnerVariant', type: 'select', options: ['default', 'grid', 'pulse', 'puff', 'lines', 'circles'], value: 'default' },
		{ key: 'motionMs', type: 'select', options: ['fast', 'normal', 'slow', 'slower'], value: 'normal' },
	];

	let showBox = $state(true);
	let bumped = $state(false);

	const rowS = $derived(s({ row: true, gap: 'md', items: 'center' }));
	const blockS = $derived(s({ col: true, gap: 'sm', p: 'md', bg: 'surface-raised', radius: 'md', border: 1, borderColor: 'neutral-muted' }));
	const hS = $derived(s({ text: 'sm', fontW: 600, fg: 'neutral' }));
	const noteS = $derived(s({ text: 'xs', fg: 'neutral-readable' }));
	const boxS = $derived(s({ w: 120, h: 60, bg: 'primary-muted', radius: 'md', items: 'center', justify: 'center' }));
	const boxTextS = $derived(s({ text: 'xs', fg: 'primary-readable' }));
</script>

<ComponentPage
	title="Theme"
	description="global ThemeState — live tokens, registry defaults, subtree overrides, motion"
	{controls}
>
	{#snippet demo(p)}
		<div use:applyStyle={blockS}>
			<div use:applyStyle={hS}>live ThemeState</div>
			<div use:applyStyle={noteS}>
				resolved={th.resolvedTheme} defaultColor={th.defaultColor} size={th.size ?? '—'} density={th.density ?? '—'}
				bp={th.currentBreakpoint} reduceMotion={th.preferReducesMotion}
			</div>
			<div use:applyStyle={noteS}>
				motion: fast={th.motion.duration.fast}ms normal={th.motion.duration.normal}ms slow={th.motion.duration.slow}ms
				easing={th.motion.easing.standard}
			</div>
		</div>

		<div use:applyStyle={blockS}>
			<div use:applyStyle={hS}>ComponentTheme — subtree registry override</div>
			<div use:applyStyle={noteS}>plain vs wrapped in components={'{'}button:{'{'}size:'large',variant:'soft'{'}'}, chip:{'{'}color:'info'{'}'}{'}'}</div>
			<div use:applyStyle={rowS}>
				<Button label="plain" />
				<Chip label="plain chip" />
				<ComponentTheme components={{ button: { size: 'large', variant: 'soft' }, chip: { color: 'info' } }}>
					<Button label="overridden" />
					<Chip label="themed chip" />
				</ComponentTheme>
			</div>
		</div>

		<div use:applyStyle={blockS}>
			<div use:applyStyle={hS}>instance theme prop — per-component override</div>
			<div use:applyStyle={rowS}>
				<Chip label="normal" />
				<Chip label="themed" theme={{ color: 'danger', root: { base: { radius: 'full' } } }} />
			</div>
		</div>

		<div use:applyStyle={blockS}>
			<div use:applyStyle={hS}>spinnerVariant — Theme-level default</div>
			<div use:applyStyle={rowS}>
				<Spinner variant={p.spinnerVariant} label="variant prop" />
				<ComponentTheme components={{ spinner: { variant: 'circles' } }}>
					<Spinner label="registry circles" />
				</ComponentTheme>
			</div>
		</div>

		<div use:applyStyle={blockS}>
			<div use:applyStyle={hS}>transitions — theme-resolved duration + reduced-motion collapse</div>
			<div use:applyStyle={rowS}>
				<Button size="small" label={showBox ? 'hide' : 'show'} onclick={() => (showBox = !showBox)} />
				{#if showBox}
					<div use:applyStyle={boxS} transition:fly={{ y: 12, duration: p.motionMs }}>
						<div use:applyStyle={boxTextS}>fly {p.motionMs}</div>
					</div>
					<div use:applyStyle={boxS} transition:fade={{ duration: p.motionMs }}>
						<div use:applyStyle={boxTextS}>fade {p.motionMs}</div>
					</div>
				{/if}
			</div>
			<div use:applyStyle={noteS}>toggle "reduce motion" in the header → duration collapses to 0</div>
		</div>
	{/snippet}
</ComponentPage>
