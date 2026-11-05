/**
 * In-process SvelteKit semantics for the native stack.
 *
 * Mirrors the kit contract — page/navigating state, load chains
 * (layout.server → layout → page.server → page), goto/invalidate/depends,
 * handle/handleFetch/handleError/reroute/transport hooks, redirect/error/fail
 * control flow, form actions, +server.ts endpoints, preload/pushState —
 * without HTTP or a URL bar. "Server" loads run through hooks.handle and may
 * touch Bun APIs; universal loads see `event.data` + `parent()`.
 *
 * Rendering is done by Shell.svelte reading `router.levels`.
 */
import { onDestroy } from 'svelte';
import { AsyncLocalStorage } from 'node:async_hooks';

// ── thrown-object control flow (same protocol as @sveltejs/kit) ────────────
const REDIRECT = Symbol('kit.redirect');
const HTTP_ERROR = Symbol('kit.error');
const FAIL = Symbol('kit.fail');
const INVALID = Symbol('kit.invalid');

export function redirect(status, location) {
	if (status < 300 || status > 308) throw new Error('invalid redirect status');
	throw { [REDIRECT]: true, status, location };
}
export function error(status, body) {
	throw { [HTTP_ERROR]: true, status, body: typeof body === 'string' ? { message: body } : body };
}
export const isRedirect = (e) => !!e?.[REDIRECT];
export const isHttpError = (e) => !!e?.[HTTP_ERROR];
export function fail(status, data) {
	return { [FAIL]: true, status, data };
}
export const isActionFailure = (r) => !!r?.[FAIL];

/** kit `invalid` — remote-fn validation failure (throws; collected issues). */
export function invalid(messageOrField, maybeMessage) {
	throw {
		[INVALID]: true,
		field: maybeMessage === undefined ? null : messageOrField,
		message: maybeMessage ?? messageOrField,
	};
}
export const isInvalidError = (e) => !!e?.[INVALID];

// ── $app/environment ────────────────────────────────────────────────────────
export const browser = true; // we ARE the client runtime — just not a browser DOM
export const building = false;
export const dev = true;
export const version = 'dev';

// ── $app/paths ──────────────────────────────────────────────────────────────
export const base = '';
export const assets = '';

/** kit `asset('/file.png')` — assets-prefixed path. */
export const asset = (file) => `${assets}/${String(file).replace(/^\/+/, '')}`;

// ── @sveltejs/kit response helpers ─────────────────────────────────────────
export const json = (data, init) => Response.json(data, init);
export const text = (body, init) => new Response(body, init);

// ── current request-event scope ($app/server getRequestEvent) ──────────────
// ALS so the event survives `await` inside loads/actions/endpoints/remote
// functions — including inside handle/handleFetch/handleError themselves.
const __als = new AsyncLocalStorage();
export function getRequestEvent() {
	const e = __als.getStore();
	if (!e) throw new Error('getRequestEvent() called outside a request context');
	return e;
}

/** kit `resolve('/item/[id]', {id:'7'})` → '/item/7'. Handles embedded params
 *  (`/file-[name].json`), rest/optional/matcher syntax, (group) stripping,
 *  and query/hash passthrough. Non-'/' args pass through unchanged. */
