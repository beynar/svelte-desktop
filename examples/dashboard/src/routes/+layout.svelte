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
	import { WindowTabs, type TabGroup, type TabLike } from '@kitop/shell/tabs';
	import { board, upcoming } from '#lib/data.svelte';
	import ThemeToggle from '#lib/ThemeToggle.svelte';
	import { backdropTabs, followBackdrop } from '#lib/backdrop';
	import { inPane } from '#lib/window-page';
	import { goto } from '$app/navigation';

	let { children } = $props();
	const split = import.meta.env.VITE_TABS_SPLIT !== '0';

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
		(globalThis as { __tabs?: unknown }).__tabs = tabs; // the tests read it (a built app too: tests/split.test.ts)
	});

	// The Native page asks for the window's material from its pane.
	$effect(() => (inPane() ? undefined : followBackdrop()));
	$effect(() => {
		const group = tabs;
		if (group && !inPane()) backdropTabs(group.items.map((t) => `${group.id}-${t.id}`));
	});
	// The Dock page's menu, from a pane that may not be on screen and any window: the active tab of the
	// window in front (or the first) goes there, once.
	let opened = { path: '', at: 0 };
	$effect(() =>
		inPane()
			? undefined
			: host.onBroadcast<string>('dashboard:open', async (path) => {
					if (path === opened.path && Date.now() - opened.at < 300) return;
					opened = { path, at: Date.now() };
					const [all, me] = await Promise.all([host.windows.list(), host.window.getInfo()]);
					const first = all.find((w) => w.focused) ?? all[0];
					if (!first || first.windowId === me.windowId) void goto(path);
				}),
	);

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
	<!-- The window's tabs, in panes: drag a tab to a side of a pane to split it, or use ⌘\ and ⇧⌘\. Each
	     tab is a place in the app, in its own web view — links and the sidebar move the active tab of the
	     pane in focus, ⌘-click opens one in the background, ⌘T a new one; /activity is one tab, wherever it
	     is; restored at the next launch; a tab dragged out opens in its own window, which rises into place.
	     `prewarm` and `maxViews` stay off here (tests/tabs-views.test.ts turns them on).
	     VITE_TABS_SPLIT=0: the tabs in the title bar instead, one page at a time (`bun run build:test`). -->
	<WindowTabs
		page={children}
		newTab="/"
		{split}
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
			<!-- For the pointer: a control inside a tab can't be reached by a screen reader. Delete closes the tab. -->
			<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
			<span data-sd-tab-close aria-hidden="true" class="tab-close state-layer grid size-4 shrink-0 place-items-center rounded text-xs" onclick={close}>✕</span>
		{/snippet}

		{#snippet layout({ bar, content, api })}
			<!-- Another site's tab titles the header itself (a kept-alive page is the window's address). -->
			{@const site = api.active?.url ? api.active : undefined}
			{#if split}
				<!-- The panes' bars are the top of the window, as the sidebar's header is: no title bar of its own.
				     What was in the header goes at the end of the top right pane's bar; each page has its title. -->
				<div class="app app-split h-full" data-sidebar-state={displayState}>
					<!-- No rounded card around the panes: the pages' web views are square, they'd cover its corners. -->
					<AppShell variant="admin" {sidebar} contentWidth="full">
						{#snippet children({ sidebar: shell })}
							{#snippet actions()}
								<span class="pane-actions">
									<button type="button" class="pane-action state-layer" aria-label="Svelte docs" onclick={() => api.open({ id: 'docs', url: 'https://svelte.dev/docs/svelte/overview', title: 'Svelte docs' })}>
										{@render globeIcon({ class: 'size-4' })}
									</button>
									<button type="button" class="pane-action state-layer" aria-label="Toggle sidebar" onclick={shell.toggle}>
										{@render sidebarIcon({ class: 'size-4' })}
									</button>
									<ThemeToggle />
								</span>
							{/snippet}
							{@render content({ class: 'min-h-0 flex-1', bar: { label: 'Open pages', class: 'app-tabs pane-bar', end: actions } })}
						{/snippet}
					</AppShell>
				</div>
			{:else}
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
			{/if}
		{/snippet}

		{#snippet embedded({ page })}
			<div class="bg-surface-canvas min-h-dvh p-6">
				{#if split && !pageState.url.pathname.startsWith('/sheets')}
					<header class="mb-5">
						<h1 class="text-neutral text-base font-semibold">{current.title}</h1>
						<p class="text-neutral-readable text-sm">{current.subtitle}</p>
					</header>
				{/if}
				{@render page()}
			</div>
		{/snippet}
	</WindowTabs>
</Theme>
