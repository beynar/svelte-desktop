// OAuth sign-in for a desktop app (RFC 8252): the provider's page opens in the system browser — not a
// web view, which providers refuse and users can't trust —, the browser comes back to the app (a
// loopback URL on the app's own server, or one of its URL schemes), and the page gets the code, with
// `state` (and `iss`, when given) checked and a PKCE verifier to exchange it.
//
//   const { code, codeVerifier, redirectUri } = await host.oauth.authorize({
//     url: 'https://github.com/login/oauth/authorize',
//     params: { client_id: 'Iv1.abc', scope: 'read:user' },
//   });
//   const tokens = await host.oauth.exchange({ url: 'https://github.com/login/oauth/access_token', clientId: 'Iv1.abc', code, codeVerifier, redirectUri });
import { callPlatform, onPlatform, platformReady } from './bus';

export type AuthorizeOptions = {
	/** The provider's authorization endpoint. */
	url: string;
	/** Its parameters: client_id, scope… `response_type`, `redirect_uri`, `state` and the PKCE
	 *  challenge are the helper's: given here, they're overridden. */
	params?: Record<string, string>;
	/** Where the browser comes back: 'loopback' (default: http://127.0.0.1:<port>/__desktop/oauth/callback
	 *  on the app's own server, any port — RFC 8252 §7.3) or one of the app's URL schemes (`schemes`
	 *  in desktop.config, the built app only): `<scheme>:/<path>`. */
	redirect?: 'loopback' | { scheme: string; path?: string };
	/** The provider's issuer identifier: the callback's `iss` (RFC 9207) must be it. With several
	 *  providers, give it — it tells their callbacks apart (a mix-up defense). */
	issuer?: string;
	/** Refuse a callback without `iss` (for a provider that sends it). Default: true when `issuer` is set. */
	requireIssuer?: boolean;
	/** PKCE (S256). Default true: turn it off only for a provider that rejects it. */
	pkce?: boolean;
	/** How long the whole sign-in may take, browser included. Default 5 minutes. */
	timeoutMs?: number;
	signal?: AbortSignal;
};

export type AuthorizeResult = {
	code: string;
	state: string;
	/** PKCE verifier: send it with the code to the token endpoint. */
	codeVerifier?: string;
	/** The redirect_uri sent: the token endpoint wants the same one. */
	redirectUri: string;
	/** Everything the provider sent back. */
	params: Record<string, string>;
};

/** A sign-in that didn't complete: `code` is the provider's error (`access_denied`…), `state_mismatch`,
 *  `issuer_mismatch`, `timeout`, `aborted`, `server_error` or `invalid_response`. */
