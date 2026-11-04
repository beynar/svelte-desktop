<script lang="ts">
	import '../app.css';
	import { page as pageState } from '$app/state';
	import { Theme } from 'entasis/theme';
	import { AppShell, type AppShellSidebarProps } from 'entasis/app-shell';
	import type { SidebarDisplayState, SidebarGroup } from 'entasis/sidebar';
	import { squaresFourIcon } from 'entasis/icons/squaresFour';
	import { kanbanIcon } from 'entasis/icons/kanban';
	import { calendarIcon } from 'entasis/icons/calendar';
	import { sidebarIcon } from 'entasis/icons/sidebar';
	import { globeIcon } from 'entasis/icons/globe';
	import { clockIcon } from 'entasis/icons/clock';
	import { appWindowIcon } from 'entasis/icons/appWindow';
	import { textboxIcon } from 'entasis/icons/textbox';
	import { bellRingingIcon } from 'entasis/icons/bellRinging';
	import { fingerprintIcon } from 'entasis/icons/fingerprint';
	import { cpuIcon } from 'entasis/icons/cpu';
	import { WindowTabs, type TabGroup, type TabLike } from '@svelte-desktop/shell/tabs';
	import { board, upcoming } from '#lib/data.svelte';
	import ThemeToggle from '#lib/ThemeToggle.svelte';

	let { children } = $props();

	const pages = {
		'/': { title: 'Overview', subtitle: 'What needs your attention today' },
		'/board': { title: 'Board', subtitle: 'Drag tasks between columns' },
		'/calendar': { title: 'Calendar', subtitle: 'Your week at a glance' },
		'/activity': { title: 'Activity', subtitle: 'Keeps running in its own tab' },
		'/dialogs': { title: 'Dialogs', subtitle: 'The system’s dialogs and your routes in a sheet' },
		'/form': { title: 'Form', subtitle: 'Every input, files included' },
		'/dock': { title: 'Dock', subtitle: 'Bounce, badge, icon, progress, menu' },
		'/native': { title: 'Native', subtitle: 'What Electron and Tauri apps reach for' },
		'/modules': { title: 'Modules', subtitle: 'Your own Python, Rust and Swift, one API' }
	} as const;
	const pageOf = (path: string) => pages[path as keyof typeof pages] ?? pages['/'];
	const current = $derived(pageOf(pageState.url.pathname));
	const icons = { '/': squaresFourIcon, '/board': kanbanIcon, '/calendar': calendarIcon, '/activity': clockIcon, '/dialogs': appWindowIcon, '/form': textboxIcon, '/dock': bellRingingIcon, '/native': fingerprintIcon, '/modules': cpuIcon };

	// The window's tabs, for the header (the active tab's title) and the tests (dev).
	let tabs = $state<TabGroup<TabLike>>();
	$effect(() => {
		if (import.meta.env.DEV) (globalThis as { __tabs?: unknown }).__tabs = tabs;
	});

	let displayState = $state<SidebarDisplayState>('expanded');
	const openTasks = $derived(board.columns.filter((c) => c.id !== 'done').reduce((n, c) => n + c.cards.length, 0));

	const items: SidebarGroup[] = $derived([
		{
			label: 'Workspace',
			items: [
				{ label: 'Overview', href: '/', icon: squaresFourIcon, isActive: pageState.url.pathname === '/' },
				{ label: 'Board', href: '/board', icon: kanbanIcon, badge: openTasks, isActive: pageState.url.pathname === '/board' },
				{ label: 'Calendar', href: '/calendar', icon: calendarIcon, badge: upcoming().length, isActive: pageState.url.pathname === '/calendar' },
				{ label: 'Activity', href: '/activity', icon: clockIcon, isActive: pageState.url.pathname === '/activity' },
				{ label: 'Dialogs', href: '/dialogs', icon: appWindowIcon, isActive: pageState.url.pathname === '/dialogs' },
				{ label: 'Form', href: '/form', icon: textboxIcon, isActive: pageState.url.pathname === '/form' },
				{ label: 'Dock', href: '/dock', icon: bellRingingIcon, isActive: pageState.url.pathname === '/dock' },
				{ label: 'Native', href: '/native', icon: fingerprintIcon, isActive: pageState.url.pathname === '/native' },
				{ label: 'Modules', href: '/modules', icon: cpuIcon, isActive: pageState.url.pathname === '/modules' }
			]
		}
	]);

	const sidebar = $derived<AppShellSidebarProps>({
		displayState,
		onDisplayStateChange: (next) => (displayState = next),
		collapsible: 'icon',
		items,
		headerButton: { icon: squaresFourIcon, title: 'Acme', subtitle: 'Operations' }
	});
