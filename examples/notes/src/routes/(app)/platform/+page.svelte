<script lang="ts">
	// The GPUI-era reactive platform API, unchanged, running in the WebView:
	// every call goes page → window.__shell → libshell (no Bun hop).
	import {
		app, window as win, screen, clipboard, theme, system, power, tray, shortcuts,
		notifications, secureStorage, capabilities, diagnostics, menu, onPlatform, isNative
	} from '@svelte-desktop/shell/stores';
	import MenuBar from '@svelte-desktop/shell/platform/MenuBar.svelte';
	import Popover from '@svelte-desktop/shell/platform/Popover.svelte';
	let paletteOpen = $state(false);
	import { greeter } from '#lib/native.ts';
	import { nativeGreeting, fib } from '#lib/desktop.remote';
	const fromPage = greeter.hello({ name: 'page' }).catch((e) => `error: ${e.message}`);

	let log = $state<string[]>([]);
	const note = (s: string) => (log = [`${new Date().toLocaleTimeString()} ${s}`, ...log].slice(0, 10));
	const run = (label: string, fn: () => Promise<unknown>) => async () => {
		try {
			const r = await fn();
			note(`${label} → ${JSON.stringify(r ?? 'ok')}`);
		} catch (e) {
			note(`${label} ✗ ${(e as Error).message}`);
		}
	};
	let secret = $state('');
	let trayClicks = $state(0);
	let hotkeyPresses = $state(0);
	$effect(() => onPlatform('trayClick', () => trayClicks++));
	$effect(() => onPlatform('shortcutPressed', () => hotkeyPresses++));

	const implemented = $derived(
		Object.values(capabilities.report?.services ?? {}).flatMap((ops) => Object.values(ops)).filter((s) => s === 'implemented').length
	);
</script>

<MenuBar label="Platform" items={[{ label: 'Say hi', onClick: () => note('menu: hi from MenuBar component') }]} />

<!-- Spotlight-style panel, toggled by a global hotkey even when Notes is in the background. -->
<Popover route="/palette" style="panel" position="center" shortcut="Ctrl+Alt+Space" width={520} height={260} bind:open={paletteOpen} />

