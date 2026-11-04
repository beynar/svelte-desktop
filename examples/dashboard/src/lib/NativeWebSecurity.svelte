<script lang="ts">
	import { Button } from 'entasis/button';
	let output = $state('Run a local probe. Policy handlers live in server code.');
	let busy = $state(false);
	async function probe(kind: 'auth' | 'tls' | 'permission') {
		busy = true;
		const id = `web-security-${kind}`;
		const configure = async (action: string) => {
			const response = await fetch('/native/web-security', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
			if (!response.ok) throw new Error(await response.text());
			return response.json();
		};
		async function load(action: () => Promise<unknown>): Promise<'loaded' | 'failed'> {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => { cleanup(); reject(new Error('Probe navigation timed out')); }, 10000);
				const loaded = host.view.onLoaded((event) => { if (event.id === id) { cleanup(); resolve('loaded'); } });
				const failed = host.view.onFailed((event) => { if (event.id === id) { cleanup(); resolve('failed'); } });
				function cleanup() { clearTimeout(timer); loaded(); failed(); }
				action().catch((error) => { cleanup(); reject(error); });
			});
		}
		try {
			const fixture = await configure(kind === 'auth' ? 'handler' : 'default');
			if (kind === 'tls' && !fixture.https) throw new Error(fixture.tlsError);
			const first = await load(() => host.view.create({ id, url: kind === 'tls' ? fixture.https : `${fixture.http}/${kind === 'auth' ? 'basic' : ''}`, bounds: { x: 30, y: 90, width: 500, height: 220 }, hidden: kind !== 'permission' }));
			if (kind === 'tls') {
				if (first !== 'failed') throw new Error('Expected self-signed certificate refusal');
				await configure('trust');
				if (await load(() => host.view.navigate(id, { url: fixture.https })) !== 'loaded') throw new Error('Exact certificate was refused');
				output = 'Refused by default; accepted after trusting the exact host and fingerprint.';
			} else if (kind === 'permission') {
				const request = `Promise.race([new Promise(r => navigator.geolocation.getCurrentPosition(() => r('granted'), e => r(e.code === 1 ? 'denied' : e.message), {timeout:3000})), new Promise(r => setTimeout(() => r('OS/engine decision still pending'), 3500))])`;
				const before = await host.view.executeJavaScript<string>(id, request);
				await configure('handler'); await load(() => host.view.reload(id));
				const after = await host.view.executeJavaScript<string>(id, request);
				output = `Default request: ${before}. Policy configured to allow this origin; OS/location result: ${after}.`;
			} else output = await host.view.executeJavaScript<string>(id, 'document.body.innerText');
		} catch (error) { output = (error as Error).message; }
		finally {
			await host.view.destroy(id).catch(() => {});
			await configure('default').catch(() => {});
			await configure('untrust').catch(() => {});
			busy = false;
		}
	}
</script>
<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
	<h2 class="text-neutral text-base font-semibold">Per-origin web permissions</h2>
	<p class="text-neutral-readable text-sm">A third-party page is denied by default. A server handler can allow its location request; macOS consent still applies and may show a system prompt.</p>
	<Button variant="outline" disabled={busy} onclick={() => probe('permission')}>Other-origin location</Button>
</section>
<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
	<h2 class="text-neutral text-base font-semibold">HTTP authentication</h2>
	<p class="text-neutral-readable text-sm">A separate local server requires Basic authentication. Credentials are supplied by the server handler, outside the page.</p>
	<Button variant="outline" disabled={busy} onclick={() => probe('auth')}>Local Basic auth</Button>
</section>
<section class="border-neutral-muted flex flex-col gap-3 rounded-xl border p-4">
	<h2 class="text-neutral text-base font-semibold">Exact certificate trust</h2>
	<p class="text-neutral-readable text-sm">A self-signed local HTTPS server is refused first, then allowed by its exact host and SHA-256 fingerprint.</p>
	<Button variant="outline" disabled={busy} onclick={() => probe('tls')}>Self-signed TLS</Button>
	<p class="text-neutral-readable break-all text-sm" data-web-security-result>{output}</p>
</section>
