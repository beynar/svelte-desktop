<script lang="ts">
	import { fade, fly, scale, slide, blur, crossfade } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { cubicInOut, elasticOut } from 'svelte/easing';

	// ── svelte transitions ──────────────────────────────────────────────────
	let tFade = $state(true);
	let tFly = $state(true);
	let tScale = $state(true);
	let tScaleOrigin = $state(true);
	let tSlide = $state(true);
	let tBlur = $state(true);
	let tSpin = $state(true);

	// Custom css(t) transition — the same contract collapseX uses, but
	// emitting the transform vocabulary: rotate + scale through the native
	// transform stack.
	function spinIn(node: Element, { duration = 450 } = {}) {
		return {
			duration,
			easing: elasticOut,
			css: (t: number, u: number) =>
				`transform: rotate(${u * -200}deg) scale(${0.2 + t * 0.8}); opacity: ${t}`,
		};
	}

	// ── crossfade ───────────────────────────────────────────────────────────
	const [send, receive] = crossfade({
		duration: 380,
		easing: cubicInOut,
	});
	let lanes = $state<{ left: number[]; right: number[] }>({
		left: [1, 2, 3],
		right: [],
	});
	function hop(id: number) {
		if (lanes.left.includes(id)) {
			lanes.left = lanes.left.filter((i) => i !== id);
			lanes.right = [...lanes.right, id];
		} else {
			lanes.right = lanes.right.filter((i) => i !== id);
			lanes.left = [...lanes.left, id].sort();
		}
	}

	// ── animate:flip — keyed list, reorder glides ───────────────────────────
	let flipItems = $state([1, 2, 3, 4, 5]);
	function shuffle() {
		flipItems = [...flipItems].sort(() => Math.random() - 0.5);
	}

	// ── imperative element.animate() ────────────────────────────────────────
	function burst(e: MouseEvent) {
		(e.currentTarget as HTMLElement).animate(
			[
				{ transform: 'scale(1)', offset: 0 },
				{ transform: 'scale(1.25) rotate(6deg)', offset: 0.4 },
				{ transform: 'scale(0.92) rotate(-3deg)', offset: 0.7 },
				{ transform: 'scale(1) rotate(0deg)', offset: 1 },
			],
			{ duration: 420 },
		);
	}

	let pulseAnim: { cancel(): void } | null = null;
	let pulsing = $state(false);
	function togglePulse(e: MouseEvent) {
		const el = e.currentTarget as HTMLElement;
		if (pulsing) {
			pulseAnim?.cancel();
			pulseAnim = null;
			pulsing = false;
			return;
		}
		pulseAnim = el.animate(
			[
				{ transform: 'scale(1)', opacity: 1 },
				{ transform: 'scale(1.35)', opacity: 0.45 },
			],
			{ duration: 600, iterations: Infinity, direction: 'alternate' },
		) as unknown as { cancel(): void };
		pulsing = true;
	}

	let chainState = $state('idle');
	async function chain(e: MouseEvent) {
		const el = e.currentTarget as HTMLElement;
		chainState = 'translate…';
		await el.animate(
			[{ transform: 'translateX(0)' }, { transform: 'translateX(140px)' }],
			{ duration: 320, fill: 'forwards' },
		).finished.catch(() => {});
		chainState = 'rotate…';
		await el.animate(
			[{ transform: 'translateX(140px) rotate(0deg)' }, { transform: 'translateX(140px) rotate(180deg)' }],
			{ duration: 320, fill: 'forwards' },
		).finished.catch(() => {});
		chainState = 'back…';
		await el.animate(
			[{ transform: 'translateX(140px) rotate(180deg)' }, { transform: 'translateX(0) rotate(0deg)' }],
			{ duration: 420, fill: 'forwards' },
		).finished.catch(() => {});
		chainState = 'idle';
	}

	let marqueeAnim: { pause(): void; play(): void; playState?: string } | null = null;
	let marqueePaused = $state(false);
	function startMarquee(e: MouseEvent) {
		const el = e.currentTarget as HTMLElement;
		if (marqueeAnim) return;
		marqueeAnim = el.animate(
			[{ transform: 'translateX(0)' }, { transform: 'translateX(-160px)' }],
			{ duration: 2600, iterations: Infinity, direction: 'alternate' },
		) as unknown as typeof marqueeAnim;
	}
	function toggleMarqueePause() {
		if (!marqueeAnim) return;
		if (marqueePaused) marqueeAnim.play();
		else marqueeAnim.pause();
		marqueePaused = !marqueePaused;
	}

	// ── css animation lane ─────────────────────────────────────────────────
	// `.css-spin` declares @keyframes + animation: — the stylesheet pipeline
	// lowers it onto element.animate(), so the left square spins on its own.
	// The right square drives the same keyframes imperatively for contrast.
	let cssSpinEl: HTMLElement | undefined = $state();
	let cssSpinAnim: { cancel(): void } | null = $state(null);
	function toggleCssSpin() {
		if (cssSpinAnim) {
			cssSpinAnim.cancel();
			cssSpinAnim = null;
			return;
		}
		cssSpinAnim = cssSpinEl?.animate(
			[{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
			{ duration: 1200, iterations: Infinity },
		) as unknown as { cancel(): void } ?? null;
	}
</script>

<div class="page">
	<header class="page-head">
		<div class="head-text">
			<h1 class="title">Motion</h1>
			<p class="subtitle">
				three lanes, one renderer — Svelte transitions, imperative WAAPI,
				and declared CSS animation. everything below paints through the
				native transform stack; no webview anywhere.
			</p>
		</div>
	</header>

	<div class="scroll">
		<section>
			<h2 class="sec-title">Svelte transitions</h2>
			<p class="sec-sub">
				every card uses <code>transition:</code> — one shared manager, so a
				mid-flight toggle reverses from the live position instead of
				replaying. (<code>in:</code>/<code>out:</code> pairs run two managers;
				crossfade below needs them.)
			</p>
			<div class="grid">
				<div class="card">
					<div class="card-head"><span class="card-name">fade</span><code class="card-tag">transition:fade</code></div>
					<div class="stage">
						{#if tFade}
							<div class="chip fade-chip" transition:fade={{ duration: 320 }}>fade</div>
						{/if}
					</div>
					<button class="btn" onclick={() => (tFade = !tFade)}>toggle</button>
				</div>

				<div class="card">
					<div class="card-head"><span class="card-name">fly</span><code class="card-tag">transition:fly — reversible</code></div>
					<div class="stage">
						{#if tFly}
							<div class="chip fly-chip" transition:fly={{ y: -44, duration: 320 }}>fly</div>
						{/if}
					</div>
					<button class="btn" onclick={() => (tFly = !tFly)}>toggle</button>
				</div>

				<div class="card">
					<div class="card-head"><span class="card-name">scale · center</span><code class="card-tag">transition:scale</code></div>
					<div class="stage">
						{#if tScale}
							<div class="chip scale-chip" transition:scale={{ start: 0, duration: 300 }}>scale</div>
						{/if}
					</div>
					<button class="btn" onclick={() => (tScale = !tScale)}>toggle</button>
				</div>

				<div class="card">
					<div class="card-head"><span class="card-name">scale · corner</span><code class="card-tag">transform-origin: top left</code></div>
					<div class="stage">
						{#if tScaleOrigin}
							<div
								class="chip scale-chip"
								style="transform-origin: top left"
								transition:scale={{ start: 0, duration: 300 }}
							>scale</div>
						{/if}
					</div>
					<button class="btn" onclick={() => (tScaleOrigin = !tScaleOrigin)}>toggle</button>
				</div>

				<div class="card">
					<div class="card-head"><span class="card-name">slide</span><code class="card-tag">transition:slide — height collapse</code></div>
					<div class="stage">
						{#if tSlide}
							<div class="chip slide-chip" transition:slide={{ duration: 300 }}>slide</div>
						{/if}
					</div>
					<button class="btn" onclick={() => (tSlide = !tSlide)}>toggle</button>
				</div>

				<div class="card">
					<div class="card-head"><span class="card-name">spin-in · custom</span><code class="card-tag">transition: css(t) → rotate+scale</code></div>
					<div class="stage">
						{#if tSpin}
							<div class="chip spin-chip" transition:spinIn={{ duration: 340 }}>spin</div>
						{/if}
					</div>
					<button class="btn" onclick={() => (tSpin = !tSpin)}>toggle</button>
				</div>

				<div class="card">
					<div class="card-head"><span class="card-name">blur</span><code class="card-tag warn">transition:blur — opacity only</code></div>
					<div class="stage">
						{#if tBlur}
							<div class="chip blur-chip" transition:blur={{ duration: 350 }}>blur</div>
						{/if}
					</div>
					<button class="btn" onclick={() => (tBlur = !tBlur)}>toggle</button>
				</div>
			</div>
		</section>

		<section>
			<h2 class="sec-title">crossfade — send/receive</h2>
			<p class="sec-sub">
				<code>transform-origin: top left</code> + translate + scale between
				counterpart elements, matched by key.
			</p>
			<div class="lane-row">
				<div class="lane">
					{#each lanes.left as id (id)}
						<button
							class="token"
							in:receive={{ key: id }}
							out:send={{ key: id }}
							onclick={() => hop(id)}
						>tok {id}</button>
					{/each}
				</div>
				<div class="lane-arrow">⇄ click a token</div>
				<div class="lane">
					{#each lanes.right as id (id)}
						<button
							class="token"
							in:receive={{ key: id }}
							out:send={{ key: id }}
							onclick={() => hop(id)}
						>tok {id}</button>
					{/each}
				</div>
			</div>
		</section>

		<section>
			<h2 class="sec-title">animate:flip — layout reorder</h2>
			<p class="sec-sub">
				keyed <code>{'{#each}'}</code> — bounds deltas become translate
				keyframes on reorder.
			</p>
			<div class="lane-row">
				<div class="lane wide">
					{#each flipItems as id (id)}
						<button class="token" animate:flip={{ duration: 300 }}>#{id}</button>
					{/each}
				</div>
				<button class="btn" onclick={shuffle}>shuffle</button>
			</div>
		</section>

		<section>
			<h2 class="sec-title">imperative — element.animate()</h2>
			<p class="sec-sub">
				WAAPI-lite: keyframes, offset, iterations, direction, fill,
				pause/play, cancel, <code>.finished</code>.
			</p>
			<div class="grid">
				<div class="card">
					<div class="card-head"><span class="card-name">burst</span><code class="card-tag">click me</code></div>
					<div class="stage">
						<button class="chip imp-chip" onclick={burst}>burst</button>
					</div>
					<div class="card-note">multi-keyframe scale+rotate, one shot</div>
				</div>

				<div class="card">
					<div class="card-head"><span class="card-name">pulse</span><code class="card-tag">iterations: ∞ · alternate</code></div>
					<div class="stage">
						<button class="chip imp-chip" onclick={togglePulse}>{pulsing ? 'stop' : 'pulse'}</button>
					</div>
					<div class="card-note">click to start, click again to cancel()</div>
				</div>

				<div class="card">
					<div class="card-head"><span class="card-name">marquee</span><code class="card-tag">pause()/play()</code></div>
					<div class="stage">
						<button class="chip imp-chip" onclick={startMarquee}>marquee →</button>
					</div>
					<div class="card-actions">
						<button class="btn" onclick={toggleMarqueePause}>
							{marqueePaused ? 'play' : 'pause'}
						</button>
					</div>
				</div>

				<div class="card">
					<div class="card-head"><span class="card-name">chain</span><code class="card-tag">await .finished</code></div>
					<div class="stage">
						<button class="chip imp-chip" onclick={chain}>chain</button>
					</div>
					<div class="card-note">{chainState}</div>
				</div>
			</div>
		</section>

		<section>
			<h2 class="sec-title">CSS animation — declared keyframes</h2>
			<p class="sec-sub">
				<code>@keyframes</code> + <code>animation:</code> lower onto
				<code>element.animate()</code> — the left square spins from the
				stylesheet alone; the right runs the same keyframes imperatively.
				<code>transition:</code> still has no channel.
			</p>
			<div class="lane-row">
				<div class="card mini">
					<div class="card-head"><span class="card-name">declared</span><code class="card-tag">@keyframes + animation:</code></div>
					<div class="stage">
						<div class="chip css-spin">spin</div>
					</div>
					<div class="card-note mono">@keyframes cssspin {'{'} to {'{'} transform: rotate(360deg) {'}'}{'}'}</div>
				</div>
				<div class="card mini">
					<div class="card-head"><span class="card-name">imperative</span><code class="card-tag">element.animate()</code></div>
					<div class="stage">
						<button class="chip css-spin-live" bind:this={cssSpinEl} onclick={toggleCssSpin}>
							{cssSpinAnim ? 'stop' : 'spin'}
						</button>
					</div>
					<div class="card-note">same keyframes, imperative driver</div>
				</div>
			</div>
		</section>
	</div>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		height: 100%;
		padding: 26px 30px 0 30px;
		gap: 14px;
		min-height: 0;
	}
	.page-head {
		display: flex;
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
	}
	.title {
		font-size: 24px;
		font-weight: 700;
	}
	.subtitle {
		font-size: 12px;
		color: #8e8e96;
		max-width: 560px;
	}
	.scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 26px;
		padding-bottom: 30px;
	}
	.sec-title {
		font-size: 14px;
		font-weight: 650;
		color: #e8e8ee;
	}
	.sec-sub {
		font-size: 11px;
		color: #7e7e88;
		margin-top: 3px;
		margin-bottom: 12px;
	}
	code {
		font-size: 10px;
		background-color: #2c2c34;
		padding: 1px 5px;
		border-radius: 4px;
		color: #b8b8c8;
	}
	.grid {
		display: flex;
		flex-direction: row;
		flex-wrap: wrap;
		gap: 12px;
	}
	.card {
		width: 210px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px;
		border-radius: 10px;
		background-color: #292930;
		border-width: 1px;
		border-color: #37373f;
	}
	.card.mini {
		width: 260px;
	}
	.card-head {
		display: flex;
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
		gap: 6px;
	}
	.card-name {
		font-size: 12px;
		font-weight: 600;
		color: #e8e8ee;
	}
	.card-tag {
		font-size: 9px;
		color: #7e7e88;
	}
	.card-tag.warn {
		color: #e0a04c;
	}
	.stage {
		position: relative;
		height: 72px;
		border-radius: 8px;
		background-color: #232329;
		border-width: 1px;
		border-color: #2e2e36;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
	}
	.chip {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 8px 18px;
		border-radius: 8px;
		font-size: 12px;
		font-weight: 600;
		color: #ffffff;
		cursor: pointer;
		user-select: none;
	}
	.fade-chip { background-color: #8e5cf7; }
	.fly-chip { background-color: #0a84ff; }
	.scale-chip { background-color: #30b0c7; }
	.slide-chip { background-color: #30d158; }
	.spin-chip { background-color: #ff9f0a; }
	.blur-chip { background-color: #bf5af2; }
	.imp-chip { background-color: #ff453a; }
	.css-spin { background-color: #3a3a44; }
	.css-spin-live { background-color: #0a84ff; }
	.card-note {
		font-size: 10px;
		color: #6e6e76;
	}
	.card-note.mono {
		font-family: ui-monospace, monospace;
	}
	.card-actions {
		display: flex;
		flex-direction: row;
		gap: 6px;
	}
	.lane-row {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 14px;
	}
	.lane {
		display: flex;
		flex-direction: row;
		gap: 8px;
		min-height: 46px;
		padding: 8px;
		border-radius: 10px;
		background-color: #232329;
		border-width: 1px;
		border-color: #2e2e36;
		min-width: 180px;
	}
	.lane.wide {
		min-width: 320px;
	}
	.lane-arrow {
		font-size: 11px;
		color: #6e6e76;
	}
	.token {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 6px 14px;
		border-radius: 7px;
		background-color: #0a84ff;
		color: #ffffff;
		font-size: 11px;
		font-weight: 600;
		cursor: pointer;
		user-select: none;
	}
	.btn {
		align-self: flex-start;
		padding: 6px 12px;
		border-radius: 7px;
		background-color: #35353d;
		border-width: 1px;
		border-color: #45454e;
		color: #e8e8ec;
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
		user-select: none;
	}
	.btn:hover {
		background-color: #404049;
		border-color: #55555f;
	}
	.btn:active {
		background-color: #2c2c33;
	}
	@keyframes cssspin {
		to { transform: rotate(360deg); }
	}
	.css-spin {
		animation: cssspin 1.2s linear infinite;
	}
</style>
