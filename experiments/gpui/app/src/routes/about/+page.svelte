<script lang="ts">
	import { resolve } from '$app/paths';
	import { getState } from '#lib/data.remote';

	let {data } = $props()
</script>

<div class="page">
	<svelte:boundary>
		{@const state = await getState()}

		<header class="page-head">
			<h1 class="title">About</h1>
			{data.hello}
			<p class="subtitle">
				This window is rendered by GPUI — no webview, no DOM.
			</p>
		</header>

		<div class="card">
			<div class="card-title">The stack</div>
			<div class="row">
				<div class="row-key">authoring</div>
				<div class="row-val">SvelteKit-shaped routes · +page/+layout/.remote.ts</div>
			</div>
			<div class="row">
				<div class="row-key">styles</div>
				<div class="row-val">&lt;style&gt; blocks → Rust cascade → native paint</div>
			</div>
			<div class="row">
				<div class="row-key">data</div>
				<div class="row-val">remote functions in-process · bun:sqlite</div>
			</div>
			<div class="row">
				<div class="row-key">rendering</div>
				<div class="row-val">fake DOM ops → NAPI → GPUI elements</div>
			</div>
		</div>

		<div class="card">
			<div class="card-title">Runtime</div>
			<div class="row">
				<div class="row-key">server</div>
				<div class="row-val">{state.runtime} · pid {state.pid}</div>
			</div>
			<div class="row">
				<div class="row-key">host</div>
				<div class="row-val">{state.host}</div>
			</div>
			<div class="row">
				<div class="row-key">native bridge</div>
				<div class="row-val">
					{state.nativeBridge ? 'connected' : 'absent'}
				</div>
			</div>
		</div>

		<div class="card">
			<div class="card-title">:hover — resolved natively, no JS listeners</div>
			<div class="swatches">
				<div class="swatch sw-a"></div>
				<div class="swatch sw-b"></div>
				<div class="swatch sw-c"></div>
				<div class="swatch sw-d"></div>
				<div class="swatch sw-e"></div>
			</div>
		</div>

		<a class="back" href={resolve('/')}>← back to notes</a>

		{#snippet pending()}
			<p class="loading">loading…</p>
		{/snippet}
	</svelte:boundary>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		height: 100%;
		padding: 26px 30px;
		gap: 14px;
	}
	.page-head {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding-bottom: 4px;
	}
	.title {
		font-size: 24px;
		font-weight: 700;
	}
	.subtitle {
		font-size: 12px;
		color: #8e8e96;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 16px 18px;
		border-radius: 12px;
		background-color: #26262d;
		border-width: 1px;
		border-color: #35353d;
	}
	.card-title {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.6px;
		color: #8e8e96;
		padding-bottom: 4px;
	}
	.row {
		display: flex;
		flex-direction: row;
		gap: 14px;
		align-items: baseline;
	}
	.row-key {
		width: 96px;
		font-size: 12px;
		color: #6e6e76;
		flex-shrink: 0;
	}
	.row-val {
		font-size: 12px;
		color: #e8e8ec;
	}
	.swatches {
		display: flex;
		flex-direction: row;
		gap: 8px;
		padding-top: 4px;
	}
	.swatch {
		width: 44px;
		height: 44px;
		border-radius: 10px;
		border-width: 1px;
		border-color: #3a3a44;
	}
	.sw-a { background-color: #0a84ff; }
	.sw-a:hover { background-color: #409cff; }
	.sw-b { background-color: #30d158; }
	.sw-b:hover { background-color: #5ce082; }
	.sw-c { background-color: #ff9f0a; }
	.sw-c:hover { background-color: #ffb840; }
	.sw-d { background-color: #ff453a; }
	.sw-d:hover { background-color: #ff6e66; }
	.sw-e { background-color: #bf5af2; }
	.sw-e:hover { background-color: #d084f7; }
	.back {
		font-size: 12px;
		color: #0a84ff;
		padding-top: 4px;
		cursor: pointer;
	}
	.back:hover {
		color: #409cff;
	}
	.loading {
		font-size: 13px;
		color: #8e8e96;
	}
</style>
