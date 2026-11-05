// Local-only test services. A fresh self-signed key is generated per app run and never shipped.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { webview } from '@kitop/shell/platform';

type Servers = { http: ReturnType<typeof Bun.serve>; https?: ReturnType<typeof Bun.serve>; fingerprint: string; tlsError: string };
let starting: Promise<Servers> | undefined;
let mode = 'default';
const requests: Array<{ origin: string; permission: string; viewId?: string }> = [];
const page = (body: string) => new Response(`<!doctype html><meta charset="utf-8"><title>Web security probe</title><body>${body}</body>`, { headers: { 'content-type': 'text/html' } });
function start(): Servers {
	const http = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
		if (new URL(req.url).pathname === '/basic') {
			if (req.headers.get('authorization') !== `Basic ${btoa('dashboard:probe')}`)
				return new Response('Authentication required', { status: 401, headers: { 'www-authenticate': 'Basic realm="Dashboard probe"' } });
			return page('Basic auth accepted');
		}
		return page('<h1>Third-party origin</h1><p>Permission is requested explicitly by the probe; this page has no native bridge.</p>');
	} });
	return { http, fingerprint: '', tlsError: '' };
}
async function initialize() {
	const servers = start();
	if (process.platform !== 'darwin') return servers;
	const directory = await mkdtemp(join(tmpdir(), 'dashboard-web-policy-'));
	try {
		const certPath = join(directory, 'cert.pem'), keyPath = join(directory, 'key.pem');
		const proc = Bun.spawn(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', keyPath, '-out', certPath], { stdout: 'ignore', stderr: 'ignore' });
		if (await proc.exited !== 0) throw new Error('Could not generate the local TLS fixture');
		const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
		servers.fingerprint = new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase();
		servers.https = Bun.serve({ hostname: '127.0.0.1', port: 0, tls: { cert, key }, fetch: () => page('Exact certificate accepted') });
	} catch (error) { servers.tlsError = (error as Error).message; }
	finally { await rm(directory, { recursive: true, force: true }); }
	return servers;
}
// One native policy owner per process. Loading this module does not install a policy.
export async function webSecurityDemo(action = 'status') {
	const servers = await (starting ??= initialize());
	const http = `http://127.0.0.1:${servers.http.port}`;
	const https = servers.https ? `https://127.0.0.1:${servers.https.port}` : '';
	if (action !== 'status') {
		if (!['default', 'handler', 'timeout', 'trust', 'untrust', 'trust-handler', 'delayed'].includes(action)) throw new Error('Unknown web-security demo action');
		if (action === 'trust-handler') {
			await webview.onAuthChallenge(async (challenge) => {
				if (challenge.origin !== https || challenge.method !== 'serverTrust' || challenge.fingerprint !== servers.fingerprint) return 'cancel';
				await webview.allowCertificate({ host: challenge.host, fingerprint: servers.fingerprint });
				return 'default';
			});
		} else if (action === 'trust' || action === 'untrust') {
			if (!https) throw new Error(servers.tlsError);
			await webview[action === 'trust' ? 'allowCertificate' : 'revokeCertificate']({ host: '127.0.0.1', fingerprint: servers.fingerprint });
		} else {
			mode = action;
			await webview.setPermissionHandler(action === 'default' ? null : async (request) => {
				requests.push({ origin: request.origin, permission: request.permission, viewId: request.viewId });
				if (mode === 'timeout') return await new Promise<never>(() => {});
				if (mode === 'delayed') await Bun.sleep(300);
				return request.origin === http ? 'allow' : 'deny';
			}, { timeoutMs: action === 'timeout' ? 150 : 15000 });
			await webview.onAuthChallenge(action === 'default' ? null : async ({ origin, realm, method, previousFailures }) =>
				origin === http && method === 'basic' && realm === 'Dashboard probe' && previousFailures === 0
					? { username: 'dashboard', password: 'probe' } : 'cancel');
		}
	}
	return { http, https, fingerprint: servers.fingerprint, tlsError: servers.tlsError, mode, requests };
}
