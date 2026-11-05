<!-- What Electron and Tauri apps reach for, one card each: the window's vibrancy, its traffic lights
     and aspect ratio, the share menu, a file dragged out to the Finder, Quick Look, Touch ID, sound
     and media, running at full speed out of sight, power events, clearing what sites stored, an OAuth
     sign-in in the system browser and a WebSocket on the app's own server. -->
<script lang="ts">
	import { setBackdrop } from '#lib/backdrop';
	import { onDestroy, onMount } from 'svelte';
	import NativeProcesses from './NativeProcesses.svelte';
	import { Button } from 'entasis/button';
	import { Slider } from 'entasis/slider';
	import NativeAppWindows from '#lib/NativeAppWindows.svelte';
	import NativeSessions from '#lib/NativeSessions.svelte';
	import NativeFilesPrint from '#lib/NativeFilesPrint.svelte';
	import NativeWebSecurity from '#lib/NativeWebSecurity.svelte';
	import NativeWebContent from '#lib/NativeWebContent.svelte';
	import NativeInputMenus from '#lib/NativeInputMenus.svelte';

	let { data } = $props();

	// What happened, newest first.
	let log = $state<string[]>([]);
	const note = (line: string) => log.unshift(`${new Date().toLocaleTimeString()}  ${line}`);
	const run = <T,>(what: string, action: () => Promise<T>, said: (r: T) => string = () => '') =>
		action().then(
			(r) => note(`${what}${said(r) ? ` — ${said(r)}` : ''}`),
			(e) => note(`${what} — ✗ ${(e as Error).message}`)
		);

	// Vibrancy (a system material) or Liquid Glass (macOS 26), declared in CSS: the title bar and the
	// sidebar take `--desktop-material: var(--backdrop)` (the style block at the end), and the shell
	// draws the material behind them. Here, only CSS variables change. The material is light or dark
	// with the window's appearance: the title bar's theme toggle (#lib/ThemeToggle.svelte) keeps it
	// on the page's theme.
	// A material is the system's recipe for one place in its own UI: how much it blurs, its tint,
	// how see-through it is. The name says where macOS uses it.
	const materials: Record<string, { label: string; about: string }> = {
		sidebar: { label: 'Sidebar', about: 'Like Finder’s sidebar: light, quite see-through.' },
		window: { label: 'Window', about: 'A plain window’s background: almost opaque, a hint of what’s behind.' },
		underWindow: { label: 'Under window', about: 'What sits under windows: the most see-through.' },
		hud: { label: 'HUD', about: 'The volume / brightness overlay: dark, whatever the theme.' },
		menu: { label: 'Menu', about: 'A menu’s background.' },
		popover: { label: 'Popover', about: 'A popover’s background, like the Wi-Fi menu.' },
		glass: { label: 'Regular', about: 'Liquid Glass, regular: frosted, readable over anything (macOS 26).' },
		'glass-clear': { label: 'Clear', about: 'Liquid Glass, clear: the most transparent (macOS 26).' }
	};
	const vibrancies = ['sidebar', 'window', 'underWindow', 'hud', 'menu', 'popover'];
	let backdrop = $state<string | null>(null);
	const isGlass = $derived(backdrop?.startsWith('glass') ?? false);
	// Intensity: how much of the material shows — the rest is the page's own background over it.
	let intensity = $state(100);
	// The glass's tint: a color, and how strong it is.
	let tint = $state('#5f62ef');
	let tintStrength = $state(0);
	function apply(next: string | null) {
		backdrop = next;
		note(next ? `material: ${next}` : 'material off');
	}
	$effect(() => setBackdrop({ backdrop, intensity, tint: tintStrength > 0 ? `color-mix(in oklab, ${tint} ${tintStrength}%, transparent)` : 'none' }));
	// Leaving the page: the window as it was. (Not in onDestroy: that runs on the server too.)
	$effect(() => () => setBackdrop({ backdrop: null, intensity: 100, tint: 'none' }));

	// Share: from a button, anchored on it.
	const anchorOf = (e: MouseEvent) => (e.currentTarget as HTMLElement).getBoundingClientRect();
	const share = (e: MouseEvent, what: string, items: Parameters<typeof host.shell.share>[0]) =>
		run(what, () => host.shell.share({ ...items, anchor: anchorOf(e) }), (r) => (r.service ? `shared with ${r.service}` : 'dismissed'));

	// Drag out: the page's own drag is cancelled, the system's starts with the file.
	function dragOut(e: DragEvent) {
		e.preventDefault();
		void run('drag out', () => host.shell.startDrag({ files: [data.sample] }), (r) => (r.dropped ? 'dropped' : 'abandoned'));
	}

	// The window: traffic lights lower (a taller custom title bar), a fixed aspect ratio.
	let lights = $state(false);
	let ratio = $state(false);

	// Sound and media: a tone from WebAudio, muted or not by the window.
	let audio: AudioContext | null = null;
	let tone: OscillatorNode | null = null;
	function toggleTone() {
		if (tone) return (tone.stop(), (tone = null), note('tone stopped'));
		audio ??= new AudioContext();
		tone = audio.createOscillator();
		const gain = audio.createGain();
		gain.gain.value = 0.05;
		tone.connect(gain).connect(audio.destination);
		tone.start();
		note('tone playing');
	}
	let muted = $state(false);
	onDestroy(() => tone?.stop());

	// Out of sight: a counter that ticks 10 times a second; hidden, WebKit slows it down unless told not to.
	let ticks = $state(0);
	let fullSpeed = $state(false);
	let hiddenAt = 0, hiddenTicks = 0;
	onMount(() => {
		const timer = setInterval(() => ticks++, 100);
		const visibility = () => {
			if (document.hidden) ((hiddenAt = performance.now()), (hiddenTicks = ticks));
			else if (hiddenAt) {
				const seconds = (performance.now() - hiddenAt) / 1000;
				note(`hidden ${seconds.toFixed(1)} s: ${ticks - hiddenTicks} ticks (${Math.round(seconds * 10)} expected)`);
			}
		};
		document.addEventListener('visibilitychange', visibility);
		const offs = [
			host.power.onPowerSourceChange(({ onBattery }) => note(onBattery ? 'unplugged: on battery' : 'plugged in')),
			host.power.onShutdown(() => note('the Mac is shutting down')),
			host.power.onSystemSleep(() => note('going to sleep')),
			host.power.onSystemWake(() => note('woke up'))
		];
		return () => (clearInterval(timer), document.removeEventListener('visibilitychange', visibility), offs.forEach((off) => off()));
	});

	// OAuth: sign in at the demo provider in the system browser, back here with a code, traded for a token.
	let signedIn = $state<string | null>(null);
	async function signIn() {
		const clientId = 'dashboard-demo';
		await run('sign-in', async () => {
			const { code, codeVerifier, redirectUri } = await host.oauth.authorize({ url: `${data.provider}/authorize`, params: { client_id: clientId, scope: 'profile' } });
			const tokens = await host.oauth.exchange({ url: `${data.provider}/token`, clientId, code, codeVerifier, redirectUri });
			signedIn = `${tokens.user} (${tokens.access_token})`;
			return tokens;
		}, (t) => `signed in as ${t.user}`);
	}

	// A WebSocket on the app's own server (src/websocket.ts): echo, the other pages, server pushes.
	let socket = $state<WebSocket | null>(null);
	let socketLog = $state<string[]>([]);
	let outgoing = $state('Hello');
	function connect() {
		if (socket) return socket.close();
		const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/ws`);
		ws.onopen = () => note('socket open');
		ws.onmessage = (e) => {
			const m = JSON.parse(e.data);
			socketLog = [m.type === 'hello' ? `connected as #${m.id}` : m.type === 'peer' ? `#${m.from}: ${m.text}` : `${m.type}: ${m.text}`, ...socketLog].slice(0, 8);
		};
		ws.onclose = () => ((socket = null), note('socket closed'));
		socket = ws;
	}
	onDestroy(() => socket?.close());

	// Touch ID.
	let biometrics = $state<{ available: boolean; type: string } | null>(null);
	onMount(() => void host.system.biometrics().then((b) => (biometrics = b), () => (biometrics = { available: false, type: 'unsupported' })));

	// Website data: a value in the app's localStorage, to see "app" clearing it.
	let stored = $state<string | null>(null);
	const readStored = () => (stored = localStorage.getItem('dashboard:demo'));
	onMount(readStored);
	const clear = (what: string, options: Parameters<typeof host.webview.clearData>[0]) =>
		run(what, async () => {
			const r = await host.webview.clearData(options);
			setTimeout(readStored, 300);
			return r;
		}, (r) => (r.cleared.length ? `cleared ${r.cleared.join(', ')}` : 'nothing stored'));
