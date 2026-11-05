<!-- Everything the Dock icon does, one card each: bounce, badge, icon, progress, its menu and the
     icon itself hidden. The Dock is outside the window: watch it while you click. -->
<script lang="ts">
	import { inPane } from '#lib/window-page';
	import { goto } from '$app/navigation';
	import { Button } from 'entasis/button';
	import { TextInput } from 'entasis/text-input';

	// What happened, newest first.
	let log = $state<string[]>([]);
	const note = (line: string) => log.unshift(`${new Date().toLocaleTimeString()}  ${line}`);
	const run = (what: string, action: () => Promise<unknown>) =>
		action().then(
			() => note(what),
			(e) => note(`${what} — ✗ ${(e as Error).message}`)
		);

	// Attention: the Dock only bounces an app that isn't frontmost — a few seconds to switch.
	let countdown = $state(0);
	function bounceSoon(type: 'informational' | 'critical') {
		countdown = 3;
		const timer = setInterval(() => {
			if (--countdown > 0) return;
			clearInterval(timer);
			void run(`bounce (${type})`, () => host.app.bounceDock(type));
		}, 1000);
	}

	// Badge.
	let badge = $state('');
	let count = 0;

	// Icon.
	const symbols = ['star.fill', 'bolt.fill', 'heart.fill', 'flame.fill', 'leaf.fill', 'moon.stars.fill'];
	async function pickIcon() {
		const { canceled, paths } = await host.dialog.showOpenDialog({ files: true, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'icns', 'tiff', 'gif'] }] });
		if (!canceled && paths[0]) await run(`icon: ${paths[0].split('/').pop()}`, () => host.app.setDockIcon(paths[0]!));
	}

	// Progress.
	let downloading = $state(false);
	async function download() {
		downloading = true;
		for (let done = 0; done <= 100; done += 4) {
			await host.app.setDockProgress({ status: 'normal', completed: done, total: 100 });
			await new Promise((r) => setTimeout(r, 120));
		}
		await host.app.setDockProgress({ status: 'none' });
		downloading = false;
		note('download simulated');
	}

	// The Dock icon's menu (right-click it).
	let menuSet = $state(false);
	let bounceOnBoard = $state(true);
	const dockMenu = () => [
		{ id: 'dock:new-board', label: 'New Board' },
		{ id: 'dock:activity', label: 'Open Activity' },
		{ type: 'separator' as const },
		{ label: 'Badge', type: 'submenu' as const, submenu: [
			{ id: 'dock:badge-1', label: '1' },
			{ id: 'dock:badge-9', label: '9' },
			{ id: 'dock:badge-new', label: 'New' },
			{ id: 'dock:badge-clear', label: 'Clear' }
		] },
		{ id: 'dock:bounce-on-board', label: 'Bounce on New Board', checked: bounceOnBoard }
	];
	// In a pane, its page may not be the one on screen: the window's page takes the active tab there.
	const open = (path: string) => void (inPane() ? host.broadcast('dashboard:open', path) : goto(path));
	$effect(() =>
		host.menu.onAction(({ id }) => {
			if (!id.startsWith('dock:')) return;
			note(`Dock menu: ${id.slice(5)}`);
			if (id === 'dock:new-board') {
				open('/board');
				if (bounceOnBoard) void host.app.bounceDock('informational');
			} else if (id === 'dock:activity') open('/activity');
			else if (id.startsWith('dock:badge-')) void host.app.setDockBadge(id === 'dock:badge-clear' ? null : id === 'dock:badge-new' ? 'New' : id.slice(11));
			else if (id === 'dock:bounce-on-board') {
				bounceOnBoard = !bounceOnBoard;
				void host.menu.setDockMenu(dockMenu());
			}
		})
	);

	// Hidden from the Dock (an accessory app), then back.
	let hidden = $state(0);
	function hideForAWhile() {
		void run('hidden from the Dock', () => host.app.setActivationPolicy('accessory'));
		hidden = 5;
		const timer = setInterval(() => {
			if (--hidden > 0) return;
			clearInterval(timer);
			void run('back in the Dock', async () => {
				await host.app.setActivationPolicy('regular');
				await host.window.focus();
			});
		}, 1000);
	}

	// Leave the Dock as it was.
	$effect(() => () => {
		void host.app.setDockProgress({ status: 'none' }).catch(() => {});
	});
</script>

<svelte:head><title>Dock</title></svelte:head>

