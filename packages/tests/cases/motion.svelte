<script>
	import { fade, fly, scale, slide, blur, crossfade } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { cubicInOut, elasticOut } from 'svelte/easing';

	let tSpin = $state(true);
	let tBlur = $state(true);

	function spinIn(node, { duration = 450 } = {}) {
		return {
			duration,
			easing: elasticOut,
			css: (t, u) =>
				`transform: rotate(${u * -200}deg) scale(${0.2 + t * 0.8}); opacity: ${t}`,
		};
	}

	const [send, receive] = crossfade({ duration: 300, easing: cubicInOut });
	let lanes = $state({ left: [1, 2, 3], right: [] });
	function hop(id) {
		if (lanes.left.includes(id)) {
			lanes.left = lanes.left.filter((i) => i !== id);
			lanes.right = [...lanes.right, id];
		} else {
			lanes.right = lanes.right.filter((i) => i !== id);
			lanes.left = [...lanes.left, id].sort();
		}
	}

	let flipItems = $state([1, 2, 3, 4, 5]);
	function reorder() {
		flipItems = [...flipItems].reverse();
	}

	function burst(e) {
		e.currentTarget.animate(
			[
				{ transform: 'scale(1)', offset: 0 },
				{ transform: 'scale(1.3)', offset: 0.5 },
				{ transform: 'scale(1)', offset: 1 },
			],
			{ duration: 300 },
		);
	}

	let pulseAnim = null;
	let pulsing = $state(false);
	function togglePulse(e) {
		const el = e.currentTarget;
		if (pulsing) {
			pulseAnim?.cancel();
			pulseAnim = null;
			pulsing = false;
			return;
		}
		pulseAnim = el.animate(
			[{ transform: 'scale(1)' }, { transform: 'scale(1.4)' }],
			{ duration: 400, iterations: Infinity, direction: 'alternate' },
		);
		pulsing = true;
	}

	let marqAnim = null;
	let marqOn = $state(false);
	function toggleMarquee(e) {
		const el = e.currentTarget;
		if (marqOn) {
			marqAnim?.cancel();
			marqAnim = null;
			marqOn = false;
			return;
		}
		marqAnim = el.animate(
			[{ transform: 'translateX(0)' }, { transform: 'translateX(-160px)' }],
			{ duration: 600, iterations: Infinity },
		);
		marqOn = true;
	}

	let chainState = $state('idle');
	async function chain(e) {
		const el = e.currentTarget;
		chainState = 's1';
		await el.animate(
			[{ transform: 'translateX(0)' }, { transform: 'translateX(60px)' }],
			{ duration: 120, fill: 'forwards' },
		).finished;
		chainState = 's2';
		await el.animate(
			[{ transform: 'translateX(60px)' }, { transform: 'translateX(0)' }],
			{ duration: 120, fill: 'forwards' },
		).finished;
		chainState = 'done';
	}
</script>
<div>
	{#if tSpin}
		<div class="spinbox" style="width: 60px; height: 40px" in:spinIn out:spinIn={{ duration: 200 }}>spin</div>
	{/if}
	<button onclick={() => (tSpin = !tSpin)}>spintoggle</button>

	{#if tBlur}
		<div class="blurbox" style="width: 60px; height: 40px" in:blur={{ duration: 200 }} out:blur={{ duration: 200 }}>blur</div>
	{/if}
	<button onclick={() => (tBlur = !tBlur)}>blurtoggle</button>

	<div class="lane-l">
		{#each lanes.left as id (id)}
			<div class="token" in:receive={{ key: id }} out:send={{ key: id }} onclick={() => hop(id)}>L{id}</div>
		{/each}
	</div>
	<div class="lane-r">
		{#each lanes.right as id (id)}
			<div class="token" in:receive={{ key: id }} out:send={{ key: id }} onclick={() => hop(id)}>R{id}</div>
		{/each}
	</div>

	<div class="fliplane">
		{#each flipItems as id (id)}
			<div class="fliptok" animate:flip={{ duration: 300 }}>F{id}</div>
		{/each}
	</div>
	<button onclick={reorder}>fliptoggle</button>

	<div class="burstbox" style="width: 60px; height: 40px" onclick={burst}>burst</div>
	<div class="pulsebox" style="width: 60px; height: 40px" onclick={togglePulse}>pulse</div>

	<div class="marqclip" style="width: 200px; height: 40px; overflow: hidden">
		<div class="marqbox" style="width: 60px; height: 40px" onclick={toggleMarquee}>marquee</div>
	</div>
	<div class="chainbox" style="width: 60px; height: 40px" onclick={chain}>chain {chainState}</div>
	<div class="cssanimbox">cssanim</div>
</div>
<style>
	@keyframes cssspin {
		to {
			transform: rotate(360deg);
		}
	}
	.cssanimbox {
		width: 60px;
		height: 40px;
		animation: cssspin 300ms linear infinite;
	}
</style>