export function resolve(route, params = {}) {
	if (!String(route).startsWith('/')) return String(route);
	const m = /^([^?#]*)(.*)$/.exec(String(route));
	const pathPart = m[1];
	const suffix = m[2] ?? '';
	const out = [];
	for (const seg of pathPart.split('/')) {
		if (/^\(.*\)$/.test(seg)) continue; // strip (groups)
		const wholeOpt = /^\[\[\.\.\.(\w+)(?:=\w+)?\]\]$|^\[\[(\w+)(?:=\w+)?\]\]$/.exec(seg);
		const substitute = (s) =>
			s.replace(/\[\[?\.\.\.(\w+)(?:=\w+)?\]\]?|\[\[?(\w+)(?:=\w+)?\]\]?/g, (_mm, rest, named) => {
				const name = rest ?? named;
				const v = params[name];
				if (v === undefined || v === null) {
					if (seg.startsWith('[[')) return '';
					throw new Error(`resolve('${route}'): missing param '${name}'`);
				}
				const sv = String(v);
				if (sv.startsWith('/') || sv.endsWith('/'))
					throw new Error(`resolve('${route}'): param '${name}' cannot start or end with '/'`);
				return sv;
			});
		if (wholeOpt) {
			const name = wholeOpt[1] ?? wholeOpt[2];
			if (params[name] !== undefined && params[name] !== null) out.push(substitute(seg));
			continue; // absent optional → drop the segment
		}
		out.push(substitute(seg));
	}
	return out.join('/') + suffix || '/' + suffix;
}

// ── reactive navigation state ($app/state equivalents) ─────────────────────

// url stays an href string — a $state-proxied URL breaks .search/.pathname
// (internal slots don't survive the proxy). The facade caches ONE real URL
// per href so identity comparisons (`page.url === page.url`) hold, like kit.
const _page = $state({
	href: 'app://svelte.local/',
	params: {},
	route: { id: '/' },
	data: {},
	form: null,
	state: {},
	shallow: null,
	status: 200,
	error: null,
});
let _urlCache = null;
function currentUrl() {
	if (!_urlCache || _urlCache.href !== _page.href) _urlCache = new URL(_page.href);
	return _urlCache;
}
export const page = {
	get url() {
		return currentUrl();
	},
	set url(u) {
		_page.href = typeof u === 'string' ? u : u.href;
	},
	get params() {
		return _page.params;
	},
	set params(v) {
		_page.params = v;
	},
	get route() {
		return _page.route;
	},
	set route(v) {
		_page.route = v;
	},
	get data() {
		return _page.data;
	},
	set data(v) {
		_page.data = v;
	},
	get form() {
		return _page.form;
	},
	set form(v) {
		_page.form = v;
	},
	get state() {
		return _page.state;
	},
	set state(v) {
		_page.state = v;
	},
	get shallow() {
		return _page.shallow;
	},
	set shallow(v) {
		_page.shallow = v;
	},
	get status() {
		return _page.status;
	},
	set status(v) {
		_page.status = v;
	},
	get error() {
		return _page.error;
	},
	set error(v) {
		_page.error = v;
	},
};

// _nav holds the active Navigation object (null when idle, like kit).
const _nav = $state({ current: null });
/** kit `navigating` — non-null while a navigation is in flight. */
export const navigating = {
	get from() {
		return _nav.current?.from ?? null;
	},
	get to() {
		return _nav.current?.to ?? null;
	},
	get type() {
		return _nav.current?.type ?? null;
	},
	get willUnload() {
		return _nav.current?.willUnload ?? false;
	},
	get delta() {
		return _nav.current?.delta;
	},
	get complete() {
		return _nav.current?.complete;
	},
};

/** kit `updated` — new-deploy detection; meaningless in-process, API stub. */
export const updated = {
	get current() {
		return false;
	},
	async check() {
		return false;
	},
};

/** kit `snapshot` — browser-history machinery; register-and-forget stub so
 *  component code using it doesn't crash. */
export function snapshot() {}

// ── route pattern matching ──────────────────────────────────────────────────
// [p] [p=matcher] [...rest] [[opt]] [[opt=m]] [[...rest]] + (group) segments

function patternToRegex(id) {
	const names = [];
	const matchers = []; // parallel to names: matcher name or null
	let re = '^';
	for (const seg of id.split('/')) {
		if (seg === '') continue;
		let m;
		if ((m = /^\[\.\.\.(\w+)(?:=\w+)?\]$/.exec(seg))) {
			names.push(m[1]);
			matchers.push(null);
			re += '/(.+)';
		} else if ((m = /^\[\[\.\.\.(\w+)(?:=\w+)?\]\]$/.exec(seg))) {
			names.push(m[1]);
			matchers.push(null);
			re += '(?:/(.*))?';
		} else if ((m = /^\[\[(\w+)(?:=(\w+))?\]\]$/.exec(seg))) {
			names.push(m[1]);
			matchers.push(m[2] ?? null);
			re += '(?:/([^/]+))?';
		} else if ((m = /^\[(\w+)(?:=(\w+))?\]$/.exec(seg))) {
			names.push(m[1]);
			matchers.push(m[2] ?? null);
			re += '/([^/]+)';
		} else {
			re += '/' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		}
	}
	return { regex: new RegExp((re === '^' ? '^/' : re) + '/?$'), names, matchers };
}

/** kit route precedence — compare per segment left-to-right: static >
 *  [p=matcher] > [p] > [...rest] > [[optional]]. Longer static prefixes win. */
function routeScore(id) {
	return id.split('/').map((seg) => {
		if (/^\[\[/.test(seg)) return 1;
		if (/^\[\.\.\./.test(seg)) return 2;
		if (/^\[.*=.*\]$/.test(seg)) return 4;
		if (/^\[/.test(seg)) return 3;
		return 5;
	});
}
function compareRoutes(a, b) {
	const n = Math.max(a._score.length, b._score.length);
	for (let i = 0; i < n; i++) {
		const d = (a._score[i] ?? -1) - (b._score[i] ?? -1);
		if (d !== 0) return -d;
	}
	return 0;
}

// ── the router ──────────────────────────────────────────────────────────────

export class Router {
	/** what Shell.svelte renders: [{component, data, isPage, error?}] — reactive
	 *  field so template reads of router.levels track reassignments. */
	levels = $state([]);

	constructor({ routes, endpoints = {}, matchers = {}, hooks = {}, baseUrl = 'app://svelte.local' }) {
		this.hooks = hooks;
		this.baseUrl = baseUrl;
		this.matcherFns = matchers;
		const compile = (r) => {
			const { regex, names, matchers: mrefs } = patternToRegex(r.id);
			return { ...r, regex, names, mrefs, _score: routeScore(r.id) };
		};
		this.routes = routes.map(compile).sort(compareRoutes);
		this.endpoints = Object.entries(endpoints).map(([id, mod]) => ({
			id,
			mod,
			...patternToRegex(id),
		}));
		this.history = []; // [{url: full href, state, shallow}]
		this.historyIndex = -1;
		/** in-process cookie jar — shared across requests like a browser jar.
		 *  Values {value, expires} — expires is a ms timestamp or 0. */
		this.cookies = new Map();
		/** load records for the current route — invalidate()/depends() target these */
		this.records = [];
		this._started = false;
		// form submissions → actions (kit's default submit behavior)
		globalThis.document?.addEventListener('submit', (ev) => {
			if (ev.defaultPrevented || ev.__kitHandled) return;
			ev.__kitHandled = true;
			this._submitForm(ev.target, ev.submitter);
		});
	}

	#match(pathname) {
		for (const r of this.routes) {
			const m = r.regex.exec(pathname);
			if (!m) continue;
			const params = {};
			let ok = true;
			r.names.forEach((n, i) => {
				const raw = m[i + 1];
				if (raw === undefined) return; // optional segment absent
				const v = decodeURIComponent(raw);
				const mref = r.mrefs[i];
				if (mref && !(this.matcherFns[mref]?.(v) ?? true)) ok = false;
				params[n] = v;
			});
			if (!ok) continue;
			return { route: r, params };
		}
		return null;
	}

	/** $app/paths `match(url)` — resolve a URL to {id, params} without navigating. */
	async matchPath(url) {
		const u = new URL(String(url?.href ?? url), currentUrl());
		const m = this.#match(u.pathname);
		return m ? { id: m.route.id, params: m.params } : null;
	}

	#newNav(from, to, type, delta) {
		let done;
		const nav = {
			from,
			to,
			type,
			willUnload: false,
			delta,
			cancelled: false,
			cancel: () => {
				nav.cancelled = true;
			},
			complete: new Promise((r) => (done = r)),
			__done: done,
		};
		return nav;
	}

	#pushHistory(url, state, shallow, replace) {
		const entry = { url: url.href, state, shallow };
		if (replace && this.historyIndex >= 0) this.history[this.historyIndex] = entry;
		else this.history.splice(++this.historyIndex, this.history.length, entry);
	}

	/** kit `goto` — run the load chain, commit, render. A cancelled navigation
	 *  restores the nav token so an in-flight earlier nav still completes;
	 *  superseded navigations are abandoned (kit coalescing). */
	async goto(
		href,
		{ replaceState = false, type = 'goto', invalidateAll = false, state, shallow = false, delta, poppedState, onCancel } = {},
	) {
		const seq = ++this.#navSeq;
		const url = new URL(href, currentUrl());
		const from = { url: currentUrl(), route: page.route, params: page.params };
		const to = { url, route: null, params: {} };

		// kit shallow routing (goto {shallow:true}): state-only, no load chain
		if (shallow) {
			this.#pushHistory(url, state ?? {}, true, replaceState);
			page.url = url;
			page.state = state ?? {};
			page.shallow = { url, params: page.params, route: page.route };
			return;
		}

		// same-document change (hash-only or identical url): url + history move,
		// no load chain — kit short-circuits these before navigate(). Only once
		// a page exists — the initial enter to '/' must run the chain.
		if (this.#entered && url.pathname === currentUrl().pathname && url.search === currentUrl().search) {
			if (url.href !== currentUrl().href || state !== undefined) {
				const nav = this.#newNav(from, { ...to, route: page.route, params: page.params }, type);
				if (type !== 'enter') {
					this.#emit('beforeNavigate', nav);
					if (nav.cancelled) {
						if (this.#navSeq === seq) this.#navSeq = seq - 1;
						nav.__done();
						onCancel?.();
						return;
					}
				}
				this.#pushHistory(url, state ?? page.state, false, replaceState || url.href === currentUrl().href);
				page.url = url;
				if (state !== undefined) page.state = state;
				this.#emit('afterNavigate', { from, to: nav.to, type, complete: nav.complete });
				nav.__done();
			}
			return;
		}

		let match = this.#match(url.pathname);
		if (this.hooks.reroute) {
			// sync reroutes keep _nav visible in the same tick (kit's navigating
			// appears synchronously); async ones can still be superseded
			let rid = this.hooks.reroute({ url, fetch: (i, x) => this.#kitFetch(i, x, null) });
			if (rid?.then) rid = await rid;
			if (rid != null) {
				const r = this.routes.find((x) => x.id === rid);
				if (r) {
					const m = r.regex.exec(url.pathname);
					const params = {};
					if (m) r.names.forEach((n, i) => m[i + 1] !== undefined && (params[n] = decodeURIComponent(m[i + 1])));
					match = { route: r, params };
				}
			}
		}
		if (seq !== this.#navSeq) return; // superseded while reroute ran

		if (match) {
			to.route = { id: match.route.id };
			to.params = match.params;
		}
		const nav = this.#newNav(from, to, type, delta);

		if (type !== 'enter') {
			this.#emit('beforeNavigate', nav);
			if (nav.cancelled) {
				// restore the token so a still-in-flight earlier nav completes
				if (this.#navSeq === seq) this.#navSeq = seq - 1;
				nav.__done();
				onCancel?.();
				return;
			}
			_nav.current = nav;
		}
		// the request event exists even for 404s — handleError sees it
		const event = this.#requestEvent({
			url,
			params: match?.params ?? {},
			route: match?.route ?? { id: null },
			locals: {},
		});
		this.#lastEvent = event;
		try {
			if (!match) throw { [HTTP_ERROR]: true, status: 404, body: { message: `not found: ${url.pathname}` } };
			// hooks.handle wraps the whole navigation once — locals are shared by
			// every server load in the chain, like a real request.
			const resolve = (ev) =>
				this.#executeChain(match, url, ev, this.records, { kind: 'nav', forceAll: invalidateAll });
			const result = this.hooks.handle
				? await __als.run(event, () => this.hooks.handle({ event, resolve }))
				: await resolve(event);
			event.__commitCookies();
			if (seq !== this.#navSeq) return; // superseded mid-load
			// onNavigate callbacks run after loads resolve, before commit — and
			// are awaited (view-transition-style deferral, kit semantics)
			const afterFns = await Promise.all(this.#onNavCbs.map((cb) => cb(nav)));
			this.#commit(result, match, url, { history: replaceState ? 'replace' : 'push', state: poppedState ?? state });
			this.#emit('afterNavigate', { from, to, type, complete: nav.complete });
			for (const f of afterFns) if (typeof f === 'function') f(nav);
			nav.__done();
		} catch (e) {
			if (seq !== this.#navSeq) return;
			if (isRedirect(e)) {
				_nav.current = null;
				nav.__done();
				// kit recurses navigate preserving the original flags — a goto's
				// redirect PUSHES a new entry, it doesn't clobber the live one
				return this.goto(e.location, { replaceState, type });
			}
			await this.#renderError(e, match, url, { history: replaceState ? 'replace' : 'push', event });
			this.#emit('afterNavigate', { from, to, type, complete: nav.complete });
			nav.__done();
		} finally {
			if (seq === this.#navSeq) _nav.current = null;
		}
	}

	#commit(
		{ levels, data, records, status = 200, err = null },
		match,
		url,
		{ history = 'push', state = {}, form = null, keepState = false } = {},
	) {
		this.records = records;
		this.levels = levels;
		page.url = url;
		page.params = match?.params ?? {};
		page.route = { id: match?.route.id ?? null };
		page.data = data;
		page.status = status;
		page.error = err;
		page.form = form; // fresh navigation → stale action results don't leak
		page.shallow = null;
		page.state = keepState ? page.state : (state ?? {});
		if (history === 'push') this.#pushHistory(url, page.state, false, false);
		else if (history === 'replace') this.#pushHistory(url, page.state, false, true);
		this.#entered = true;
	}
	#entered = false;

	/** Error render = a real navigation: run the route's layout chain (the '/'
	 *  route's for unmatched 404s), then append the +error.svelte level. Kit
	 *  commits error pages to history too, so back() behaves. */
	async #renderError(e, match, url, { history = 'push', event = null } = {}) {
		const status = isHttpError(e) ? e.status : 500;
		const body = isHttpError(e) ? e.body : { message: String(e?.message ?? e) };
		const eff = match ?? this.#match('/') ?? null;
		try {
			// error renders go through handle like any data request — otherwise a
			// 404 would cache layout records built with empty locals
			const event = this.#requestEvent({
				url,
				params: eff?.params ?? {},
				route: eff?.route ?? { id: null },
				locals: {},
				isDataRequest: true,
			});
			const resolve = (ev) => this.#executeChain(eff, url, ev, [], { kind: 'nav', errorBody: { status, ...body } });
			const r = this.hooks.handle
				? await __als.run(event, () => this.hooks.handle({ event, resolve }))
				: await resolve(event);
			event.__commitCookies();
			this.#commit({ ...r, status, err: body }, eff, url, { history });
			// unmatched 404s: layouts came from '/' but the route id is null (kit)
			if (!match) {
				page.route = { id: null };
				page.params = {};
			}
		} catch {
			// last resort: bare error level, no layouts
			const errComp = eff?.route.error;
			this.levels = errComp ? [{ component: errComp, data: {}, isPage: true, error: { status, ...body } }] : [];
			this.records = [];
			page.url = url;
			page.params = eff?.params ?? {};
			page.route = { id: match ? eff.route.id : null };
			page.status = status;
			page.error = body;
			page.form = null;
			page.shallow = null;
			page.state = {};
			this.#pushHistory(url, {}, false, history === 'replace');
		}
		if (!isHttpError(e)) this.#reportError(e, event, status);
	}
	#lastEvent = null;

	#reportError(e, event, status) {
		if (!this.hooks.handleError) return;
		const input = { error: e, event, status, message: String(e?.message ?? e) };
		const out = event ? __als.run(event, () => this.hooks.handleError(input)) : this.hooks.handleError(input);
		// a returned {message} becomes the rendered page.error, like kit
		if (out && typeof out.then !== 'function' && out?.message) page.error = { message: out.message };
	}

	#emit(name, arg) {
		for (const cb of this.#navSubs[name] ?? []) cb(arg);
	}
	#navSubs = { beforeNavigate: [], afterNavigate: [] };
	#onNavCbs = [];
	#navSeq = 0;
	onNavigateEvent(name, cb) {
		this.#navSubs[name].push(cb);
		const off = () => {
			const i = this.#navSubs[name].indexOf(cb);
			if (i >= 0) this.#navSubs[name].splice(i, 1);
		};
		// kit registers nav callbacks on mount and removes them on destroy
		try {
			onDestroy(off);
		} catch {}
		return off;
	}
	addOnNavigate(cb) {
		this.#onNavCbs.push(cb);
		const off = () => {
			const i = this.#onNavCbs.indexOf(cb);
			if (i >= 0) this.#onNavCbs.splice(i, 1);
		};
		try {
			onDestroy(off);
		} catch {}
		return off;
	}

	// ── request events & cookies ─────────────────────────────────────────────

	/** Per-request cookie overlay: reads see jar + pending writes; writes land
	 *  in `pending` and only commit to the shared jar when the request
	 *  finishes — an in-flight request never sees another's uncommitted sets. */
	#cookiesView(pending) {
		const jar = this.cookies;
		const lookup = (n) => {
			if (pending.has(n)) {
				const p = pending.get(n);
				return p.maxAge !== undefined && p.maxAge <= 0 ? undefined : p.value;
			}
			const e = jar.get(n);
			if (!e) return undefined;
			if (e.expires && e.expires <= Date.now()) {
				jar.delete(n);
				return undefined;
			}
			return e.value;
		};
		return {
			get: (n) => lookup(n),
			getAll: (n) =>
				n !== undefined
					? lookup(n) !== undefined
						? [{ name: n, value: lookup(n) }]
						: []
					: [...jar.keys()].flatMap((k) => (lookup(k) !== undefined ? [{ name: k, value: lookup(k) }] : [])),
			set: (n, v, opts = {}) => pending.set(n, { value: String(v), maxAge: opts.maxAge, path: opts.path ?? '/' }),
			delete: (n, opts = {}) => pending.set(n, { value: '', maxAge: 0, path: opts.path ?? '/' }),
			serialize: (n, v, opts = {}) => {
				let s = `${n}=${encodeURIComponent(v)}`;
				s += `; Path=${opts.path ?? '/'}`;
				if (opts.maxAge !== undefined) s += `; Max-Age=${Math.floor(opts.maxAge)}`;
				if (opts.expires) s += `; Expires=${new Date(opts.expires).toUTCString()}`;
				if (opts.httpOnly) s += '; HttpOnly';
				if (opts.secure) s += '; Secure';
				if (opts.sameSite) s += `; SameSite=${opts.sameSite}`;
				return s;
			},
		};
	}
	#commitCookies(pending) {
		for (const [n, p] of pending) {
			if (p.maxAge !== undefined && p.maxAge <= 0) this.cookies.delete(n);
			else this.cookies.set(n, { value: p.value, expires: p.maxAge !== undefined ? Date.now() + p.maxAge * 1000 : 0 });
		}
	}
	#cookieHeader() {
		const parts = [];
		for (const [n, e] of this.cookies) {
			if (e.expires && e.expires <= Date.now()) {
				this.cookies.delete(n);
				continue;
			}
			parts.push(`${n}=${e.value}`);
		}
		return parts.join('; ');
	}

	#requestEvent({ url, params, route, locals, method = 'GET', isDataRequest = false, isSubRequest = false, pending, request }) {
		const pendingCookies = pending ?? new Map();
		const headers = {};
		if (method === 'GET' && !request) {
			const cookie = this.#cookieHeader();
			if (cookie) headers.cookie = cookie;
		}
		const event = {
			url,
			params,
			route: { id: route?.id ?? null },
			locals: locals ?? {},
			platform: { runtime: 'bun', native: true },
			request: request ?? new Request(url.href, { method, headers }),
			fetch: (input, init) => this.#kitFetch(input, init, event),
			cookies: this.#cookiesView(pendingCookies),
			getClientAddress: () => '127.0.0.1',
			isDataRequest,
			isSubRequest,
			setHeaders: (h) => Object.assign(event.__responseHeaders, h),
			__pendingCookies: pendingCookies,
			__responseHeaders: {},
			__requested: new Map(),
			__commitCookies: () => this.#commitCookies(pendingCookies),
		};
		return event;
	}

	// ── tracked load context: what a load read, for keep-checks ─────────────

	#trackedCtx(match, url, event, accumulated) {
		return {
			url,
			params: match.params,
			route: match.route,
			locals: event.locals,
			headers: {},
			deps: new Set(),
			fetches: new Set(),
			paramsUsed: new Set(),
			usedUrl: false,
			usedSearch: false,
			usedRoute: false,
			usedParent: false,
			tracking: true,
			parentAllData: accumulated.all,
			parentServerData: accumulated.server,
		};
	}

	#loadEvent(ctx, serverData) {
		const depHref = (k) => {
			try {
				return new URL(String(k), ctx.url.href).href;
			} catch {
				return String(k);
			}
		};
		const parent = (serverOnly) => {
			if (ctx.tracking) ctx.usedParent = true;
			return Promise.resolve({ ...(serverOnly ? ctx.parentServerData : ctx.parentAllData) });
		};
		const untrack = (fn) => {
			const t = ctx.tracking;
			ctx.tracking = false;
			try {
				return fn();
			} finally {
				ctx.tracking = t;
			}
		};
		const paramsProxy = new Proxy(ctx.params, {
			get: (t, k) => {
				if (ctx.tracking && typeof k === 'string') ctx.paramsUsed.add(k);
				return t[k];
			},
		});
		const routeProxy = new Proxy(
			{ id: ctx.route.id },
			{
				get: (t, k) => {
					if (ctx.tracking && k === 'id') ctx.usedRoute = true;
					return t[k];
				},
			},
		);
		const urlProxy = new Proxy(ctx.url, {
			get: (t, k) => {
				if (ctx.tracking) {
					if (k === 'search' || k === 'searchParams') ctx.usedSearch = true;
					else if (typeof k === 'string' && k !== 'hash') ctx.usedUrl = true;
				}
				const v = t[k];
				return v instanceof Function ? v.bind(t) : v;
			},
		});
		const base = {
			params: paramsProxy,
			route: routeProxy,
			url: urlProxy,
			data: serverData ?? null,
			depends: (...keys) => keys.forEach((k) => ctx.deps.add(depHref(k))),
			untrack,
		};
		return { base, parent };
	}

	/** event.fetch inside loads/endpoints/remote fns: real Request in/out.
	 *  Same-origin → +server.ts endpoints first (full RequestEvent, shared
	 *  sub-request cookie scope), then a 404 Response — never a protocol
	 *  crash. Cross-origin → real fetch. handleFetch wraps every call with a
	 *  real Request. */
	async #kitFetch(input, init, event) {
		const baseHref = event?.url?.href ?? currentUrl().href;
		let req;
		if (input instanceof Request) req = init ? new Request(input, init) : input;
		else req = new Request(new URL(String(input), baseHref).href, init);
		const appOrigin = new URL(this.baseUrl).origin;
		const inner = async (r) => {
			const u = new URL(r.url);
			if (u.origin !== appOrigin) return fetch(r);
			for (const ep of this.endpoints) {
				const m = ep.regex.exec(u.pathname);
				if (!m) continue;
				const method = r.method.toUpperCase();
				let handler = ep.mod[method];
				if (!handler && method === 'HEAD') handler = ep.mod.GET; // kit: HEAD falls back to GET
				handler ??= ep.mod.fallback;
				if (!handler) {
					return new Response('405 method not allowed', {
						status: 405,
						headers: { allow: Object.keys(ep.mod).filter((k) => k !== 'fallback').join(', ') },
					});
				}
				const params = {};
				ep.names.forEach((n, i) => m[i + 1] !== undefined && (params[n] = decodeURIComponent(m[i + 1])));
				const epEvent = this.#requestEvent({
					url: u,
					params,
					route: { id: ep.id },
					locals: event?.locals ?? {},
					method,
					isSubRequest: true,
					pending: event?.__pendingCookies, // sub-requests share the parent's uncommitted jar
					request: r,
				});
				try {
					const res = await __als.run(epEvent, () => handler(epEvent));
					if (!event) epEvent.__commitCookies(); // standalone fetch: commit now
					return res instanceof Response ? res : Response.json(res ?? null);
				} catch (e) {
					// error()/redirect() inside an endpoint serialize to a Response —
					// they must never escape through event.fetch into the caller
					if (isHttpError(e)) return new Response(e.body?.message ?? '', { status: e.status });
					if (isRedirect(e)) return new Response(null, { status: e.status, headers: { location: e.location } });
					this.#reportError(e, epEvent, 500);
					return new Response('internal error', { status: 500 });
				}
			}
			return new Response('not found', { status: 404 });
		};
		const call = () => (this.hooks.handleFetch ? this.hooks.handleFetch({ event, request: req, fetch: inner }) : inner(req));
		return event ? __als.run(event, call) : call();
	}

	// ── the load chain ────────────────────────────────────────────────────────

	/** One load level: serverLoad (full RequestEvent, ALS-scoped) then
	 *  universal load (kit's LoadEvent subset — no request/cookies/locals). */
	async #runLevel(level, ctx, event) {
		let serverData = undefined;
		if (level.serverLoad) {
			const sev = this.#loadEvent(ctx, undefined);
			const trackedFetch = (i, x) => {
				const href = i instanceof Request ? i.url : new URL(String(i), ctx.url.href).href;
				ctx.fetches.add(href);
				return this.#kitFetch(i, x, event);
			};
			serverData = this.#applyTransport(
				await __als.run(event, () =>
					level.serverLoad({
						...event,
						...sev.base,
						parent: () => sev.parent(true),
						fetch: trackedFetch,
						setHeaders: event.setHeaders,
					}),
				),
			);
		}
		let clientData = undefined;
		if (level.load) {
			const uev = this.#loadEvent(ctx, serverData ?? null);
			const trackedFetch = (i, x) => {
				const href = i instanceof Request ? i.url : new URL(String(i), ctx.url.href).href;
				ctx.fetches.add(href);
				return this.#kitFetch(i, x, event);
			};
			clientData = await __als.run(event, () =>
				level.load({
					...uev.base,
					parent: () => uev.parent(false),
					fetch: trackedFetch,
					setHeaders: event.setHeaders,
				}),
			);
		}
		return { serverData, clientData };
	}

	/** transport hook: encode→decode registered values in server-load data,
	 *  so custom classes cross the (virtual) boundary exactly like kit's
	 *  serializer round-trips them. encode(value) → falsy means "not mine". */
	#applyTransport(data, seen = new WeakSet()) {
		const t = this.hooks.transport;
		if (!t || !data || typeof data !== 'object') return data;
		if (seen.has(data)) return data;
		seen.add(data);
		for (const codec of Object.values(t)) {
			const enc = codec.encode?.(data);
			if (enc !== false && enc !== undefined) return codec.decode(enc);
		}
		if (Array.isArray(data)) return data.map((v) => this.#applyTransport(v, seen));
		// only plain objects recurse — promises (streaming data) and unregistered
		// class instances pass through untouched
		if (Object.getPrototypeOf(data) !== Object.prototype) return data;
		const out = {};
		for (const k of Object.keys(data)) out[k] = this.#applyTransport(data[k], seen);
		return out;
	}

	/** One pass over the layout+page chain.
	 *  keep-check mirrors kit's has_changed: a level is reused only when
	 *  everything it actually read is unchanged — used params, url,
	 *  searchParams, route.id, parent() data. kind 'invalidate' re-runs only
	 *  levels whose depends()/fetch() urls match the key predicate. */
	async #executeChain(match, url, outerEvent, prev, { kind, key = null, forceAll = false, errorBody = null } = {}) {
		const levels = [];
		const records = [];
		let accumulated = { all: {}, server: {} };
		const chain = [...match.route.layouts, match.route.page];
		const event = this.#requestEvent({
			url,
			params: match.params,
			route: match.route,
			locals: outerEvent?.locals ?? {},
			// kit: server loads see isDataRequest on every client-side data
			// refresh — only the initial 'enter' render is a full request
			isDataRequest: kind !== 'nav' || this.#entered,
			pending: outerEvent?.__pendingCookies, // share the request's cookie overlay
		});
		this.#lastEvent = event;
		let parentReran = false;
		for (let i = 0; i < chain.length; i++) {
			const level = chain[i];
			const prevRec = prev[i];
			const isLast = i === chain.length - 1;
			if (errorBody && isLast) {
				const errComp = match.route.error;
				if (errComp) levels.push({ component: errComp, data: { ...accumulated.all }, isPage: true, error: errorBody });
				break;
			}
			let keep = false;
			if (prevRec?.level === level && !forceAll) {
				if (kind === 'nav') {
					keep =
						[...prevRec.paramsUsed].every((k) => prevRec.params[k] === match.params[k]) &&
						(!prevRec.usedUrl || prevRec.url === url.href) &&
						(!prevRec.usedSearch || new URL(prevRec.url).search === url.search) &&
						(!prevRec.usedRoute || prevRec.routeId === match.route.id) &&
						(!prevRec.usedParent || !parentReran);
				} else if (kind === 'invalidate') {
					keep = key ? ![...prevRec.deps, ...prevRec.fetches].some((dep) => key(dep)) : false;
				} else if (kind === 'preload') {
					keep = false;
				}
			}
			if (keep) {
				records.push(prevRec);
				accumulated = {
					all: { ...accumulated.all, ...prevRec.data },
					server: { ...accumulated.server, ...(prevRec.serverData ?? {}) },
				};
				levels.push({ component: level.component, data: { ...accumulated.all }, isPage: false });
				continue;
			}
			parentReran = true;
			const ctx = this.#trackedCtx(match, url, event, accumulated);
			try {
				const { serverData, clientData } = await this.#runLevel(level, ctx, event);
				const produced = { ...serverData, ...clientData };
				accumulated = {
					all: { ...accumulated.all, ...produced },
					server: { ...accumulated.server, ...(serverData ?? {}) },
				};
				records.push({
					level,
					deps: ctx.deps,
					fetches: ctx.fetches,
					paramsUsed: ctx.paramsUsed,
					params: match.params,
					url: url.href,
					routeId: match.route.id,
					usedUrl: ctx.usedUrl,
					usedSearch: ctx.usedSearch,
					usedRoute: ctx.usedRoute,
					usedParent: ctx.usedParent,
					locals: event.locals,
					data: produced,
					serverData,
				});
				levels.push({ component: level.component, data: { ...accumulated.all }, isPage: isLast });
			} catch (e) {
				if (isRedirect(e)) throw e;
				const status = isHttpError(e) ? e.status : 500;
				const body = isHttpError(e) ? e.body : { message: String(e?.message ?? e) };
				// error boundary: this level's own +error.svelte (computed by the
				// manifest — a dir's boundary catches its page + deeper levels,
				// never its own layout's failure)
				const errComp = level.boundaryError;
				if (!errComp) throw e;
				if (levels.length) levels[levels.length - 1].isPage = false;
				levels.push({ component: errComp, data: { ...accumulated.all }, isPage: true, error: { status, ...body } });
				if (!isHttpError(e)) this.#reportError(e, event, status);
				return { levels, data: accumulated.all, records, status, err: body };
			}
		}
		return { levels, data: accumulated.all, records };
	}

	/** kit `invalidate(key)` — re-runs levels that declared `depends(key)` or
	 *  fetch()ed that URL; wrapped in hooks.handle like a fresh request.
	 *  Keys resolve to absolute hrefs like kit; a function is a URL predicate. */
	async invalidate(key) {
		const url = currentUrl();
		const match = this.#match(url.pathname);
		if (!match) return;
		const matchAll = key === undefined || key === '*' || key === true;
		const keyFn = matchAll
			? null
			: typeof key === 'function'
				? (dep) => {
						try {
							return key(new URL(dep));
						} catch {
							return false;
						}
					}
				: (() => {
						let href;
						try {
							href = new URL(String(key), url.href).href;
						} catch {
							return () => false;
						}
						return (dep) => dep === href;
					})();
		const seq = this.#navSeq; // don't clobber a newer in-flight navigation
		const event = this.#requestEvent({ url, params: match.params, route: match.route, locals: {}, isDataRequest: true });
		const resolve = (ev) =>
			this.#executeChain(match, url, ev, this.records, { kind: 'invalidate', key: keyFn, forceAll: matchAll });
		let result;
		try {
			result = this.hooks.handle ? await __als.run(event, () => this.hooks.handle({ event, resolve })) : await resolve(event);
		} catch (e) {
			if (isRedirect(e)) return this.goto(e.location, { type: 'redirect' });
			throw e;
		}
		event.__commitCookies();
		if (seq !== this.#navSeq) return;
		this.#commit(result, match, url, { history: 'none', state: {}, form: page.form });
	}

	async invalidateAll() {
		return this.invalidate();
	}

	/** kit `back()` — shallow entries restore url+state without loads;
	 *  cancelled popstates restore the history pointer (kit history.go(-delta)). */
	async back() {
		if (this.historyIndex <= 0) return;
		const prevIdx = this.historyIndex;
		const e = this.history[--this.historyIndex];
		const url = new URL(e.url);
		if (e.shallow) {
			page.url = url;
			page.state = e.state; // kit: shallow pops keep route/params
			page.shallow = { url, params: page.params, route: page.route };
			return;
		}
		return this.goto(url.href, {
			replaceState: true,
			type: 'popstate',
			delta: prevIdx - this.historyIndex,
			poppedState: e.state,
			onCancel: () => {
				this.historyIndex = prevIdx;
			},
		});
	}

	/** kit `pushState` — a history entry + page.state/url, no load chain. */
	pushState(href, state) {
		const url = new URL(href, currentUrl());
		this.#pushHistory(url, state, true, false);
		page.url = url;
		page.state = state;
		page.shallow = { url, params: page.params, route: page.route };
	}

	replaceState(href, state) {
		const url = new URL(href, currentUrl());
		this.#pushHistory(url, state, true, true);
		page.url = url;
		page.state = state;
		page.shallow = { url, params: page.params, route: page.route };
	}

	/** kit `preloadData(href)` — runs the load chain through handle/reroute
	 *  like a real data request; returns the result without committing. */
	async preloadData(href) {
		const url = new URL(href, currentUrl());
		let match = this.#match(url.pathname);
		if (this.hooks.reroute) {
			let rid = this.hooks.reroute({ url, fetch: (i, x) => this.#kitFetch(i, x, null) });
			if (rid?.then) rid = await rid;
			if (rid != null) {
				const r = this.routes.find((x) => x.id === rid);
				if (r) {
					const m = r.regex.exec(url.pathname);
					const params = {};
					if (m) r.names.forEach((n, i) => m[i + 1] !== undefined && (params[n] = decodeURIComponent(m[i + 1])));
					match = { route: r, params };
				}
			}
		}
		if (!match) return { type: 'loaded', status: 404, data: {} };
		const event = this.#requestEvent({ url, params: match.params, route: match.route, locals: {}, isDataRequest: true });
		try {
			const resolve = (ev) => this.#executeChain(match, url, ev, [], { kind: 'preload' });
			const r = this.hooks.handle ? await __als.run(event, () => this.hooks.handle({ event, resolve })) : await resolve(event);
			event.__commitCookies();
			return { type: 'loaded', status: r.status ?? 200, data: r.data };
		} catch (e) {
			if (isRedirect(e)) return { type: 'redirect', status: e.status, location: e.location };
			throw e;
		}
	}

	/** kit `preloadCode` — code is already in-process; resolves immediately. */
	async preloadCode() {}

	/** kit `disableScrollHandling` — no scroll container exists natively; kept
	 *  as a real flag so code calling it is faithful. */
	disableScrollHandling() {
		this.#scrollDisabled = true;
	}
	#scrollDisabled = false;

	// ── form actions (?/name on +page.server.ts `actions`) ───────────────────

	/** Parse an action attribute into target url + ?/name (null → malformed). */
	#parseAction(raw) {
		const u = new URL(raw || '?', currentUrl());
		const m = /^\?\/(\w+)/.exec(u.search);
		const name = u.search === '' || u.search === '?' ? 'default' : (m?.[1] ?? null);
		return { url: u, name };
	}

	/** shared submission pipeline — remote forms dispatch to remote fns,
	 *  GET forms navigate with fields as query (kit default), POST forms
	 *  dispatch to ?/actions on the action URL's own route. */
	async _submitForm(form, submitter, beforeRun) {
		const raw = submitter?.getAttribute?.('formaction') ?? form.getAttribute?.('action') ?? '';
		const method = (submitter?.getAttribute?.('formmethod') ?? form.getAttribute?.('method') ?? 'get').toLowerCase();
		// the activated submitter's name/value is part of the submission
		const formData = new FormData(form, submitter);

		// remote form(): data-remote-form marker set by remote.svelte.js
		const rfId = form.getAttribute?.('data-remote-form');
		if (rfId != null && method === 'post') {
			const dispatch = globalThis.__kitRemote?.dispatch;
			if (dispatch) return dispatch(rfId, formData, submitter);
		}

		const { url: actionUrl, name } = this.#parseAction(raw);

		// GET (and unspecified) → client-side navigation with fields as query
		if (method !== 'post') {
			for (const [k, v] of formData.entries()) actionUrl.searchParams.set(k, v);
			return this.goto(actionUrl.href, { type: 'form' });
		}

		const match = this.#match(actionUrl.pathname);
		const actions = match?.route.page.actions;

		if (beforeRun) {
			let cancelled = false;
			const ret = await beforeRun({
				action: actionUrl,
				cancel: () => (cancelled = true),
				controller: new AbortController(),
				formData,
				formElement: form,
				submitter,
			});
			if (cancelled) return;
			const result = await this.#dispatchAction(match, actions, name, formData, actionUrl);
			if (typeof ret === 'function') {
				// kit: the returned callback gets {result, action, formData,
				// formElement, update} — update() applies the default behavior
				await ret({
					result,
					action: actionUrl,
					formData,
					formElement: form,
					update: async (opts = {}) => this.#applyActionResult(result, form, actionUrl, opts),
				});
				// redirects navigate regardless of whether update() was called
				if (result.type === 'redirect') await this.#applyActionResult(result, form, actionUrl, {});
			} else {
				await this.#applyActionResult(result, form, actionUrl, {});
			}
			return;
		}
		const result = await this.#dispatchAction(match, actions, name, formData, actionUrl);
		await this.#applyActionResult(result, form, actionUrl, {});
	}

	async #dispatchAction(match, actions, name, formData, actionUrl) {
		if (!match) return { type: 'error', status: 404, error: new Error('no route') };
		const action = actions?.[name];
		if (!action) return { type: 'error', status: 405, error: new Error(`no action '${name}' on ${match.route.id}`) };
		// form submissions are type:'form' navigations in kit
		const nav = this.#newNav(
			{ url: currentUrl(), route: page.route, params: page.params },
			{ url: actionUrl, route: { id: match.route.id }, params: match.params },
			'form',
		);
		_nav.current = nav;
		// gdom's FormData isn't a real web FormData — feed the Request an
		// urlencoded body so request.formData() parses correctly inside actions
		const body = new URLSearchParams();
		for (const [k, v] of formData.entries()) body.append(k, v);
		const request = new Request(actionUrl.href, { method: 'POST', body });
		const event = this.#requestEvent({
			url: actionUrl,
			params: match.params,
			route: match.route,
			locals: {},
			method: 'POST',
			request,
		});
		const call = (ev) =>
			__als.run(ev ?? event, () => {
				const ctx = this.#trackedCtx(match, actionUrl, ev ?? event, { all: {}, server: {} });
				const lev = this.#loadEvent(ctx, undefined);
				return action({ ...(ev ?? event), ...lev.base, request: (ev ?? event).request });
			});
		try {
			const out = this.hooks.handle
				? await __als.run(event, () => this.hooks.handle({ event, resolve: call }))
				: await call();
			event.__commitCookies();
			if (isActionFailure(out)) return { type: 'failure', status: out.status, data: out.data };
			return { type: 'success', status: 200, data: out ?? null };
		} catch (e) {
			event.__commitCookies();
			if (isRedirect(e)) return { type: 'redirect', status: e.status, location: e.location };
			if (isHttpError(e)) return { type: 'error', status: e.status, error: e.body };
			this.#reportError(e, event, 500);
			return { type: 'error', status: 500, error: e };
		} finally {
			if (_nav.current === nav) _nav.current = null;
			nav.__done();
		}
	}

	/** kit `applyAction(result)` — success/failure land on page.form (same-page
	 *  actions only); success also re-runs the load chain and resets the form. */
	async #applyActionResult(result, form, actionUrl, { reset = true } = {}) {
		const samePage = !actionUrl || actionUrl.pathname === currentUrl().pathname;
		if (result.type === 'success') {
			if (samePage) {
				page.form = result.data;
				page.status = result.status;
				if (reset) form?.reset?.();
				await this.invalidateAll();
			} else {
				await this.goto(actionUrl.pathname + actionUrl.search, { type: 'form' });
			}
		} else if (result.type === 'failure') {
			if (samePage) {
				page.form = result.data;
				page.status = result.status;
			} else {
				await this.goto(actionUrl.pathname, { type: 'form' });
			}
		} else if (result.type === 'redirect') {
			// kit: _goto(location, {invalidateAll:true}) — pushes a real entry
			await this.goto(result.location, { type: 'redirect', invalidateAll: true });
		} else if (result.type === 'error') {
			const match = this.#match(currentUrl().pathname);
			await this.#renderError(
				{ [HTTP_ERROR]: true, status: result.status, body: result.error?.message ? result.error : { message: String(result.error) } },
				match,
				currentUrl(),
				{ history: 'none' },
			);
		}
	}

	async applyAction(result) {
		return this.#applyActionResult(result, null, null, {});
	}

	/** Remote-function invocation: in kit a remote call IS a request — it goes
	 *  through `handle` and sees getRequestEvent(). Synthesized per call. */
	async __invokeRemote(fn) {
		const url = currentUrl();
		const match = this.#match(url.pathname) ?? { route: { id: null }, params: {} };
		const event = this.#requestEvent({
			url,
			params: match.params,
			route: match.route,
			locals: {},
			method: 'POST',
			isDataRequest: true,
		});
		const run = (ev) => __als.run(ev, () => fn(ev));
		try {
			const out = this.hooks.handle
				? await __als.run(event, () => this.hooks.handle({ event, resolve: run }))
				: await run(event);
			event.__commitCookies();
			return out;
		} catch (e) {
			event.__commitCookies();
			throw e;
		}
	}

	/** mount: initial navigation + hooks.init */
	async start(path = '/') {
		if (this._started) return;
		this._started = true;
		await this.hooks.init?.();
		await this.goto(path, { replaceState: true, type: 'enter' });
	}
}
// ── public API bound at createRouter() ─────────────────────────────────────