</script>

<Theme>
	<!-- The window's tabs, in the title bar: each one is a place in the app — links and the sidebar move
	     the active tab, ⌘-click opens one in the background, ⌘T a new one; /activity keeps running in
	     its own tab; restored at the next launch; a tab dragged out opens in its own window, which rises
	     into place. `prewarm` and `maxViews` stay off here (tests/tabs-views.test.ts turns them on). -->
	<WindowTabs
		page={children}
		newTab="/"
		keepAlive={['/activity']}
		windowAnimation={{ duration: 220, easing: [0.2, 0.9, 0.1, 1], offset: { y: 16 }, scale: 0.97 }}
		prewarm={import.meta.env.VITE_TABS_PREWARM === '1'}
		maxViews={Number(import.meta.env.VITE_TABS_MAX_VIEWS) || undefined}
		bind:api={tabs}
	>
		{#snippet tab({ tab, active, close })}
			{@const icon = tab.url ? globeIcon : (icons[new URL(tab.path ?? '/', 'http://x').pathname as keyof typeof icons] ?? squaresFourIcon)}
			{@render icon({ class: `size-3.5 shrink-0 ${active ? 'text-primary' : 'text-neutral-readable'}` })}
			<span class="min-w-0 flex-1 truncate">{tab.title || tab.path}</span>
			<button type="button" aria-label={`Close ${tab.title}`} class="tab-close state-layer grid size-4 shrink-0 place-items-center rounded text-xs" onclick={close}
				>✕</button
			>
		{/snippet}

		{#snippet layout({ bar, content, api })}
			<!-- Another site's tab titles the header itself (a kept-alive page is the window's address). -->
			{@const site = api.active?.url ? api.active : undefined}
			<div class="app flex h-full flex-col">
				<header class="titlebar bg-surface-canvas flex shrink-0 items-end gap-2">
					{@render bar({ label: 'Open pages', class: 'app-tabs min-w-0 flex-1 gap-1' })}
					<ThemeToggle />
				</header>
				<div class="min-h-0 flex-1">
					<AppShell
						variant="inset"
						{sidebar}
						title={site ? api.titleOf(site) : current.title}
						subtitle={site?.url ? new URL(site.url).host : current.subtitle}
						contentWidth="full"
					>
						{#snippet headerActions({ sidebar })}
							<!-- Another site, in its own tab (its own web view), next to the app's tabs. -->
							<button
								type="button"
								class="state-layer border-neutral-muted text-neutral inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm"
								onclick={() => api.open({ id: 'docs', url: 'https://svelte.dev/docs/svelte/overview', title: 'Svelte docs' })}
							>
								{@render globeIcon({ class: 'size-4' })} Docs
							</button>
							<button
								type="button"
								class="state-layer border-neutral-muted text-neutral inline-flex size-8 items-center justify-center rounded-md border"
								aria-label="Toggle sidebar"
								onclick={sidebar.toggle}
							>
								{@render sidebarIcon({ class: 'size-4' })}
							</button>
						{/snippet}
						{@render content({ class: 'h-full' })}
					</AppShell>
				</div>
			</div>
		{/snippet}

		{#snippet embedded({ page })}
			<div class="h-full overflow-auto p-6">{@render page()}</div>
		{/snippet}
	</WindowTabs>
</Theme>
