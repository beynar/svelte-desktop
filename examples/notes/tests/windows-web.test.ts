// Web control on a real Windows runner: authentication and certificates against real local servers,
// find, JavaScript dialogs answered by real keys, media, a real render-process crash, a real file
// drag from another process, clearData read back from real storage and a real server.
//   WINDOWS_E2E=1 [WINDOWS_APP=<app folder>] bun test --timeout 120000 tests/windows-web.test.ts
import { afterAll, beforeAll, describe, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { createServer as createTlsServer } from 'node:tls';
import { launch, type AppHandle } from '@kitop/shell/test';
import { APP, driver, fileDrag, log, ps, stopLeftovers, tmp, win } from './windows-input.ts';

// A self-signed certificate of the Linux suite: its fingerprint is what the challenge must report.
const policyTest = readFileSync(resolve(import.meta.dir, '../../../packages/shell/test/platform/linux-web-policy.ts'), 'utf8');
const CERT = policyTest.match(/const CERT = `([\s\S]*?)`/)![1]!, KEY = policyTest.match(/const KEY = `([\s\S]*?)`/)![1]!;
const FINGERPRINT = createHash('sha256').update(Buffer.from(CERT.replace(/-----[^-]+-----|\s/g, ''), 'base64')).digest('hex');

describe.skipIf(!process.env.WINDOWS_E2E)('windows: web control', () => {
	let app: AppHandle;
	const { op, code, check, until, inView } = driver(() => app);
	const wv = <T = any>(name: string, args: Record<string, unknown> = {}, ms?: number) => op<T>('webview', name, args, ms);
	const hits = new Map<string, number>();
	const seen = new Map<string, string | null>(); // path -> the Authorization or Cookie the server got
	let server: ReturnType<typeof Bun.serve>;
	let site = '';  // another site than the app's: 127.0.0.1 and localhost count as the app's, as on macOS
	let appName = '';
	const html = (body: string, init: ResponseInit = {}) => new Response(`<!doctype html><title>t</title>${body}`, { ...init, headers: { 'content-type': 'text/html', 'cache-control': 'no-store', ...init.headers } });

	const closeView = (id: string) => op('view', 'destroy', { id }).catch(() => {});
	const openView = async (id: string, url: string, bounds = { x: 0, y: 0, width: 600, height: 400 }) => {
		const loaded = app.nextEvent('viewLoaded', (e: { id: string }) => e.id === id, 20_000);
		await op('view', 'create', { id, windowId: 0, url, bounds });
		await loaded;
	};
	const go = async (id: string, url: string) => {
		const done = app.nextEvent('viewLoaded', (e: { id: string; url: string }) => e.id === id && e.url === url, 20_000);
		await op('view', 'navigate', { id, url });
		await done;
	};
	const bodyText = (id: string) => inView<string>(id, 'document.body ? document.body.innerText : ""');
	const none = (name: string, ms = 800) => app.nextEvent(name, undefined, ms).then(() => false, () => true);
	const inPage = <T = any>(code: string, ms?: number) => wv<T>('executeJavaScript', { windowId: 0, code }, ms);

	beforeAll(async () => {
		await stopLeftovers();
		server = Bun.serve({
			hostname: '0.0.0.0',
			port: 0,
			idleTimeout: 60,
			fetch(req) {
				const { pathname } = new URL(req.url);
				hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
				if (pathname.startsWith('/basic')) {
					const auth = req.headers.get('authorization');
					seen.set(pathname, auth);
					if (auth === `Basic ${btoa('ada:right')}`) return html('<p>welcome</p>');
					return html('<p>server said no</p>', { status: 401, headers: { 'www-authenticate': `Basic realm="realm of ${pathname}"` } });
				}
				if (pathname === '/set-cookie') return new Response('set', { headers: { 'set-cookie': 'server=side; Path=/; Max-Age=3600' } });
				if (pathname === '/see-cookie') {
					seen.set(pathname, req.headers.get('cookie'));
					return new Response('', { headers: { 'cache-control': 'no-store' } });
				}
				if (pathname.startsWith('/cached')) return new Response('cacheable', { headers: { 'cache-control': 'max-age=3600', 'content-type': 'text/plain' } });
				if (pathname === '/sw.js') return new Response(`self.addEventListener('fetch', () => {});`, { headers: { 'content-type': 'text/javascript' } });
				if (pathname === '/find') return html(`<p>top</p><div style="height:3000px"></div><p>needle one</p><div style="height:3000px"></div><p>Needle two</p><div style="height:3000px"></div>`);
				if (pathname === '/page-with-frame') return html(`<iframe src="/framed" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>`);
				return html(`<p>${pathname}</p>`);
			},
		});
		site = `http://127.0.0.2:${server.port}`;
		// Fake devices: the runner has no camera or microphone. Other browser arguments mean another
		// browser process: stopLeftovers makes sure the last suite's is gone.
		app = await launch({ app: APP, timeout: 90_000, env: { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--use-fake-device-for-media-stream --use-fake-ui-for-media-stream' } });
		await app.waitFor('#counter', { timeout: 30_000 });
		appName = (await op<{ name: string }>('app', 'getInfo')).name;
		await op('window', 'setTitle', { windowId: 0, title: 'E2E web window' });
		await op('window', 'setBounds', { windowId: 0, x: 300, y: 60, width: 900, height: 650 });
	}, 150_000);
	afterAll(async () => {
		await app?.close().catch(() => {});
		server?.stop(true);
	}, 30_000);

	check('report: every operation of this batch is registered; getInfo reports the real values', async () => {
		const report = await op<{ services: Record<string, Record<string, string>> }>('capabilities', 'describe');
		for (const name of ['allowCertificate', 'revokeCertificate', 'listClientIdentities', 'find', 'clearFind', 'getDialog', 'respondToDialog', 'setAudioMuted', 'pauseMedia', 'getMediaState', 'setBackgroundThrottling', 'setRecovery', 'setFileDrop', 'clearData'])
			expect({ name, status: report.services.webview?.[name] }).toEqual({ name, status: 'implemented' });
		expect(await wv('getInfo', { windowId: 0 })).toMatchObject({ fileDrop: true, backgroundThrottling: true, recovery: 'reload' });
	});

	// ── authentication ──────────────────────────────────────────────────────

	type Challenge = { requestId: string; origin: string; host: string; port: number; realm: string; method: string; proxy: boolean; previousFailures: number; fingerprint?: string; identities: Array<{ identity: string; label: string; fingerprint: string }>; viewId?: string; windowId?: number };
	const auth = (enabled: boolean, timeoutMs = 15_000) => wv('configurePolicy', { kind: 'auth', enabled, timeoutMs });
	const challenge = (method: string, ms = 15_000) => app.nextEvent<Challenge>('webAuthChallenge', (c) => c.method === method, ms);
	const answer = (c: Challenge, answer: unknown) => wv('respondPolicy', { requestId: c.requestId, answer });

	check('auth: no handler, the page gets the server\'s own answer; no login box', async () => {
		await openView('e2e-auth', `${site}/start`);
		try {
			await op('view', 'navigate', { id: 'e2e-auth', url: `${site}/basic-none` });
			await until('the server\'s 401 is shown', async () => (await bodyText('e2e-auth')).includes('server said no'));
			expect(seen.get('/basic-none')).toBeNull();
			expect(await win('close-if-any', { title: 'Sign in' })).toBe('none');
		} finally {
			await closeView('e2e-auth');
		}
	});

	check('auth: a handler answers with credentials; wrong ones come back as a failure; right ones reach the server', async () => {
		await openView('e2e-auth', `${site}/start`);
		await auth(true);
		try {
			let asked = challenge('basic');
			await op('view', 'navigate', { id: 'e2e-auth', url: `${site}/basic-one` });
			let c = await asked;
			expect(c).toMatchObject({ origin: site, host: '127.0.0.2', port: server.port, realm: 'realm of /basic-one', method: 'basic', proxy: false, previousFailures: 0, identities: [], viewId: 'e2e-auth', windowId: 0 });
			asked = challenge('basic');
			await answer(c, { username: 'ada', password: 'wrong' });
			c = await asked;
			expect(seen.get('/basic-one')).toBe(`Basic ${btoa('ada:wrong')}`);
			expect(c.previousFailures).toBe(1);
			await answer(c, { username: 'ada', password: 'right' });
			await until('the page behind it', async () => (await bodyText('e2e-auth')).includes('welcome'));
			expect(seen.get('/basic-one')).toBe(`Basic ${btoa('ada:right')}`);
			expect(await code('webview', 'respondPolicy', { requestId: c.requestId, answer: 'cancel' })).toBe('unavailable');

			// A credential that works is sent to all of its origin from then on: the rest are other hosts.
			// `default` and `cancel` go on without a credential: the server's own answer, no login box.
			const elsewhere = (n: number, path: string) => `http://127.0.0.${n}:${server.port}${path}`;
			for (const [n, path, reply] of [[3, '/basic-default', 'default'], [4, '/basic-cancel', 'cancel']] as const) {
				asked = challenge('basic');
				await op('view', 'navigate', { id: 'e2e-auth', url: elsewhere(n, path) });
				await answer(await asked, reply);
				await until(`${reply}: the server's 401`, async () => (await bodyText('e2e-auth')).includes('server said no'));
				expect(seen.get(path)).toBeNull();
				await go('e2e-auth', `${site}/start`);
			}

			// Unanswered: refused at the deadline.
			await auth(true, 300);
			asked = challenge('basic');
			await op('view', 'navigate', { id: 'e2e-auth', url: elsewhere(5, '/basic-late') });
			const late = await asked;
			await until('the deadline answers', async () => (await bodyText('e2e-auth')).includes('server said no'));
			expect(await code('webview', 'respondPolicy', { requestId: late.requestId, answer: { username: 'ada', password: 'right' } })).toBe('unavailable');
			expect(await code('webview', 'configurePolicy', { kind: 'auth', enabled: true, timeoutMs: 10 })).toBe('invalid_args');
			// The page has no say in any of it.
			expect(await app.eval(`host.webview.allowCertificate({ host: 'a.example', fingerprint: '${FINGERPRINT}' }).then(() => 'ok', (e) => e.code)`)).toBe('denied');
		} finally {
			await auth(false).catch(() => {});
			await closeView('e2e-auth');
		}
	}, 90_000);

	// ── server certificates ─────────────────────────────────────────────────

	let httpsHits = 0;
	const tlsServer = () => Bun.serve({
		hostname: '0.0.0.0',
		port: 0,
		tls: { cert: CERT, key: KEY },
		fetch(req) {
			if (new URL(req.url).pathname !== '/favicon.ico') httpsHits++;
			// A new connection each time: revoking doesn't reach one that's open.
			return html('<p>tls ok</p>', { headers: { connection: 'close' } });
		},
	});

	check('certificates: a self-signed server, refused, challenged, pinned, revoked', async () => {
		const https = tlsServer();
		const tls = (host: string) => `https://${host}:${https.port}`;
		const pin = (host: string) => ({ host, fingerprint: FINGERPRINT });
		await openView('e2e-tls', `${site}/start`);
		try {
			expect(await code('webview', 'allowCertificate', { host: '*.example', fingerprint: FINGERPRINT })).toBe('invalid_args');
			expect(await code('webview', 'allowCertificate', { host: 'a.example', fingerprint: 'abc' })).toBe('invalid_args');

			// No handler, no pin: it fails. Not WebView2's error page, which has a way past it.
			let failed = app.nextEvent('viewFailed', (e: { id: string }) => e.id === 'e2e-tls', 15_000);
			await op('view', 'navigate', { id: 'e2e-tls', url: `${tls('127.0.0.2')}/` });
			await failed;
			await Bun.sleep(500);
			expect(httpsHits).toBe(0);
			expect(await bodyText('e2e-tls').catch(() => '')).not.toContain('tls ok');

			// A handler sees it, with the real fingerprint.
			await auth(true);
			await go('e2e-tls', `${site}/start`);
			let asked = challenge('serverTrust');
			await op('view', 'navigate', { id: 'e2e-tls', url: `${tls('127.0.0.2')}/` });
			let c = await asked;
			expect(c).toMatchObject({ origin: tls('127.0.0.2'), host: '127.0.0.2', port: https.port, realm: '', method: 'serverTrust', proxy: false, previousFailures: 0, fingerprint: FINGERPRINT, identities: [], viewId: 'e2e-tls', windowId: 0 });
			await answer(c, 'cancel');
			await Bun.sleep(800);
			expect(httpsHits).toBe(0);

			// `default` with nothing pinned refuses too.
			asked = challenge('serverTrust');
			await op('view', 'navigate', { id: 'e2e-tls', url: `${tls('127.0.0.2')}/` });
			await answer(await asked, 'default');
			await Bun.sleep(800);
			expect(httpsHits).toBe(0);

			// A pin for another certificate changes nothing.
			await wv('allowCertificate', { host: '127.0.0.2', fingerprint: 'a'.repeat(64) });
			asked = challenge('serverTrust');
			await op('view', 'navigate', { id: 'e2e-tls', url: `${tls('127.0.0.2')}/` });
			c = await asked;
			// Pinned while handling the challenge, then `default`: it loads, over TLS.
			await wv('allowCertificate', pin('127.0.0.2'));
			await answer(c, 'default');
			await until('the page over TLS', async () => (await bodyText('e2e-tls').catch(() => '')).includes('tls ok'), 15_000);
			expect(httpsHits).toBe(1);

			// No handler, a pin made before the load: it just loads, and a fetch to it works too.
			await auth(false);
			await wv('allowCertificate', pin('localhost'));
			await go('e2e-tls', `${tls('localhost')}/pinned`);
			expect(await bodyText('e2e-tls')).toContain('tls ok');
			expect(httpsHits).toBe(2);

			// Revoked: the next connection is refused again.
			await wv('revokeCertificate', pin('localhost'));
			const before = httpsHits;
			failed = app.nextEvent('viewFailed', (e: { id: string }) => e.id === 'e2e-tls', 15_000);
			await op('view', 'navigate', { id: 'e2e-tls', url: `${tls('localhost')}/after-revoke` });
			await failed;
			await Bun.sleep(500);
			expect(httpsHits).toBe(before);

			// What's still pinned keeps working after that: the exception WebView2 forgot comes back.
			await go('e2e-tls', `${tls('127.0.0.2')}/still-pinned`);
			expect(httpsHits).toBe(before + 1);

			// A request from a page, not a navigation, goes through the same policy.
			await wv('revokeCertificate', pin('127.0.0.2'));
			await go('e2e-tls', `${site}/start`);
			const count = httpsHits;
			expect(await inView('e2e-tls', `fetch(${JSON.stringify(`${tls('127.0.0.2')}/fetched`)}, { mode: 'no-cors' }).then(() => 'ok', (e) => e.name)`)).toBe('TypeError');
			expect(httpsHits).toBe(count);
			await wv('allowCertificate', pin('127.0.0.2'));
			expect(await inView('e2e-tls', `fetch(${JSON.stringify(`${tls('127.0.0.2')}/fetched`)}, { mode: 'no-cors' }).then(() => 'ok', (e) => e.name)`)).toBe('ok');
			expect(httpsHits).toBe(count + 1);
		} finally {
			await auth(false).catch(() => {});
			await closeView('e2e-tls');
			https.stop(true);
		}
	}, 120_000);

	// ── client certificates ─────────────────────────────────────────────────

	check('client certificates: the personal store is listed; a chosen one reaches a real TLS server; default goes without; cancel fails', async () => {
		// PowerShell 7 runs this file, and its module path breaks Windows PowerShell's Cert: drive.
		const certificates = `$env:PSModulePath = [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine'); Import-Module Microsoft.PowerShell.Security; Import-Module PKI;`;
		const made = await ps(`${certificates} $c = New-SelfSignedCertificate -Subject 'CN=kitop e2e client' -CertStoreLocation Cert:\\CurrentUser\\My -KeySpec Signature -KeyExportPolicy Exportable -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.2'); $h = [Security.Cryptography.SHA256]::Create().ComputeHash($c.RawData); ($h | ForEach-Object { $_.ToString('x2') }) -join ''; $c.Thumbprint`);
		expect(made.code).toBe(0);
		const [fingerprint, thumbprint] = made.out.split(/\s+/) as [string, string];
		const servers: Array<ReturnType<typeof createTlsServer>> = [];
		// A raw TLS server: neither Bun.serve nor node:https show the certificate a client presented.
		const mutual = async () => {
			const s = createTlsServer({ cert: CERT, key: KEY, requestCert: true, rejectUnauthorized: false }, (socket) => {
				socket.once('data', () => {
					const peer = socket.getPeerCertificate();
					const presented = peer?.raw ? createHash('sha256').update(peer.raw).digest('hex') : 'none';
					socket.end(`HTTP/1.1 200 OK\r\ncontent-type: text/html\r\nconnection: close\r\n\r\n<!doctype html><p>client:${presented}</p>`);
				});
				socket.on('error', () => {});
			});
			servers.push(s);
			await new Promise<void>((done) => s.listen(0, '0.0.0.0', done));
			return `https://127.0.0.2:${(s.address() as AddressInfo).port}/`;
		};
		await openView('e2e-mtls', `${site}/start`);
		try {
			const listed = await wv<Challenge['identities']>('listClientIdentities');
			expect(listed).toContainEqual({ identity: fingerprint, fingerprint, label: 'kitop e2e client' });
			expect(await app.eval(`host.webview.listClientIdentities().then(() => 'ok', (e) => e.code)`)).toBe('denied');
			await wv('allowCertificate', { host: '127.0.0.2', fingerprint: FINGERPRINT });

			// Each server its own: WebView2 keeps the answer for a host and port.
			await auth(true);
			let url = await mutual();
			let asked = challenge('clientCertificate', 20_000);
			await op('view', 'navigate', { id: 'e2e-mtls', url });
			let c = await asked;
			expect(c).toMatchObject({ host: '127.0.0.2', origin: new URL(url).origin, proxy: false, viewId: 'e2e-mtls' });
			expect(c.identities).toContainEqual({ identity: fingerprint, fingerprint, label: expect.any(String) });
			await answer(c, { identity: fingerprint });
			await until('the server saw it', async () => (await bodyText('e2e-mtls').catch(() => '')).includes(`client:${fingerprint}`), 15_000);

			url = await mutual();
			asked = challenge('clientCertificate', 20_000);
			await op('view', 'navigate', { id: 'e2e-mtls', url });
			await answer(await asked, 'default');
			await until('it went without', async () => (await bodyText('e2e-mtls').catch(() => '')).includes('client:none'), 15_000);

			url = await mutual();
			asked = challenge('clientCertificate', 20_000);
			const failed = app.nextEvent('viewFailed', (e: { id: string }) => e.id === 'e2e-mtls', 20_000);
			await op('view', 'navigate', { id: 'e2e-mtls', url });
			await answer(await asked, 'cancel');
			await failed;

			// An identity that isn't on offer cancels too.
			url = await mutual();
			asked = challenge('clientCertificate', 20_000);
			const failedAgain = app.nextEvent('viewFailed', (e: { id: string }) => e.id === 'e2e-mtls', 20_000);
			await op('view', 'navigate', { id: 'e2e-mtls', url });
			await answer(await asked, { identity: 'b'.repeat(64) });
			await failedAgain;

			// No handler: without a certificate, and no picker.
			await auth(false);
			url = await mutual();
			await op('view', 'navigate', { id: 'e2e-mtls', url });
			await until('no handler went without', async () => (await bodyText('e2e-mtls').catch(() => '')).includes('client:none'), 15_000);
		} finally {
			await auth(false).catch(() => {});
			await closeView('e2e-mtls');
			for (const s of servers) s.close();
			await ps(`${certificates} Remove-Item Cert:\\CurrentUser\\My\\${thumbprint}`);
		}
	}, 120_000);

	// ── find ────────────────────────────────────────────────────────────────

	// The active match has a color of its own; a capture of the page shows it for real.
	const matchPixels = async (id: string) => {
		const { data } = await wv<{ data: string }>('capturePage', { viewId: id });
		const file = join(tmp, `c${Math.random().toString(36).slice(2)}.png`);
		writeFileSync(file, Buffer.from(data, 'base64'));
		const r = await ps(`param([string]$File)
Add-Type -AssemblyName System.Drawing
$b = New-Object System.Drawing.Bitmap $File
$colors = @{}; $n = 0
for ($y = 0; $y -lt $b.Height; $y += 2) { for ($x = 0; $x -lt $b.Width; $x += 2) { $p = $b.GetPixel($x, $y); if ($p.R -gt 240 -and $p.G -gt 120 -and $p.B -lt 80) { $n++ } } }
$n`, file);
		return Number(r.out);
	};

	check('find: matches, in turn, wrapping or not, by case; none; cleared', async () => {
		await openView('e2e-find', `${site}/find`);
		const t = { viewId: 'e2e-find' };
		const scroll = () => inView<number>('e2e-find', 'Math.round(scrollY)');
		const find = (o: object) => wv<{ matchFound: boolean }>('find', { ...t, ...o });
		const settled = async () => {
			let last = -1;
			for (let i = 0; i < 30; i++) {
				const now = await scroll();
				if (now === last) return now;
				last = now;
				await Bun.sleep(100);
			}
			return last;
		};
		try {
			expect(await code('webview', 'find', { ...t, text: '' })).toBe('invalid_args');
			expect(await scroll()).toBe(0);
			expect(await find({ text: 'needle' })).toEqual({ matchFound: true });
			const first = await settled();
			const lit = await matchPixels('e2e-find');
			log('first match, scrolled to', first, 'selection', await inView('e2e-find', 'String(getSelection())'), 'pixels', lit);
			expect(first).toBeGreaterThan(2000);
			expect(first).toBeLessThan(4000);
			expect(lit).toBeGreaterThan(20);
			expect(await find({ text: 'needle' })).toEqual({ matchFound: true });
			const second = await settled();
			expect(second).toBeGreaterThan(5000); // the next one, in another case
			expect(await find({ text: 'needle' })).toEqual({ matchFound: true });
			expect(Math.abs((await settled()) - first)).toBeLessThan(10); // wraps by default
			expect(await find({ text: 'needle', backwards: true })).toEqual({ matchFound: true });
			expect(Math.abs((await settled()) - second)).toBeLessThan(10);
			expect(await find({ text: 'needle', wraps: false })).toEqual({ matchFound: false }); // nothing after the last
			expect(Math.abs((await settled()) - second)).toBeLessThan(10);
			expect(await find({ text: 'needle', backwards: true, wraps: false })).toEqual({ matchFound: true });
			expect(await find({ text: 'needle', backwards: true, wraps: false })).toEqual({ matchFound: false }); // nothing before the first
			await wv('clearFind', t);
			await Bun.sleep(300);
			expect(await matchPixels('e2e-find')).toBeLessThan(lit / 4); // text edges can come close to that color
			expect(await find({ text: 'Needle', caseSensitive: true })).toEqual({ matchFound: true });
			expect(Math.abs((await settled()) - second)).toBeLessThan(10); // the only one in that case
			expect(await find({ text: 'NEEDLE', caseSensitive: true })).toEqual({ matchFound: false });
			expect(await find({ text: 'nowhere' })).toEqual({ matchFound: false });
			await wv('clearFind', t);
		} finally {
			await closeView('e2e-find');
		}
	});

	// ── JavaScript dialogs ──────────────────────────────────────────────────

	check('dialogs: alert, confirm and prompt answered by respondToDialog; none open; another view\'s', async () => {
		const t = { windowId: 0 };
		const run = (js: string) => inPage(`window.__r = 'pending'; setTimeout(() => { window.__r = ${js}; window.__done = 1; }, 0); 1`);
		const result = async () => {
			await until('the page goes on', async () => (await inPage('window.__done === 1')) === true);
			const r = await inPage('window.__r');
			await inPage('window.__done = 0');
			return r;
		};
		const opened = () => app.nextEvent<{ type: string; message: string; defaultValue?: string; windowId?: number; viewId?: string }>('jsDialog', undefined, 10_000);
		expect(await wv('getDialog', t)).toBeNull();
		expect(await code('webview', 'respondToDialog', t)).toBe('unavailable');

		let shown = opened();
		await run(`alert('hello')`);
		let e = await shown;
		expect(e).toMatchObject({ type: 'alert', message: 'hello', windowId: 0 });
		expect('defaultValue' in e).toBe(false);
		expect(await wv('getDialog', t)).toEqual({ type: 'alert', message: 'hello' });
		await Bun.sleep(500);
		await win('enabled', { title: 'E2E web window' }).then((r) => expect(r).toBe('False')); // it blocks its window
		expect(await wv('respondToDialog', t)).toEqual({ type: 'alert' });
		expect(await result()).toBeNull();
		expect(await wv('getDialog', t)).toBeNull();
		expect(await win('enabled', { title: 'E2E web window' })).toBe('True');

		shown = opened();
		await run(`confirm('sure?')`);
		expect((await shown).type).toBe('confirm');
		await wv('respondToDialog', { ...t, accept: true });
		expect(await result()).toBe(true);
		shown = opened();
		await run(`confirm('sure?')`);
		await shown;
		await wv('respondToDialog', { ...t, accept: false });
		expect(await result()).toBe(false);

		shown = opened();
		await run(`prompt('name?', 'ada')`);
		expect(await shown).toMatchObject({ type: 'prompt', message: 'name?', defaultValue: 'ada' });
		expect(await wv('respondToDialog', t)).toEqual({ type: 'prompt' });
		expect(await result()).toBe('ada');
		shown = opened();
		await run(`prompt('name?', 'ada')`);
		await shown;
		await wv('respondToDialog', { ...t, text: 'grace' });
		expect(await result()).toBe('grace');
		shown = opened();
		await run(`prompt('name?', 'ada')`);
		await shown;
		await wv('respondToDialog', { ...t, accept: false });
		expect(await result()).toBeNull();

		// A view's dialog is its own.
		await openView('e2e-dlg', `${site}/start`);
		try {
			shown = opened();
			await inView('e2e-dlg', `setTimeout(() => { window.__r = confirm('from the view'); }, 0); 1`);
			expect(await shown).toMatchObject({ type: 'confirm', message: 'from the view', viewId: 'e2e-dlg', windowId: 0 });
			expect(await wv('getDialog', t)).toBeNull();
			expect(await wv('getDialog', { viewId: 'e2e-dlg' })).toEqual({ type: 'confirm', message: 'from the view' });
			await wv('respondToDialog', { viewId: 'e2e-dlg' });
			await until('the view goes on', async () => (await inView('e2e-dlg', 'window.__r')) === true);

			// A navigation closes it, and beforeunload asks nothing: the page just leaves.
			shown = opened();
			await inView('e2e-dlg', `setTimeout(() => alert('going away'), 0); 1`);
			await shown;
			await go('e2e-dlg', `${site}/next`);
			expect(await wv('getDialog', { viewId: 'e2e-dlg' })).toBeNull();
			await inView('e2e-dlg', `addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = 'stay'; }); 1`);
			const quiet = none('jsDialog', 2000);
			await go('e2e-dlg', `${site}/after-unload`);
			expect(await quiet).toBe(true);
		} finally {
			await closeView('e2e-dlg');
		}
	}, 90_000);

	check('dialogs: the real dialog on screen, answered by real keys and a real button', async () => {
		const run = (js: string) => inPage(`window.__r = 'pending'; setTimeout(() => { window.__r = ${js}; window.__done = 1; }, 0); 1`);
		const result = async () => {
			await until('the page goes on', async () => (await inPage('window.__done === 1')) === true);
			const r = await inPage('window.__r');
			await inPage('window.__done = 0');
			return r;
		};
		const opened = () => app.nextEvent('jsDialog', undefined, 10_000);
		let shown = opened();
		await run(`confirm('by hand?')`);
		await shown;
		await win('keys', { title: appName, keys: [0x0d] });
		expect(await result()).toBe(true);
		shown = opened();
		await run(`confirm('Escape?')`);
		await shown;
		await win('keys', { title: appName, keys: [0x1b] });
		expect(await result()).toBe(false);
		shown = opened();
		await run(`prompt('type', 'old')`);
		await shown;
		await Bun.sleep(300);
		const png = join(process.env.WINDOWS_SHOTS ?? tmp, 'js-dialog.png');
		await ps(`param([string]$P)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen; $i = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($i); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $i.Size); $i.Save($P)`, png);
		// The default is selected: typing replaces it.
		await win('keys', { title: appName, keys: [0x47] });
		await win('keys', { title: appName, keys: [0x4f] });
		await win('keys', { title: appName, keys: [0x0d] });
		expect(String(await result()).toLowerCase()).toBe('go');
		shown = opened();
		await run(`confirm('the button')`);
		await shown;
		await win('child-button', { title: appName, button: 'Cancel' });
		expect(await result()).toBe(false);
	}, 60_000);

	// ── media and lifecycle ─────────────────────────────────────────────────

	const wav = (() => {
		const rate = 8000, samples = rate * 2, b = new DataView(new ArrayBuffer(44 + samples));
		const put = (at: number, s: string) => [...s].forEach((c, i) => b.setUint8(at + i, c.charCodeAt(0)));
		put(0, 'RIFF'); b.setUint32(4, 36 + samples, true); put(8, 'WAVEfmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
		b.setUint32(24, rate, true); b.setUint32(28, rate, true); b.setUint16(32, 1, true); b.setUint16(34, 8, true); put(36, 'data'); b.setUint32(40, samples, true);
		for (let i = 0; i < samples; i++) b.setUint8(44 + i, 128 + 60 * Math.sin((i * 2 * Math.PI * 440) / rate));
		return Buffer.from(b.buffer).toString('base64');
	})();

	check('media: what plays and captures is reported, muted, paused; the camera and microphone follow their tracks', async () => {
		const t = { windowId: 0 };
		type State = { playback: string; audible: boolean; muted: boolean; camera: string; microphone: string };
		const media = () => wv<State>('getMediaState', t);
		expect(await media()).toEqual({ playback: 'none', audible: false, muted: false, camera: 'none', microphone: 'none' });
		const started = await inPage(`(async () => {
			const url = 'data:audio/wav;base64,${wav}';
			const inDoc = document.createElement('audio'); inDoc.src = url; inDoc.loop = true; document.body.append(inDoc);
			const loose = new Audio(url); loose.loop = true;
			const frame = document.createElement('iframe'); frame.srcdoc = '<!doctype html><audio></audio>'; document.body.append(frame);
			await new Promise((r) => { frame.onload = r; });
			const inFrame = frame.contentDocument.querySelector('audio'); inFrame.src = url; inFrame.loop = true;
			window.__a = [inDoc, loose, inFrame];
			try { await inDoc.play(); await loose.play(); await inFrame.play(); return window.__a.filter((a) => !a.paused).length; } catch (e) { return e.name + ': ' + e.message; }
		})()`);
		expect(started).toBe(3);
		try {
			expect((await media()).playback).toBe('playing');
			await Bun.sleep(1500);
			const playing = await media();
			expect(playing.audible).toBe(true);
			await wv('setAudioMuted', { ...t, muted: true });
			const muted = await media();
			expect(muted).toMatchObject({ muted: true, audible: false, playback: 'playing' });
			expect(await inPage('!window.__a[0].paused')).toBe(true); // it keeps playing
			await wv('setAudioMuted', { ...t, muted: false });
			expect((await media()).muted).toBe(false);
			await wv('pauseMedia', t);
			expect(await inPage('window.__a.map((a) => a.paused)')).toEqual([true, true, true]); // in the document, outside it, in a same-origin frame
			await until('nothing plays', async () => (await media()).playback === 'paused');
			expect((await media()).audible).toBe(false);
		} finally {
			await inPage('for (const a of window.__a ?? []) a.remove(); document.querySelectorAll("iframe").forEach((f) => f.remove()); window.__a = null; 1').catch(() => {});
		}
		const live = await inPage(`navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((s) => { window.__s = s; return s.getTracks().length; }, (e) => e.name + ': ' + e.message)`);
		expect(live).toBe(2);
		expect(await media()).toMatchObject({ camera: 'active', microphone: 'active' });
		await inPage(`window.__s.getVideoTracks()[0].enabled = false; 1`);
		expect(await media()).toMatchObject({ camera: 'muted', microphone: 'active' });
		await inPage(`for (const x of window.__s.getTracks()) x.stop(); 1`);
		expect(await media()).toMatchObject({ camera: 'none', microphone: 'none' });
	});

	check('background throttling: real timers in a hidden window, a hidden view and a minimized window', async () => {
		const start = `window.__ticks = 0; window.__timer = setInterval(() => { window.__ticks++; }, 20); 1`;
		// The engine slows a page some time after it's first hidden (about 30 s here), then at once:
		// each read is the ticks of 2 s, until they're few or it's clear they won't be.
		const slowsDown = async (read: () => Promise<number>) => {
			const samples: number[] = [];
			for (let i = 0; i < 25; i++) {
				const a = await read();
				await Bun.sleep(2000);
				samples.push((await read()) - a);
				if (samples.at(-1)! < 15) return true;
			}
			log('it never slowed down', samples.join(' '));
			return false;
		};
		const fullSpeed = async (read: () => Promise<number>) => {
			await Bun.sleep(14_000); // longer than the slowdown takes once it has started
			const a = await read();
			await Bun.sleep(2000);
			return (await read()) - a;
		};
		const ticks = () => inPage<number>('window.__ticks');
		const hide = () => op('window', 'hide', { windowId: 0 }), show = () => op('window', 'show', { windowId: 0 });
		await inPage(start);
		await hide();
		expect(await inPage('document.visibilityState')).toBe('hidden');
		expect(await slowsDown(ticks)).toBe(true);
		await show();
		await Bun.sleep(300);
		expect(await wv('setBackgroundThrottling', { windowId: 0, enabled: false })).toBeNull();
		expect((await wv('getInfo', { windowId: 0 })).backgroundThrottling).toBe(false);
		await hide();
		const full = await fullSpeed(ticks);
		await show();
		log('hidden window, throttling off, ticks in 2 s', full);
		expect(full).toBeGreaterThan(50);
		await wv('setBackgroundThrottling', { windowId: 0, enabled: true });
		expect((await wv('getInfo', { windowId: 0 })).backgroundThrottling).toBe(true);
		await hide();
		expect(await slowsDown(ticks)).toBe(true);
		await show();
		await Bun.sleep(300);

		// Minimized counts as hidden.
		await op('window', 'minimize', { windowId: 0 });
		expect(await inPage('document.visibilityState')).toBe('hidden');
		expect(await slowsDown(ticks)).toBe(true);
		await op('window', 'restore', { windowId: 0 });
		await inPage(`clearInterval(window.__timer); 1`);

		await openView('e2e-idle', `${site}/start`);
		try {
			const inIdle = () => inView<number>('e2e-idle', 'window.__ticks');
			await inView('e2e-idle', start);
			await op('view', 'hide', { id: 'e2e-idle' });
			expect(await slowsDown(inIdle)).toBe(true);
			await op('view', 'show', { id: 'e2e-idle' });
			await wv('setBackgroundThrottling', { viewId: 'e2e-idle', enabled: false });
			await op('view', 'hide', { id: 'e2e-idle' });
			const hiddenView = await fullSpeed(inIdle);
			log('hidden view, throttling off, ticks in 2 s', hiddenView);
			expect(hiddenView).toBeGreaterThan(50);
		} finally {
			await closeView('e2e-idle');
		}
	}, 300_000);

	check('recovery: a real render-process crash; reloaded by default, left stopped when manual', async () => {
		const loads = () => hits.get('/crash') ?? 0;
		await openView('e2e-crash', `${site}/crash`);
		const t = { viewId: 'e2e-crash' };
		try {
			expect(await code('webview', 'setRecovery', { ...t, recovery: 'nope' })).toBe('invalid_args');
			const live = () => inView('e2e-crash', '1 + 1', 2000).catch(() => null);
			let baseline = loads();
			let terminated = app.nextEvent<any>('webviewLifecycle', (e) => e.viewId === 'e2e-crash', 15_000);
			expect(await wv('_terminateForTesting', t)).toBeNull();
			let e = await terminated;
			expect(e).toMatchObject({ type: 'terminated', viewId: 'e2e-crash', windowId: 0, recovery: 'reload', reason: 'unknown', navigationId: null, url: `${site}/crash`, gaveUp: false });
			await until('reloaded: a new request, a live page', async () => loads() === baseline + 1 && (await live()) === 2, 15_000);

			await wv('setRecovery', { ...t, recovery: 'manual' });
			expect((await wv('getInfo', t)).recovery).toBe('manual');
			baseline = loads();
			terminated = app.nextEvent<any>('webviewLifecycle', (x) => x.viewId === 'e2e-crash', 15_000);
			await wv('_terminateForTesting', t);
			e = await terminated;
			expect(e.recovery).toBe('manual');
			expect('gaveUp' in e).toBe(false);
			await Bun.sleep(2500);
			expect(loads()).toBe(baseline); // stays stopped
			await wv('reload', t);
			await until('reload brings it back', async () => loads() === baseline + 1 && (await live()) === 2, 15_000);
		} finally {
			await closeView('e2e-crash');
		}
	}, 90_000);

	// ── file drop ───────────────────────────────────────────────────────────

	check('file drop: a real drag from another process: enter, drop with real paths, leave, off, frames, views', async () => {
		const a = join(realpathSync.native(tmp), 'dropped one.txt'), b = join(realpathSync.native(tmp), 'dropped-two.txt');
		writeFileSync(a, 'one');
		writeFileSync(b, 'two');
		const paths = [a, b];
		const lowered = (list: string[]) => list.map((p) => p.toLowerCase());
		await op('window', 'show', { windowId: 0 });
		await op('window', 'setBounds', { windowId: 0, x: 300, y: 60, width: 900, height: 650 });
		const rect = JSON.parse(await win('rect', { title: 'E2E web window' })) as { x: number; y: number };
		const target = { x: rect.x + 450, y: rect.y + 320 };
		await inPage(`window.__drops = []; window.__cover = document.createElement('div'); __cover.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#eef'; document.body.append(__cover);
			addEventListener('dragover', (e) => e.preventDefault()); addEventListener('drop', (e) => { e.preventDefault(); window.__drops.push({ names: [...e.dataTransfer.files].map((f) => f.name), x: e.clientX, y: e.clientY }); }); 1`);
		const dom = () => inPage<Array<{ names: string[]; x: number; y: number }>>('window.__drops');
		type Drop = { paths: string[]; x: number; y: number; windowId?: number; viewId?: string };
		const events = () => ({ entered: app.nextEvent<Drop>('fileDragEnter', undefined, 25_000), dropped: app.nextEvent<Drop>('fileDrop', undefined, 25_000) });

		let { entered, dropped } = events();
		await fileDrag({ paths, ...target });
		const enter = await entered, drop = await dropped;
		expect(enter.windowId).toBe(0);
		expect(enter.paths).toEqual([]); // not known before the drop: see README
		expect(drop.windowId).toBe(0);
		expect(lowered(drop.paths)).toEqual(lowered(paths));
		const page = (await dom())[0]!;
		expect(page.names).toEqual(['dropped one.txt', 'dropped-two.txt']); // the page still gets its DOM drop
		expect(drop.x).toBe(page.x);
		expect(drop.y).toBe(page.y);
		expect(enter.x).toBeGreaterThanOrEqual(0);
		expect(enter.x).toBeLessThanOrEqual(page.x);

		// Dragged in and back out: a leave, and no drop.
		entered = app.nextEvent<Drop>('fileDragEnter', undefined, 25_000);
		const left = app.nextEvent<Record<string, unknown>>('fileDragLeave', undefined, 25_000);
		let noDrop = none('fileDrop', 9000);
		await fileDrag({ paths, ...target, leave: true });
		await entered;
		const leave = await left;
		expect(leave.windowId).toBe(0);
		expect('paths' in leave).toBe(false);
		expect(await noDrop).toBe(true);
		expect((await dom()).length).toBe(1);

		// A page can't forge one: not with a synthetic event, not with the bridge's message.
		noDrop = none('fileDrop', 800);
		await inPage(`(() => { const d = new DataTransfer(); d.items.add(new File(['x'], 'x.txt')); window.dispatchEvent(new DragEvent('drop', { dataTransfer: d })); chrome.webview.postMessage(':["drop",1,1]'); })(); 1`);
		expect(await noDrop).toBe(true);

		// Off: no native events; the page's own drop still works.
		expect(await code('webview', 'setFileDrop', {})).toBe('invalid_args');
		expect(await wv('setFileDrop', { windowId: 0, enabled: false })).toEqual({ enabled: false });
		expect((await wv('getInfo', { windowId: 0 })).fileDrop).toBe(false);
		const quiet = [none('fileDragEnter', 9000), none('fileDrop', 9000)];
		const dropsBefore = (await dom()).length;
		await fileDrag({ paths, ...target });
		expect(await Promise.all(quiet)).toEqual([true, true]);
		expect((await dom()).length).toBe(dropsBefore + 1);
		expect(await wv('setFileDrop', { enabled: true, all: true })).toEqual({ enabled: true });
		({ entered, dropped } = events());
		await fileDrag({ paths, ...target });
		await entered;
		expect(lowered((await dropped).paths)).toEqual(lowered(paths));

		// A page that doesn't take the drag: the event is the same, and it stays where it is.
		await inPage(`window.__cover.remove(); 1`);
		const path = await inPage<string>('location.pathname');
		await openView('e2e-drop', `${site}/start`, { x: 40, y: 40, width: 700, height: 500 });
		try {
			// On its way the drag crosses the window's own page, which gets its enter and leave.
			const inView_ = (e: Drop) => e.viewId === 'e2e-drop';
			entered = app.nextEvent<Drop>('fileDragEnter', inView_, 25_000);
			dropped = app.nextEvent<Drop>('fileDrop', inView_, 25_000);
			const windowLeft = app.nextEvent<Drop>('fileDragLeave', (e) => e.windowId === 0 && !e.viewId, 25_000);
			await fileDrag({ paths, ...target });
			await entered;
			await windowLeft;
			const inPlain = await dropped;
			expect(inPlain).toMatchObject({ viewId: 'e2e-drop', windowId: 0 });
			expect(lowered(inPlain.paths)).toEqual(lowered(paths));
			await Bun.sleep(500);
			expect(await inView('e2e-drop', 'location.pathname')).toBe('/start');

			// Over a frame of another site: the same events, at the page's coordinates.
			await go('e2e-drop', `${site}/page-with-frame`);
			await until('the frame is there', async () => (await inView<number>('e2e-drop', 'document.querySelector("iframe").getBoundingClientRect().width')) > 100);
			await Bun.sleep(1000);
			entered = app.nextEvent<Drop>('fileDragEnter', inView_, 25_000);
			dropped = app.nextEvent<Drop>('fileDrop', inView_, 25_000);
			await fileDrag({ paths, ...target });
			await entered;
			const inFrame = await dropped;
			expect(lowered(inFrame.paths)).toEqual(lowered(paths));
			expect(Math.abs(inFrame.x - inPlain.x)).toBeLessThan(6);
			expect(Math.abs(inFrame.y - inPlain.y)).toBeLessThan(6);
		} finally {
			await closeView('e2e-drop');
		}
		expect(await inPage('location.pathname')).toBe(path);
	}, 170_000);

	// ── clearData ───────────────────────────────────────────────────────────

	check('clearData: real values, kind by kind; the app\'s stay unless asked, its cookies always', async () => {
		const js = <T = any>(code: string) => inView<T>('e2e-data', code);
		const reload = async () => go('e2e-data', `${site}/page?${Date.now()}`);
		await openView('e2e-data', `${site}/page`);
		const fill = () => js(`(async () => {
			localStorage.setItem('kept', 'local');
			sessionStorage.setItem('kept', 'session');
			await fetch('/set-cookie');
			await new Promise((resolve, reject) => {
				const open = indexedDB.open('kitop', 1);
				open.onupgradeneeded = () => open.result.createObjectStore('s');
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const tx = open.result.transaction('s', 'readwrite');
					tx.objectStore('s').put('value', 'k');
					tx.oncomplete = () => { open.result.close(); resolve(1); };
				};
			});
			await caches.open('kitop').then((c) => c.put('/in-cache', new Response('x')));
			await navigator.serviceWorker.register('/sw.js').then((r) => new Promise((resolve) => {
				const w = r.installing || r.waiting || r.active;
				if (w.state === 'activated') return resolve(1);
				w.addEventListener('statechange', () => w.state === 'activated' && resolve(1));
			}));
			return 1;
		})()`);
		const state = async () => {
			const page = await js(`(async () => ({
				local: localStorage.getItem('kept'),
				session: sessionStorage.getItem('kept'),
				idb: await new Promise((resolve) => {
					const open = indexedDB.open('kitop', 1);
					open.onupgradeneeded = () => open.result.createObjectStore('s');
					open.onsuccess = () => {
						const get = open.result.transaction('s').objectStore('s').get('k');
						get.onsuccess = () => { open.result.close(); resolve(get.result ?? null); };
					};
				}),
				cache: await caches.has('kitop'),
				sw: (await navigator.serviceWorker.getRegistrations()).length,
			}))()`);
			await js(`fetch('/see-cookie').then(() => 1)`);
			return { ...page, cookie: seen.get('/see-cookie') ?? null };
		};
		const cachedOnce = async (path: string) => {
			await js(`fetch('${path}').then(() => 1)`);
			await js(`fetch('${path}').then(() => 1)`);
			await Bun.sleep(1000);
			return hits.get(path) === 1;
		};
		const askedAgain = async (path: string) => {
			await js(`fetch('${path}').then(() => 1)`);
			return hits.get(path) === 2;
		};
		const clear = (types: string[], extra: object = {}) => wv<{ cleared: string[] }>('clearData', { types, ...extra }, 30_000);
		try {
			expect(await code('webview', 'clearData', { types: ['nonsense'] })).toBe('invalid_args');
			expect(await fill()).toBe(1);
			await inPage(`localStorage.setItem('app', 'mine'); sessionStorage.setItem('app', 'mine'); document.cookie = 'app=session; path=/; max-age=3600'; 1`);
			await reload();
			const filled = await state();
			expect(filled).toMatchObject({ local: 'local', session: 'session', idb: 'value', cache: true, sw: 1 });
			expect(filled.cookie).toContain('server=side');

			let reply = await clear(['localStorage']);
			expect(reply.cleared).toContain('127.0.0.2');
			expect(reply.cleared).not.toContain('127.0.0.1');
			await reload();
			let now = await state();
			expect(now.local).toBeNull();
			expect(now.session).toBeNull(); // the engine clears a site's localStorage and sessionStorage together
			expect(now).toMatchObject({ idb: 'value', cache: true, sw: 1 });
			expect(now.cookie).toContain('server=side');
			expect(await inPage(`localStorage.getItem('app')`)).toBe('mine');

			await clear(['cookies']);
			await reload();
			now = await state();
			expect(now.cookie ?? '').not.toContain('server=side');
			expect(now.idb).toBe('value');
			expect(await inPage('document.cookie')).toContain('app=session');

			await clear(['indexedDB']);
			await reload();
			now = await state();
			expect(now.idb).toBeNull();
			expect(now.cache).toBe(true);

			await clear(['serviceWorkers']);
			await reload();
			now = await state();
			expect(now.sw).toBe(0);
			expect(now.cache).toBe(true);

			expect(await cachedOnce('/cached-one')).toBe(true);
			await clear(['cache']);
			await reload();
			now = await state();
			expect(now.cache).toBe(false);
			expect(await askedAgain('/cached-one')).toBe(true);

			await js(`sessionStorage.setItem('kept', 'session'); localStorage.setItem('kept', 'local'); 1`);
			reply = await clear(['sessionStorage']);
			expect(await js(`sessionStorage.getItem('kept')`)).toBeNull();
			expect(await js(`localStorage.getItem('kept')`)).toBe('local');
			expect(await inPage(`sessionStorage.getItem('app')`)).toBe('mine');

			// Everything at once, the default.
			expect(await cachedOnce('/cached-two')).toBe(true); // before a service worker comes between
			expect(await fill()).toBe(1);
			await reload();
			reply = await wv('clearData', {}, 30_000);
			expect(reply.cleared).toContain('127.0.0.2');
			await reload();
			now = await state();
			expect(now).toMatchObject({ local: null, session: null, idb: null, cache: false, sw: 0 });
			expect(now.cookie ?? '').not.toContain('server=side');
			expect(await askedAgain('/cached-two')).toBe(true);
			expect(await inPage(`localStorage.getItem('app')`)).toBe('mine');
			expect(await inPage('document.cookie')).toContain('app=session');

			// `app`: its storage too, its cookies never. One kind: only that kind.
			await inPage(`caches.open('kitop').then(() => 1)`);
			await clear(['cache'], { app: true });
			expect(await inPage(`caches.has('kitop')`)).toBe(false);
			expect(await inPage(`localStorage.getItem('app')`)).toBe('mine');
			await js(`localStorage.setItem('kept', 'local'); 1`);
			reply = await wv('clearData', { types: ['all'], app: true }, 30_000);
			expect(reply.cleared).toContain('127.0.0.1');
			expect(await inPage(`localStorage.getItem('app')`)).toBeNull();
			expect(await inPage(`sessionStorage.getItem('app')`)).toBeNull();
			expect(await inPage('document.cookie')).toContain('app=session');
			expect(await js(`localStorage.getItem('kept')`)).toBeNull(); // every site's, whatever the record
		} finally {
			await closeView('e2e-data');
		}
	}, 150_000);
});
