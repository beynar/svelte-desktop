<!-- The web APIs that ask the system for a permission, one button each: the prompt comes the first
     time (the reasons are the shell's defaults, or desktop.config's `permissions`). -->
<script lang="ts">
	import { Button } from 'entasis/button';

	let out = $state<Record<string, string>>({});
	const say = (key: string, text: string) => (out[key] = text);
	const fail = (key: string) => (e: unknown) => say(key, `✗ ${(e as Error)?.name ?? ''} ${(e as Error)?.message ?? e}`.trim());

	let camera = $state<MediaStream | null>(null);
	let screen = $state<MediaStream | null>(null);
	const stop = (s: MediaStream | null) => s?.getTracks().forEach((t) => t.stop());
	const video = (node: HTMLVideoElement, stream: MediaStream) => {
		node.srcObject = stream;
		return { update: (next: MediaStream) => void (node.srcObject = next) };
	};

	async function useCamera() {
		stop(camera);
		camera = await navigator.mediaDevices.getUserMedia({ video: true }).catch((e) => (fail('camera')(e), null));
		if (camera) say('camera', '✓ camera on');
	}
	function locate() {
		say('location', '…');
		navigator.geolocation.getCurrentPosition(
			(p) => say('location', `✓ ${p.coords.latitude.toFixed(4)}, ${p.coords.longitude.toFixed(4)} (±${Math.round(p.coords.accuracy)} m)`),
			(e) => say('location', `✗ ${e.message || ['', 'permission denied', 'position unavailable', 'timeout'][e.code]}`),
			{ timeout: 15_000 }
		);
	}
	async function notify() {
		const permission = await Notification.requestPermission();
		if (permission !== 'granted') return say('notification', `✗ permission: ${permission}`);
		const n = new Notification('Hello from the Form page', { body: 'Click me: the page hears it.', tag: 'form-test' });
		say('notification', '… shown?');
		n.onshow = () => say('notification', '✓ shown');
		n.onclick = () => say('notification', '✓ clicked');
		n.onclose = () => say('notification', '✓ closed');
		n.onerror = () => say('notification', '✗ error');
	}
	async function share() {
		stop(screen);
		screen = await navigator.mediaDevices.getDisplayMedia({ video: true }).catch((e) => (fail('screen')(e), null));
		if (screen) say('screen', `✓ sharing ${screen.getVideoTracks()[0]?.label ?? ''}`);
	}

	type Recognition = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: (e: any) => void; onerror: (e: any) => void; onend: () => void };
	let listening = $state<Recognition | null>(null);
	function dictate() {
		if (listening) return listening.stop();
		const Ctor = (globalThis as any).SpeechRecognition ?? (globalThis as any).webkitSpeechRecognition;
		if (!Ctor) return say('speech', '✗ no SpeechRecognition here');
		const r: Recognition = new Ctor();
		r.lang = navigator.language;
		r.interimResults = true;
		r.continuous = true;
		r.onresult = (e) => say('speech', `“${[...e.results].map((x: any) => x[0].transcript).join(' ')}”`);
		r.onerror = (e) => say('speech', `✗ ${e.error}`);
		r.onend = () => (listening = null);
		r.start();
		listening = r;
		say('speech', '… speak');
	}

	$effect(() => () => (stop(camera), stop(screen), listening?.stop()));
	const rows = [
		{ key: 'camera', label: 'Camera', hint: 'getUserMedia({ video })', run: useCamera },
		{ key: 'location', label: 'Location', hint: 'navigator.geolocation', run: locate },
		{ key: 'notification', label: 'Notification', hint: 'Notification.requestPermission(), new Notification()', run: notify },
		{ key: 'screen', label: 'Share screen', hint: 'getDisplayMedia()', run: share },
		{ key: 'speech', label: 'Dictation', hint: 'SpeechRecognition', run: dictate }
	];
</script>

<div class="flex flex-col gap-2">
	{#each rows as row (row.key)}
		<div class="border-neutral-muted flex items-center gap-3 rounded-lg border px-3 py-2">
			<Button type="button" variant="outline" size="small" onclick={row.run}>{row.key === 'speech' && listening ? 'Stop' : row.label}</Button>
			<code class="text-neutral-readable hidden shrink-0 text-xs md:block">{row.hint}</code>
			<span class="text-neutral min-w-0 flex-1 truncate text-right text-sm">{out[row.key] ?? ''}</span>
		</div>
	{/each}
	{#if camera || screen}
		<div class="grid gap-2 md:grid-cols-2">
			{#if camera}<video class="bg-surface-raised w-full rounded-lg" autoplay muted playsinline use:video={camera}></video>{/if}
			{#if screen}<video class="bg-surface-raised w-full rounded-lg" autoplay muted playsinline use:video={screen}></video>{/if}
		</div>
	{/if}
</div>
