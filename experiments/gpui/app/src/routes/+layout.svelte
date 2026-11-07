<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import favicon from '#lib/assets/favicon.svg';
	import DevTools from '#lib/DevTools.svelte';
	import { initDevTools } from '#lib/devtools-state.svelte.js';
	import { window as winStore } from '#stores';
	import { onMount } from 'svelte';
	import { cubicOut } from 'svelte/easing';
	import { slide } from 'svelte/transition';

	let { children } = $props();

	onMount(initDevTools);
	let count = $state(0);
	let sideOpen = $state(true);

	// Traffic-light gutter — measured live from window.controlsArea rather
	// than a magic number: the toggle lands right after the close/min/zoom
	// cluster + a 10px gap, on whatever titlebar style the window runs.
	// 84px fallback covers the first frame before the store's first pull.
	const controlsGutter = $derived(
		winStore.controlsArea?.side === 'left'
			? Math.max(12, winStore.controlsArea.x + winStore.controlsArea.width + 10)
			: 84,
	);

	// Header = cluster height + the cluster's distance-from-top as padding-y
	// on both sides (h + 2·y ≈ 14+18 = 32px) — so its center line is exactly
	// the traffic-light axis. controlsArea is window-frame space; contentTop
	// (drawable inset, 0 on this fullsize window) converts to content space.
	const titlebarHeight = $derived(
		winStore.controlsArea
			? Math.max(
					28,
					winStore.controlsArea.height +
						Math.max(
							0,
							winStore.controlsArea.y - (winStore.controlsArea.contentTop ?? 0),
						) * 2,
				)
			: 38,
	);

	// svelte's `slide` is vertical-only — a sidebar wants the width axis.
	// Same in:/out: contract: css(t) → keyframes → native setStyle frames.
	function collapseX(node: Element, { duration = 180 } = {}) {
		const w = parseFloat(getComputedStyle(node).width) || 200;
		return {
			duration,
			easing: cubicOut,
			css: (t: number) =>
				`overflow: hidden; width: ${t * w}px; border-right-width: ${t}px; opacity: ${t}`,
		};
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>
<div class="shell">
	<header
		class="titlebar"
		data-window-drag
		style="padding-left: {controlsGutter}px; height: {titlebarHeight}px"
	>
		<button class="btn" onclick={() => (sideOpen = !sideOpen)}>
			{sideOpen ? '‹ sidebar' : '› sidebar'}
		</button>
		<div class="titlebar-title">svelte·desktop</div>
		<button class="btn" onclick={() => count++}>
					count: {count}
				</button>
	</header>
	<div class="body">
		{#if sideOpen}
			<aside
				class="sidebar"
				style="width: 200px"
				in:slide={{ duration: 200, axis: 'x' }}
				out:slide={{ duration: 200, axis: 'x' }}
			>
				<div class="sidebar-in">
					<div class="brand">
						<div class="brand-mark">S</div>
						<div class="brand-text">
							<div class="brand-name">svelte·desktop</div>
							<div class="brand-sub">GPUI + Svelte native build</div>
						</div>
					</div>
					<nav class="nav">
						<a class="nav-item" class:sel={page.url.pathname === '/'} href={resolve('/')}>
							Notes
						</a>
						<a
							class="nav-item"
							class:sel={page.url.pathname === '/animations'}
							href={resolve('/animations')}
						>
							Motion
						</a>
						<a
							class="nav-item"
							class:sel={page.url.pathname === '/about'}
							href={resolve('/about')}
						>
							About yo
						</a>
					</nav>

					<div class="sidebar-foot">
						<div class="foot-dot"></div>
						<div class="foot-label">gpui · no webview</div>
					</div>
				</div>
			</aside>
		{/if}

		<main class="content">
			<div class="page-body">
				{@render children()}
			</div>
			<DevTools />
		</main>
	</div>
</div>

<style>
	.shell {
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		background-color: #1e1e23;
		color: #f2f2f7;
	}
	.titlebar {
		display: flex;
		flex-direction: row;
		align-items: center;
		/* height + padding-left are bound to window.controlsArea — the
		   measured traffic-light cluster, not constants */
		background-color: #26262d;
		border-bottom-width: 1px;
		border-color: #34343c;
		user-select: none;
	}
	.titlebar-title {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		font-weight: 600;
		color: #8e8e96;
	}
	.body {
		flex: 1;
		display: flex;
		flex-direction: row;
		min-height: 0;
	}
	.sidebar {
		display: flex;
		flex-direction: column;
		background-color: #26262d;
		border-right-width: 1px;
		border-color: #34343c;
	}
	.sidebar-in {
		flex: 1;
		width: 200px;
		display: flex;
		flex-direction: column;
		padding: 20px 14px;
	}
	.brand {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 10px;
		padding: 4px 6px 18px 6px;
	}
	.brand-mark {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		border-radius: 8px;
		background-color: #0a84ff;
		color: #ffffff;
		font-size: 15px;
		font-weight: 700;
	}
	.brand-name {
		font-size: 13px;
		font-weight: 600;
	}
	.brand-sub {
		font-size: 10px;
		color: #8e8e96;
	}
	.nav {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex-grow: 1;
	}
	.nav-item {
		display: flex;
		padding: 7px 10px;
		border-radius: 7px;
		font-size: 13px;
		color: #d8d8de;
		cursor: pointer;
		user-select: none;
	}
	.nav-item:hover {
		background-color: #33333b;
	}
	.nav-item.sel {
		background-color: #0a84ff;
		color: #ffffff;
	}
	.sidebar-foot {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 8px;
		padding: 8px 6px 0 6px;
	}
	.foot-dot {
		width: 7px;
		height: 7px;
		border-radius: 4px;
		background-color: #30d158;
	}
	.foot-label {
		font-size: 10px;
		line-height: 13px;
		color: #6e6e76;
	}
	.content {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	.page-body {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
		overflow: hidden;
	}
</style>