<div class="grid max-w-5xl gap-4 p-6 md:grid-cols-2">
	<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
		<h2 class="text-neutral text-base font-semibold">Attention</h2>
		<p class="text-neutral-readable text-sm">The Dock bounces an app that isn't in front: click, then switch to another app within 3 seconds.</p>
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" onclick={() => bounceSoon('informational')}>Bounce once</Button>
			<Button variant="outline" onclick={() => bounceSoon('critical')}>Bounce until I come back</Button>
			<Button variant="outline" onclick={() => run('window attention', () => host.window.requestAttention())}>Window attention</Button>
		</div>
		{#if countdown}<p class="text-primary text-sm font-medium">Switch apps… {countdown}</p>{/if}
	</section>

	<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
		<h2 class="text-neutral text-base font-semibold">Badge</h2>
		<p class="text-neutral-readable text-sm">Any short text on the icon — a count, a dot, a word.</p>
		<div class="flex items-end gap-2">
			<div class="flex-1"><TextInput label="Text" placeholder="3, •, New…" bind:value={badge} /></div>
			<Button onclick={() => run(`badge “${badge}”`, () => host.app.setDockBadge(badge || null))}>Set</Button>
		</div>
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" onclick={() => run(`badge ${++count}`, () => host.notifications.setBadge(count))}>+1</Button>
			<Button variant="outline" onclick={() => run('badge •', () => host.app.setDockBadge('•'))}>Dot</Button>
			<Button variant="outline" onclick={() => ((count = 0), run('badge cleared', () => host.app.setDockBadge(null)))}>Clear</Button>
		</div>
	</section>

	<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
		<h2 class="text-neutral text-base font-semibold">Icon</h2>
		<p class="text-neutral-readable text-sm">Changed on the fly: an SF Symbol, a native icon, any image file.</p>
		<div class="flex flex-wrap gap-2">
			{#each symbols as symbol (symbol)}
				<Button variant="outline" size="small" onclick={() => run(`icon: ${symbol}`, () => host.app.setDockIcon({ native: symbol } as never))}>{symbol}</Button>
			{/each}
			<Button variant="outline" size="small" onclick={() => run('icon: computer', () => host.app.setDockIcon({ native: 'computer' }))}>computer</Button>
		</div>
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" onclick={pickIcon}>Choose an image…</Button>
			<Button variant="outline" onclick={() => run('icon restored', () => host.app.setDockIcon(null))}>Restore</Button>
		</div>
	</section>

	<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
		<h2 class="text-neutral text-base font-semibold">Progress</h2>
		<p class="text-neutral-readable text-sm">A bar across the icon, like a download in Safari.</p>
		<div class="flex flex-wrap gap-2">
			<Button onclick={download} disabled={downloading}>{downloading ? 'Downloading…' : 'Simulate a download'}</Button>
			<Button variant="outline" onclick={() => run('progress: indeterminate', () => host.app.setDockProgress({ status: 'indeterminate' }))}>Indeterminate</Button>
			<Button variant="outline" onclick={() => run('progress: paused at 60%', () => host.app.setDockProgress({ status: 'paused', completed: 60, total: 100 }))}>Paused</Button>
			<Button variant="outline" onclick={() => run('progress: error at 30%', () => host.app.setDockProgress({ status: 'error', completed: 30, total: 100 }))}>Error</Button>
			<Button variant="outline" onclick={() => run('progress cleared', () => host.app.setDockProgress({ status: 'none' }))}>Clear</Button>
		</div>
	</section>

	<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
		<h2 class="text-neutral text-base font-semibold">Menu</h2>
		<p class="text-neutral-readable text-sm">Your items on top of the Dock icon's menu (right-click it): New Board, Open Activity, a Badge submenu, a checkable item.</p>
		<div class="flex flex-wrap gap-2">
			<Button onclick={() => run('Dock menu set', async () => (await host.menu.setDockMenu(dockMenu()), (menuSet = true)))}>{menuSet ? 'Update the menu' : 'Add the menu'}</Button>
			<Button variant="outline" onclick={() => run('Dock menu removed', async () => (await host.menu.setDockMenu([]), (menuSet = false)))}>Remove</Button>
		</div>
	</section>

	<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
		<h2 class="text-neutral text-base font-semibold">In the Dock or not</h2>
		<p class="text-neutral-readable text-sm">A menu-bar app has no Dock icon (activation policy “accessory”): gone for 5 seconds, then back.</p>
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" onclick={hideForAWhile} disabled={hidden > 0}>{hidden ? `Back in ${hidden}…` : 'Hide the Dock icon for 5 s'}</Button>
		</div>
	</section>

	<section class="flex flex-col gap-2 md:col-span-2">
		<h2 class="text-neutral text-base font-semibold">What happened</h2>
		{#if log.length}
			<pre class="bg-surface-raised border-neutral-muted text-neutral-readable max-h-60 overflow-auto rounded-lg border p-3 text-xs">{log.join('\n')}</pre>
		{:else}
			<p class="text-neutral-readable text-sm">Nothing yet.</p>
		{/if}
	</section>
</div>
