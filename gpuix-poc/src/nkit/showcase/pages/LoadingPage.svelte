<script>
	import ComponentPage from '../ComponentPage.svelte';
	import Skeleton from '../../Skeleton.svelte';
	import Spinner from '../../Spinner.svelte';
	import SpinnerText from '../../SpinnerText.svelte';
	import Progress from '../../Progress.svelte';
	import ProgressCircle from '../../ProgressCircle.svelte';
	import { s } from '../../style.js';
	import { applyStyle } from '../../apply.js';
	import { onMount } from 'svelte';

	const controls = [
		{ key: 'shape', type: 'select', options: ['line', 'circle', 'block'], value: 'line' },
		{ key: 'size', type: 'select', options: ['small', 'normal', 'large'], value: 'normal' },
	];
	let pct = $state(40);
	onMount(() => {
		const t = setInterval(() => (pct = (pct + 7) % 100), 400);
		return () => clearInterval(t);
	});
	const row = $derived(s({ row: true, gap: 'lg', items: 'center' }));
	const col = $derived(s({ col: true, gap: 'sm', w: 360 }));
</script>

<ComponentPage title="Skeleton / Spinner / Progress" description="gpuix has no looping animation — pulse/sweep are JS-driven" {controls}>
	{#snippet demo(p)}
		<div use:applyStyle={col}>
			<Skeleton shape={p.shape} />
			<Skeleton shape="line" w="70%" />
			<Skeleton shape="line" w="40%" />
		</div>
		<div use:applyStyle={row}>
			<Spinner size="small" /><Spinner /><Spinner size="large" color="primary" />
			<SpinnerText color="primary" />
		</div>
		<div use:applyStyle={row}>
			<ProgressCircle value={pct} size={p.size} color="primary" label />
			<ProgressCircle value={75} color="success" label />
			<ProgressCircle value={30} color="warning" />
		</div>
		<div use:applyStyle={col}>
			<Progress value={pct} color="primary" showLabel />
			<Progress value={75} color="success" />
			<Progress value={30} color="warning" />
			<Progress value={90} color="danger" />
		</div>
	{/snippet}
</ComponentPage>