export class OAuthError extends Error {
	constructor(
		readonly code: string,
		message?: string,
	) {
		super(message ?? code);
		this.name = 'OAuthError';
	}
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (n: number) => base64url(crypto.getRandomValues(new Uint8Array(n)));

async function openInBrowser(url: string) {
	if (platformReady()) await callPlatform('shell', 'openExternal', { url });
	else window.open(url, '_blank', 'noopener'); // the app in a browser (dev without the window)
}

/** Back to the app once the browser is done with the sign-in. */
function bringBack() {
	if (!platformReady()) return;
	void callPlatform('app', 'show').catch(() => {});
	void callPlatform('window', 'focus').catch(() => {});
}

/** `scheme:/path` (RFC 8252 §7.1), the scheme lowercase. */
function schemeRedirect(scheme: string, path = 'oauth/callback'): string {
	if (!/^[a-z][a-z0-9+.-]*$/i.test(scheme)) throw new OAuthError('invalid_request', `"${scheme}" isn't a URL scheme`);
	return `${scheme.toLowerCase()}:/${path.replace(/^\/+/, '')}`;
}

/** The same redirect URI, the scheme compared without case (`com.Example.App:/x` is `com.example.app:/x`). */
function sameRedirect(url: string, redirectUri: string): boolean {
	try {
		const a = new URL(url), b = new URL(redirectUri);
		return a.protocol.toLowerCase() === b.protocol.toLowerCase() && a.host === b.host && a.pathname.replace(/^\/+/, '/') === b.pathname.replace(/^\/+/, '/');
	} catch {
		return false;
	}
}

/** Sign in with a provider in the system browser; resolves to the authorization code. */
export async function authorize(options: AuthorizeOptions): Promise<AuthorizeResult> {
	if (options.signal?.aborted) throw new OAuthError('aborted', 'the sign-in was cancelled');
	const timeoutMs = options.timeoutMs ?? 5 * 60_000;
	// One owner for everything this sign-in holds: aborted on settle, cancel or deadline.
	const life = new AbortController();
	const cleanups: Array<() => void> = [() => life.abort()];
	let failure: OAuthError | null = null;
	let succeeded = false;
	const stop = (e: OAuthError) => {
		failure ??= e;
		life.abort();
	};
	const onAbort = () => stop(new OAuthError('aborted', 'the sign-in was cancelled'));
	options.signal?.addEventListener('abort', onAbort, { once: true });
	cleanups.push(() => options.signal?.removeEventListener('abort', onAbort));
	const timer = setTimeout(() => stop(new OAuthError('timeout', 'the sign-in took too long')), timeoutMs);
	cleanups.push(() => clearTimeout(timer));
	// Rejects as soon as the sign-in is given up, whatever step it's at.
	const gaveUp = new Promise<never>((_, reject) => life.signal.addEventListener('abort', () => reject(failure ?? new OAuthError('aborted')), { once: true }));
	gaveUp.catch(() => {});
	const step = <T>(p: Promise<T>) => Promise.race([p, gaveUp]);

	try {
		const state = random(32);
		const codeVerifier = options.pkce === false ? undefined : random(32); // 43 chars, base64url
		const challenge = codeVerifier && base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))));

		let redirectUri: string;
		let callback: Promise<Record<string, string>>;
		if (options.redirect && options.redirect !== 'loopback') {
			// One of the app's URL schemes: the deep link to exactly this redirect URI, with our state.
			redirectUri = schemeRedirect(options.redirect.scheme, options.redirect.path);
			callback = new Promise((resolve) => {
				const off = onPlatform<{ urls?: string[] }>('openUrls', (e) => {
					for (const u of e?.urls ?? []) {
						if (!sameRedirect(u, redirectUri)) continue;
						const params = Object.fromEntries(new URL(u).searchParams);
						if (params.state === state) return void resolve(params);
					}
				});
				cleanups.push(off);
			});
		} else {
			// Loopback: the app's server matches the callback to this sign-in by its state.
			const start = await step(fetch('/__desktop/oauth/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state, timeoutMs }), signal: life.signal }));
			if (!start.ok) throw new OAuthError('server_error', `the app's server didn't start the sign-in (${start.status})`);
			const { id, path } = (await start.json()) as { id: string; path: string };
			redirectUri = `${location.origin}${path}`;
			// Given up (cancel, timeout, an error): the server forgets the sign-in and its state.
			cleanups.push(() => void (succeeded || fetch('/__desktop/oauth/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }), keepalive: true }).catch(() => {})));
			callback = fetch(`/__desktop/oauth/wait/${id}`, { signal: life.signal }).then(async (r) => {
				if (r.status === 408) throw new OAuthError('timeout', 'the sign-in took too long');
				if (!r.ok) throw new OAuthError('server_error', `the app's server lost the sign-in (${r.status})`);
				return ((await r.json()) as { params: Record<string, string> }).params;
			});
		}
		callback.catch(() => {}); // handled below; never an unhandled rejection meanwhile

		const url = new URL(options.url);
		for (const [k, v] of Object.entries(options.params ?? {})) url.searchParams.set(k, v);
		// The protocol's own fields, after the caller's: they can't be overridden.
		url.searchParams.set('response_type', 'code');
		url.searchParams.set('redirect_uri', redirectUri);
		url.searchParams.set('state', state);
		if (challenge) {
			url.searchParams.set('code_challenge', challenge);
			url.searchParams.set('code_challenge_method', 'S256');
		} else {
			url.searchParams.delete('code_challenge');
			url.searchParams.delete('code_challenge_method');
		}
		await step(openInBrowser(url.href));

		const params = await step(callback);
		bringBack();
		if (params.state !== state) throw new OAuthError('state_mismatch', 'the sign-in came back with another state');
		if (options.issuer !== undefined) {
			if (params.iss !== undefined ? params.iss !== options.issuer : (options.requireIssuer ?? true))
				throw new OAuthError('issuer_mismatch', `the sign-in came back from another issuer (${params.iss ?? 'none'})`);
		}
		if (params.error) throw new OAuthError(params.error, params.error_description ?? params.error);
		if (!params.code) throw new OAuthError('no_code', 'the provider sent no code');
		succeeded = true;
		return { code: params.code, state, codeVerifier, redirectUri, params };
	} catch (e) {
		if (failure) throw failure;
		if (e instanceof OAuthError) throw e;
		throw new OAuthError('server_error', (e as Error)?.message ?? String(e));
	} finally {
		for (const c of cleanups.reverse()) c();
	}
}

export type ExchangeOptions = {
	/** The provider's token endpoint. */
	url: string;
	clientId: string;
	code: string;
	codeVerifier?: string;
	redirectUri: string;
	/** Only from server code: a secret never goes in the page. */
	clientSecret?: string;
	/** Extra form fields. */
	params?: Record<string, string>;
	signal?: AbortSignal;
};

/** Trade the code for tokens (the provider's answer: access_token, refresh_token, expires_in…).
 *  Many token endpoints refuse a browser's cross-origin request, and a client secret must not reach
 *  the page: call it from server code (a remote function) where you can. */
export async function exchange(options: ExchangeOptions): Promise<Record<string, unknown>> {
	const body = new URLSearchParams(options.params ?? {});
	// The protocol's own fields, after the extras.
	body.set('grant_type', 'authorization_code');
	body.set('code', options.code);
	body.set('redirect_uri', options.redirectUri);
	body.set('client_id', options.clientId);
	if (options.codeVerifier) body.set('code_verifier', options.codeVerifier);
	if (options.clientSecret) body.set('client_secret', options.clientSecret);
	// No redirects: the code, the verifier and a secret go to this endpoint only.
	const res = await fetch(options.url, { method: 'POST', redirect: 'error', signal: options.signal, headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body }).catch((e) => {
		throw new OAuthError('server_error', `the token endpoint didn't answer (${(e as Error).message})`);
	});
	const text = await res.text();
	const type = res.headers.get('content-type') ?? '';
	let data: unknown = null;
	if (/json/i.test(type) || /^\s*[{[]/.test(text)) {
		try {
			data = JSON.parse(text);
		} catch {}
	} else if (/x-www-form-urlencoded|text\/plain/i.test(type)) data = Object.fromEntries(new URLSearchParams(text)); // some providers answer form-encoded
	const record = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
	if (record?.error) throw new OAuthError(String(record.error), String(record.error_description ?? record.error));
	if (!res.ok) throw new OAuthError(`http_${res.status}`, `the token endpoint answered ${res.status}`);
	if (!record || typeof record.access_token !== 'string' || !record.access_token) throw new OAuthError('invalid_response', 'the token endpoint sent no access_token');
	return record;
}

export const oauth = { authorize, exchange, OAuthError };
