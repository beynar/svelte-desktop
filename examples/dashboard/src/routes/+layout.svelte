<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import { Theme } from 'entasis/theme';
	import { AppShell, type AppShellSidebarProps } from 'entasis/app-shell';
	import type { SidebarDisplayState, SidebarGroup } from 'entasis/sidebar';
	import { squaresFourIcon } from 'entasis/icons/squaresFour';
	import { kanbanIcon } from 'entasis/icons/kanban';
	import { calendarIcon } from 'entasis/icons/calendar';
	import { sidebarIcon } from 'entasis/icons/sidebar';
	import { board, upcoming } from '#lib/data.svelte';

	let { children } = $props();

	const pages = {
		'/': { title: 'Overview', subtitle: 'What needs your attention today' },
		'/board': { title: 'Board', subtitle: 'Drag tasks between columns' },
		'/calendar': { title: 'Calendar', subtitle: 'Your week at a glance' }
	} as const;
	const current = $derived(pages[page.url.pathname as keyof typeof pages] ?? pages['/']);

	let displayState = $state<SidebarDisplayState>('expanded');
	const openTasks = $derived(board.columns.filter((c) => c.id !== 'done').reduce((n, c) => n + c.cards.length, 0));

	const items: SidebarGroup[] = $derived([
		{
			label: 'Workspace',
			items: [
				{ label: 'Overview', href: '/', icon: squaresFourIcon, isActive: page.url.pathname === '/' },
				{ label: 'Board', href: '/board', icon: kanbanIcon, badge: openTasks, isActive: page.url.pathname === '/board' },
				{ label: 'Calendar', href: '/calendar', icon: calendarIcon, badge: upcoming().length, isActive: page.url.pathname === '/calendar' }
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
<div class="app h-full">
	<AppShell variant="inset" {sidebar} title={current.title} subtitle={current.subtitle} contentWidth="full">
		{#snippet headerActions({ sidebar })}
			<button
				type="button"
				class="state-layer border-neutral-muted text-neutral inline-flex size-8 items-center justify-center rounded-md border"
				aria-label="Toggle sidebar"
				onclick={sidebar.toggle}
			>
				{@render sidebarIcon({ class: 'size-4' })}
			</button>
		{/snippet}
		{@render children()}
	</AppShell>
</div>
</Theme>