</script>

<svelte:head><title>Native</title></svelte:head>

<div class="grid max-w-5xl gap-4 p-6 md:grid-cols-2">
	<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
		<h2 class="text-neutral text-base font-semibold">Vibrancy and Liquid Glass</h2>
		<p class="text-neutral-readable text-sm">
			The system draws it behind an element that declares it in CSS — here the sidebar and the title bar:
			<code>--desktop-material: sidebar</code> (or <code>material-sidebar</code> with Tailwind). It costs the page no memory, unlike a CSS blur.
		</p>
		<div class="flex flex-wrap items-center gap-2">
			<span class="text-neutral-readable w-16 text-xs">Vibrancy</span>
			{#each vibrancies as m (m)}
				<Button variant={backdrop === m ? 'solid' : 'outline'} size="small" onclick={() => apply(m)}>{materials[m]!.label}</Button>
			{/each}
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<span class="text-neutral-readable w-16 text-xs">Glass</span>
			{#each ['glass', 'glass-clear'] as m (m)}
				<Button variant={backdrop === m ? 'solid' : 'outline'} size="small" onclick={() => apply(m)}>{materials[m]!.label}</Button>
			{/each}
			<Button variant="outline" size="small" onclick={() => apply(null)} disabled={!backdrop}>Off</Button>
		</div>
		{#if backdrop}
			<p class="text-neutral-readable text-xs" data-backdrop-about>{materials[backdrop]?.about}</p>
			<Slider label="Intensity" min={0} max={100} step={1} showValue bind:value={intensity} />
			{#if isGlass}
				<div class="flex items-end gap-3">
					<label class="text-neutral-readable flex flex-col gap-1 text-xs">
						Tint
						<input type="color" bind:value={tint} class="h-8 w-10 cursor-pointer rounded border-0 bg-transparent p-0" />
					</label>
					<div class="flex-1"><Slider label="Tint strength" min={0} max={100} step={1} showValue bind:value={tintStrength} /></div>
				</div>
			{/if}
		{/if}
	</section>

	<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
		<h2 class="text-neutral text-base font-semibold">Window</h2>
		<p class="text-neutral-readable text-sm">The traffic lights where a taller custom title bar wants them, and a width/height kept while resizing.</p>
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" onclick={() => run(lights ? 'traffic lights: back' : 'traffic lights: lower', async () => (await host.window.setTrafficLightPosition(lights ? null : { x: 18, y: 18 }), (lights = !lights)))}>{lights ? 'Traffic lights back' : 'Lower the traffic lights'}</Button>
			<Button variant="outline" onclick={() => run(ratio ? 'aspect ratio: free' : 'aspect ratio: 16/10', async () => (await host.window.setAspectRatio(ratio ? null : 16 / 10), (ratio = !ratio)))}>{ratio ? 'Free the aspect ratio' : 'Keep 16/10 while resizing'}</Button>
		</div>
	</section>

	<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
		<h2 class="text-neutral text-base font-semibold">Share</h2>
		<p class="text-neutral-readable text-sm">The system share menu — AirDrop, Mail, Messages, Notes — anchored on the button.</p>
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" onclick={(e: MouseEvent) => share(e, 'share a link', { text: 'The Svelte docs', url: 'https://svelte.dev/docs' })}>Share a link</Button>
			<Button variant="outline" onclick={(e: MouseEvent) => share(e, 'share a file', { files: [data.sample] })}>Share a file</Button>
		</div>
	</section>

	<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
		<h2 class="text-neutral text-base font-semibold">Drag out</h2>
		<p class="text-neutral-readable text-sm">A real file dragged from the page to the Finder, the desktop, a mail or another app.</p>
		<div
			draggable="true"
			ondragstart={dragOut}
			role="button"
			tabindex="0"
			class="border-neutral-muted bg-surface-raised text-neutral flex cursor-grab items-center gap-3 rounded-lg border border-dashed p-3 text-sm select-none active:cursor-grabbing"
		>
			<span class="text-2xl">📄</span>
			<span><strong>Dashboard report.txt</strong><br /><span class="text-neutral-readable">Drag me to the Finder</span></span>
		</div>
	</section>

	<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
		<h2 class="text-neutral text-base font-semibold">Quick Look</h2>
		<p class="text-neutral-readable text-sm">The Finder's space-bar preview, on files of the app: images, PDFs, videos, documents.</p>
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" onclick={() => run('Quick Look', () => host.shell.previewFile(data.sample))}>Preview the report</Button>
		</div>
	</section>

	<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
		<h2 class="text-neutral text-base font-semibold">Sound and media</h2>
		<p class="text-neutral-readable text-sm">The page muted from outside (it keeps playing), every video and audio paused, and what plays or captures right now.</p>
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" onclick={toggleTone}>Play / stop a tone</Button>
			<Button variant="outline" onclick={() => run(muted ? 'unmuted' : 'muted', async () => (await host.webview.setAudioMuted(!muted), (muted = !muted)))}>{muted ? 'Unmute the page' : 'Mute the page'}</Button>
			<Button variant="outline" onclick={() => run('media paused', () => host.webview.pauseMedia())}>Pause media</Button>
			<Button variant="outline" onclick={() => run('media state', () => host.webview.getMediaState(), (m) => `${m.audible ? 'audible' : 'silent'}, ${m.muted ? 'muted' : 'not muted'}, playback ${m.playback}, camera ${m.camera}, mic ${m.microphone}`)}>What's playing?</Button>
		</div>
	</section>

	<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
		<h2 class="text-neutral text-base font-semibold">Out of sight</h2>
		<p class="text-neutral-readable text-sm">A counter at 10 ticks a second ({ticks}). Hide or minimize the window a few seconds: WebKit slows a hidden page down, unless it runs at full speed. The log says how many ticks it got.</p>
		<div class="flex flex-wrap gap-2">
			<Button variant={fullSpeed ? 'solid' : 'outline'} onclick={() => run(fullSpeed ? 'throttled when hidden' : 'full speed when hidden', async () => (await host.webview.setBackgroundThrottling(fullSpeed), (fullSpeed = !fullSpeed)))}>{fullSpeed ? 'Full speed when hidden: on' : 'Run at full speed when hidden'}</Button>
		</div>
		<p class="text-neutral-readable text-xs">Power events land in the log too: unplugging, sleep, wake, shutdown.</p>
	</section>

	<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
		<h2 class="text-neutral text-base font-semibold">Sign in (OAuth)</h2>
		<p class="text-neutral-readable text-sm">The provider's page opens in your browser (a demo provider here; GitHub or Google in a real app). Approve, and the app comes back to the front with a code, traded for a token.</p>
		<div class="flex flex-wrap items-center gap-2">
			<Button onclick={signIn}>Sign in with the demo provider</Button>
			{#if signedIn}<span class="text-success text-sm">Signed in: {signedIn}</span>{/if}
		</div>
	</section>

	<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
		<h2 class="text-neutral text-base font-semibold">WebSocket</h2>
		<p class="text-neutral-readable text-sm">A socket on the app's own server (src/websocket.ts): your messages come back, other windows get them, and server code pushes to everyone.</p>
		<div class="flex flex-wrap items-center gap-2">
			<Button variant={socket ? 'solid' : 'outline'} onclick={connect}>{socket ? 'Disconnect' : 'Connect'}</Button>
			<input class="border-neutral-muted bg-surface-raised text-neutral h-8 rounded-md border px-2 text-sm" bind:value={outgoing} disabled={!socket} />
			<Button variant="outline" disabled={!socket} onclick={() => socket?.send(outgoing)}>Send</Button>
			<Button variant="outline" onclick={() => run('server push', () => fetch('/native/push', { method: 'POST' }).then((r) => r.json()), (r) => `${r.subscribers} socket(s)`)}>Push from the server</Button>
		</div>
		{#if socketLog.length}<pre class="text-neutral-readable text-xs">{socketLog.join('\n')}</pre>{/if}
	</section>

	<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
		<h2 class="text-neutral text-base font-semibold">Touch ID</h2>
		<p class="text-neutral-readable text-sm">
			Confirm it's you before a sensitive action. {#if biometrics}Here: {biometrics.available ? biometrics.type : `no biometry (${biometrics.type}), the password is asked`}.{/if}
		</p>
		<div class="flex flex-wrap gap-2">
			<Button onclick={() => run('authenticate', () => host.secureStorage.authenticate('confirm the demo payment'), (r) => (r.authenticated ? 'it was you' : `no: ${r.reason}`))}>Confirm with Touch ID</Button>
			<Button variant="outline" onclick={() => run('authenticate (Touch ID only)', () => host.secureStorage.authenticate('unlock the vault', { biometricsOnly: true }), (r) => (r.authenticated ? 'it was you' : `no: ${r.reason}`))}>Touch ID only</Button>
		</div>
	</section>

	<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4 md:col-span-2">
		<h2 class="text-neutral text-base font-semibold">Website data</h2>
		<p class="text-neutral-readable text-sm">
			Clear what sites stored — the ones opened in tabs (Docs) — and, if asked, the app's own storage. The app's cookies stay: they hold its session with its server.
			In the app's storage now: <code class="text-neutral">{stored ?? 'nothing'}</code>.
		</p>
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" onclick={() => (localStorage.setItem('dashboard:demo', `saved at ${new Date().toLocaleTimeString()}`), readStored())}>Store something</Button>
			<Button variant="outline" onclick={() => clear("clear other sites' data", {})}>Clear other sites' data</Button>
			<Button variant="outline" onclick={() => clear("clear other sites' cookies", { types: ['cookies'] })}>Only their cookies</Button>
			<Button variant="outline" onclick={() => clear("clear the app's storage too", { app: true })}>The app's storage too</Button>
		</div>
	</section>

	<NativeAppWindows />
	<NativeProcesses />
	<NativeWebSecurity />
	<NativeSessions />
	<NativeFilesPrint />
	<NativeWebContent />
	<NativeInputMenus />
	<section class="flex flex-col gap-2 md:col-span-2">
		<h2 class="text-neutral text-base font-semibold">What happened</h2>
		{#if log.length}
			<pre class="bg-surface-raised border-neutral-muted text-neutral-readable max-h-60 overflow-auto rounded-lg border p-3 text-xs">{log.join('\n')}</pre>
		{:else}
			<p class="text-neutral-readable text-sm">Nothing yet.</p>
		{/if}
	</section>
</div>

