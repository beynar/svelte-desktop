<script>
	import { s } from '../style.js';
	import { applyStyle } from '../apply.js';
	import Sidebar from '../Sidebar.svelte';
	import Theme from '../Theme.svelte';
	import SegmentedControl from '../SegmentedControl.svelte';
	import Switch from '../Switch.svelte';
	import { pages } from './pages.js';

	const groups = [...new Set(pages.map((p) => p.group))];
	const nav = groups.flatMap((g) => [
		{ type: 'section', label: g },
		...pages.filter((p) => p.group === g).map((p) => ({ value: p.name, label: p.name })),
	]);

	let active = $state(globalThis.process?.env?.PAGE ?? pages[0]?.name);
	const current = $derived(pages.find((p) => p.name === active));

	// global design-token controls — feed <Theme designTokens> live
	let radiusSel = $state('normal');
	let spacingSel = $state('normal');
	const dts = $derived({
		light: { radius: radiusSel, spacing: spacingSel },
		dark: { radius: radiusSel, spacing: spacingSel },
	});

	// ThemeState field controls — local $state mirrors + write-through effects
	// (bind: into a $bindable-with-fallback prop rejects undefined values)
	let colorSel = $state('neutral');
	let sizeSel = $state('normal');
	let densitySel = $state('normal');
	let reduced = $state(false);

	const rootS = $derived(s({ row: true, w: '100%', h: '100%', bg: 'surface-canvas' }));
	const bodyS = $derived(s({ col: true, flex1: true, overflow: 'hidden' }));
	const barS = $derived(s({ row: true, gap: 'layout-md', items: 'center', p: 'sm', borderB: 1, border: 'neutral-muted', shrink: 0 }));
	const capS = $derived(s({ text: 'xs', fg: 'neutral-readable' }));
	const readoutS = $derived(s({ text: 'xs', fg: 'neutral-readable' }));
	const spacerS = $derived(s({ flex1: true }));
</script>

<Theme defaultTheme="system" designTokens={dts}>
	{#snippet children(th)}
		<div use:applyStyle={rootS}>
			<Sidebar items={nav} bind:active color="primary" />
			<div use:applyStyle={bodyS}>
				<div use:applyStyle={barS}>
					<div use:applyStyle={capS}>theme</div>
					<SegmentedControl options={[{ value: 'light', label: 'light' }, { value: 'dark', label: 'dark' }, { value: 'system', label: 'system' }]} bind:value={th.theme} size="small" />
					<div use:applyStyle={capS}>accent</div>
					<SegmentedControl options={['primary', 'danger', 'success', 'warning', 'info', 'neutral'].map((v) => ({ value: v, label: v }))} bind:value={colorSel} onValueChange={(v) => (th.defaultColorBase = v)} size="small" />
					<div use:applyStyle={capS}>size</div>
					<SegmentedControl options={['small', 'normal', 'large'].map((v) => ({ value: v, label: v }))} bind:value={sizeSel} onValueChange={(v) => (th.size = v)} size="small" />
					<div use:applyStyle={capS}>density</div>
					<SegmentedControl options={['compact', 'normal', 'comfortable'].map((v) => ({ value: v, label: v }))} bind:value={densitySel} onValueChange={(v) => (th.density = v)} size="small" />
					<div use:applyStyle={capS}>radius</div>
					<SegmentedControl options={['none', 'small', 'normal', 'large', 'round'].map((v) => ({ value: v, label: v }))} bind:value={radiusSel} size="small" />
					<div use:applyStyle={capS}>spacing</div>
					<SegmentedControl options={['small', 'normal', 'large'].map((v) => ({ value: v, label: v }))} bind:value={spacingSel} size="small" />
					<div use:applyStyle={capS}>reduce motion</div>
					<Switch bind:on={reduced} onValueChange={(v) => (th.reduceMotion = v || undefined)} size="small" />
					<div use:applyStyle={spacerS}></div>
					<div use:applyStyle={readoutS}>
						resolved={th.resolvedTheme} bp={th.currentBreakpoint} rm={th.preferReducesMotion}
					</div>
				</div>
				{#if current}
					{@const Page = current.component}
					<Page />
				{/if}
			</div>
		</div>
	{/snippet}
</Theme>