<h1>Platform API</h1>
{#if !isNative()}
	<p>Not running inside the desktop shell.</p>
{:else}
	<div class="grid">
		<section class="card" data-testid="identity">
			<h2>App</h2>
			<p>{app.name} {app.version} · {app.platform} · {app.packaged ? 'bundled .app' : 'bare binary'}</p>
			<p>pid {diagnostics.pid} · {implemented} native ops implemented</p>
			<button onclick={run('dock badge', () => app.setDockBadge(String(Math.floor(Math.random() * 9) + 1)))}>Dock badge</button>
			<button onclick={run('dock progress', () => app.setDockProgress({ status: 'normal', completed: 6, total: 10 }))}>Dock progress</button>
			<button onclick={run('clear dock', async () => { await app.setDockBadge(null); await app.setDockProgress({ status: 'none' }); })}>Clear</button>
			<button onclick={run('about', () => app.aboutPanel({ credits: 'Built with svelte-desktop' }))}>About…</button>
		</section>

		<section class="card" data-testid="window">
			<h2>Window</h2>
			<p>
				{win.size?.width}×{win.size?.height} at {win.position?.x},{win.position?.y} · {win.state} ·
				{win.focused ? 'focused' : 'blurred'} · @{win.scaleFactor}x
			</p>
			<button onclick={run('maximize', () => win.toggleMaximize())}>Toggle maximize</button>
			<button onclick={run('center', () => win.center())}>Center</button>
			<button onclick={run('always on top', () => win.setAlwaysOnTop(true))}>On top</button>
			<button onclick={run('normal level', () => win.setAlwaysOnTop(false))}>Normal</button>
			<button onclick={run('titlebar', () => win.setTitleBarStyle('hiddenInset'))}>Inset titlebar</button>
			<button onclick={run('titlebar', () => win.setTitleBarStyle('default'))}>Default titlebar</button>
			<button onclick={run('new window', () => import('@svelte-desktop/shell/platform').then((p) => p.windows.create({ title: 'Second', width: 520, height: 420 })))}>New window</button>
		</section>

		<section class="card" data-testid="theme">
			<h2>Theme</h2>
			<p>{theme.name} ({theme.dark ? 'dark' : 'light'}) · accent {system.accentColor ? `rgb(${system.accentColor.r},${system.accentColor.g},${system.accentColor.b})` : '?'}</p>
			<button onclick={run('dark', () => theme.set('dark'))}>Dark</button>
			<button onclick={run('light', () => theme.set('light'))}>Light</button>
			<button onclick={run('system', () => theme.set('system'))}>System</button>
		</section>

		<section class="card" data-testid="native">
			<h2>Native plugin (Swift)</h2>
			{#await fromPage then text}<p data-testid="native-page">{text}</p>{/await}
			<svelte:boundary><p data-testid="native-server">{await nativeGreeting()}</p></svelte:boundary>
			<svelte:boundary>{@const f = await fib(30)}<p data-testid="addon">fib(30) = {f.value} in C addon ({f.ms} ms)</p></svelte:boundary>
			<button onclick={run('add', () => greeter.add({ a: 2, b: 40 }))}>2 + 40 in Swift</button>
			<button onclick={run('title', () => greeter.windowTitle())}>Window title via AppKit</button>
		</section>

		<section class="card">
			<h2>System</h2>
			<p>{system.os} · {system.arch} · keyboard {system.layout?.name ?? system.layout}</p>
			<p>{screen.displayCount} display(s) · primary {screen.primary?.bounds.width}×{screen.primary?.bounds.height}</p>
			<p>thermal {power.thermal} · battery {power.battery?.percent ?? '—'}{power.battery?.charging ? ' ⚡' : ''} · wakes {power.wakeCount}</p>
		</section>

		<section class="card">
			<h2>Clipboard</h2>
			<button onclick={run('copy', () => clipboard.writeText(`copied at ${new Date().toISOString()}`))}>Copy text</button>
			<button onclick={run('paste', async () => (await clipboard.refresh()).text)}>Read text</button>
		</section>

		<section class="card">
			<h2>Tray, popovers & shortcuts</h2>
			<p>The menu-bar note icon opens the /quick route in a popover.</p>
			<p>tray clicks {trayClicks} · hotkey presses {hotkeyPresses} · menu action {menu.lastAction ?? '—'}</p>
			<button onclick={() => (paletteOpen = true)}>Command palette (⌃⌥Space)</button>
			<button onclick={run('hotkey ⌥⌘J', () => shortcuts.register({ accelerator: 'Alt+CmdOrCtrl+J', id: 'demo' }))}>Register ⌥⌘J</button>
		</section>

		<section class="card">
			<h2>Keychain & notifications</h2>
			<input bind:value={secret} placeholder="secret" />
			<button onclick={run('keychain save', () => secureStorage.setPassword('notes-demo', 'me', secret))}>Save</button>
			<button onclick={run('keychain read', () => secureStorage.getPassword('notes-demo', 'me').then((v) => (v ? `${String(v).length} chars` : null)))}>Read</button>
			<button onclick={run('notify', () => notifications.show({ title: 'Notes', body: 'Hello from the desktop shell', tag: 'demo' }))}>Notify</button>
		</section>
	</div>

	<h3>Log</h3>
	<ul class="log">{#each log as line, i (i)}<li><code>{line}</code></li>{/each}</ul>
{/if}

<style>
	.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)); gap: 0.75rem; }
	.card h2 { margin: 0 0 0.5rem; font-size: 1rem; }
	.card p { margin: 0.25rem 0; font-size: 0.85rem; }
	button { margin: 0.15rem 0.1rem; }
	.log { font-size: 0.75rem; opacity: 0.8; }
	:global(html.dark) { color-scheme: dark; }
</style>