let active = null;
export function createRouter(opts) {
	active = new Router(opts);
	// <a href> clicks → goto (gdom calls this after an un-prevented click);
	// kit reports the nav type as 'link', not 'goto'
	globalThis.__kitGoto = (href) => active.goto(href, { type: 'link' });
	return active;
}
export const goto = (href, opts) => active?.goto(href, opts);
export const invalidate = (key) => active?.invalidate(key);
export const invalidateAll = () => active?.invalidateAll();
export const back = () => active?.back();
export const pushState = (href, state) => active?.pushState(href, state);
export const replaceState = (href, state) => active?.replaceState(href, state);
export const preloadData = (href) => active?.preloadData(href);
export const preloadCode = () => active?.preloadCode();
export const beforeNavigate = (cb) => active?.onNavigateEvent('beforeNavigate', cb);
export const afterNavigate = (cb) => active?.onNavigateEvent('afterNavigate', cb);
export const match = (url) => active?.matchPath(url);

/** kit `onNavigate` — callback runs after loads resolve (awaited for
 *  view-transition-style deferral); a returned function runs after commit.
 *  Auto-unsubscribed on component destroy. */
export function onNavigate(cb) {
	return active?.addOnNavigate(cb);
}

/** kit `applyAction` — apply an action result yourself (inside enhance). */
export const applyAction = (result) => active?.applyAction(result);

