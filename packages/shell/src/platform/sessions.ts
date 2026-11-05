import { callPlatform, onPlatform } from './bus';

let watchers = 0; // onChanged subscribers in this page

export type SessionInfo = { id: string; persistent: boolean };
export type SessionCookie = {
	name: string;
	value: string;
	domain: string;
	path: string;
	secure: boolean;
	httpOnly: boolean;
	sessionOnly: boolean;
	/** Seconds since the Unix epoch; omitted for session cookies. */
	expires?: number;
	sameSite?: 'Lax' | 'Strict' | 'None';
};
export type CookieFilter = { session?: string; url?: string; name?: string };
export type CookieSetOptions = {
	session?: string;
	url: string;
	name: string;
	value: string;
	domain?: string;
	path?: string;
	secure?: boolean;
	httpOnly?: boolean;
	expires?: number;
	sameSite?: 'Lax' | 'Strict' | 'None';
};
export type CookieChangedEvent = { session: string; cookie: SessionCookie; removed: boolean };
export type SessionProxy = {
	type: 'http' | 'socks';
	host: string;
	port: number;
	username?: string;
	password?: string;
	/** TLS to an HTTP CONNECT proxy; unsupported for SOCKS. */
	tls?: boolean;
};
export type SessionProxyInfo = Pick<SessionProxy, 'type' | 'host' | 'port'> & { tls: boolean; authenticated: boolean };
export type SessionCapabilities = {
	private: boolean;
	persistentNamed: boolean;
	proxy: boolean;
	proxyAuthentication: boolean;
	pac: boolean;
	customBypass: boolean;
};

/** Website profiles: macOS. On Windows, the default profile's cookies. The default profile belongs to the shell. */
export const sessions = {
	create: (options: { id: string; persistent: boolean }) => callPlatform<SessionInfo>('sessions', 'create', options),
	list: () => callPlatform<SessionInfo[]>('sessions', 'list'),
	/** Close all referencing windows, views and popovers first. Deletes persistent profile data. */
	remove: (id: string) => callPlatform<null>('sessions', 'remove', { session: id }),
	setProxy: (id: string, proxy: SessionProxy | null) => callPlatform<null>('sessions', 'setProxy', { session: id, proxy }),
	/** Host-owned configuration; credentials are never returned. Null means system defaults. */
	getProxy: (id = 'default') => callPlatform<SessionProxyInfo | null>('sessions', 'getProxy', { session: id }),
	capabilities: () => callPlatform<SessionCapabilities>('sessions', 'capabilities'),
	cookies: {
		get: (filter: CookieFilter = {}) => callPlatform<SessionCookie[]>('sessions', 'cookiesGet', filter),
		set: (options: CookieSetOptions) => callPlatform<null>('sessions', 'cookiesSet', options),
		/** Deletes all cookies matching the URL and name, across applicable paths. */
		remove: (options: { session?: string; url: string; name: string }) => callPlatform<{ removed: number }>('sessions', 'cookiesRemove', options),
		/** WebKit reports changes in batches; short-lived intermediate values can be coalesced. */
		onChanged: (cb: (event: CookieChangedEvent) => void) => {
			// The native side watches cookies only while someone listens.
			if (watchers++ === 0) void callPlatform('sessions', 'watchCookies', { enabled: true }).catch(() => {});
			const off = onPlatform('sessionCookieChanged', cb);
			let done = false;
			return () => {
				if (done) return;
				done = true;
				off();
				if (--watchers === 0) void callPlatform('sessions', 'watchCookies', { enabled: false }).catch(() => {});
			};
		},
	},
};