/** kit `use:enhance` — intercept the form's submit, run your callback, then
 *  the default action pipeline (or your returned result-handler). Kit only
 *  intercepts POST forms — GET forms fall through to default navigation. */
export function enhance(formEl, cb) {
	const handler = (ev) => {
		if (ev.__kitHandled) return;
		const method = (formEl.getAttribute?.('method') ?? 'get').toLowerCase();
		if (method !== 'post') return; // let the default GET-nav path handle it
		ev.__kitHandled = true;
		ev.preventDefault();
		active?._submitForm(formEl, ev.submitter, cb);
	};
	formEl.addEventListener('submit', handler);
	return {
		destroy() {
			formEl.removeEventListener('submit', handler);
		},
	};
}

/** kit `deserialize` — parse a serialized action result. In-process results
 *  aren't serialized; accept either the object or its JSON. */
export function deserialize(raw) {
	return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export const disableScrollHandling = () => active?.disableScrollHandling();

/** kit `refreshAll` ($app/navigation, 2.x) — refresh all remote queries AND
 *  re-run load functions (includeLoadFunctions defaults true). */
export async function refreshAll({ includeLoadFunctions = true } = {}) {
	const { refreshAll: remoteRefresh } = await import('../remote.js');
	remoteRefresh();
	if (includeLoadFunctions && active) await active.invalidateAll();
}

/** bridge for remote.svelte.js — wraps a remote fn in a request event so
 *  getRequestEvent()/locals/cookies work inside remote functions. */
export const __remoteInvoke = (fn) => (active ? active.__invokeRemote(fn) : fn());

/** kit `requested` ($app/server) — per-request memoization. */
export function requested(key, fn) {
	try {
		const ev = getRequestEvent();
		if (!ev.__requested.has(key)) ev.__requested.set(key, fn());
		return ev.__requested.get(key);
	} catch {
		return fn(); // outside a request: evaluate fresh each call
	}
}

/** kit `read` ($app/server) — read an asset/file as a Response. */
export async function read(file) {
	const f = Bun.file(String(file));
	return new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream' } });
}
