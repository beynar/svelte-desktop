/**
 * Remote functions ported in-process, with SvelteKit's actual API shapes:
 *
 *   query(fn)    → RemoteQueryFunction — call it → RemoteResource
 *                  (thenable + .current/.loading/.error/.ready/.refresh()/
 *                   .set()/.withOverride())
 *   command(fn)  → RemoteCommand — callable → Promise<result>;
 *                  .pending reactive; result.updates(...qs) scopes refreshes
 *   form(fn)     → RemoteForm — spread onto <form {...f}>; .result/.pending/
 *                  .issues/.fields/.enhance()/.buttonProps
 *   prerender()  → alias for query (no build-time prerendering in-process)
 *   requested()  → per-request memoization ($app/server)
 *
 * The "server" side is the same Bun process — bun:sqlite, Bun.serve, FFI are
 * available inside these functions. When the kit runtime is active, each
 * invocation goes through __remoteInvoke → a synthesized RequestEvent runs
 * through hooks.handle, so remote functions see getRequestEvent()/locals/
 * cookies — matching kit (a remote call IS a request).
 */
import { __remoteInvoke, isInvalidError, getRequestEvent, requested } from '#kit';

const queries = new Set();

export { requested };

export function refreshAll() {
	// snapshot: a refresh() can register new queries mid-iteration
	for (const q of [...queries]) q();
}

const firstFn = (args) => (args.length > 1 ? args[1] : args[0]); // (fn) or ('unchecked', fn)

/** A RemoteResource — what calling a RemoteQueryFunction returns.
 *  Thenable (`await q()` → value) + reactive fields for template use. */
function createResource(fn, args, onTeardown) {
	let current = $state(undefined);
	let loading = $state(true);
	let error = $state(undefined);
	let gen = 0;
	let settle;
	const ready = new Promise((r) => (settle = r));

	const run = async () => {
		const g = ++gen; // stale resolutions can't clobber newer results
		loading = true;
		try {
			const r = await __remoteInvoke(() => fn(...args));
			if (g === gen) {
				current = r;
				error = undefined;
			}
			return r;
		} catch (e) {
			if (g === gen) error = e;
			throw e;
		} finally {
			if (g === gen) loading = false;
		}
	};
	const promise = run().then(
		(v) => (settle(v), v),
		(e) => {
			settle(current);
			throw e;
		},
	);
	// Prune on unmount: inside a component/effect context the query unregisters
	// when its owner tears down; at module scope it stays registered forever.
	const register = (reg) => {
		try {
			$effect(() => {
				queries.add(reg);
				return () => {
					queries.delete(reg);
					onTeardown?.();
				};
			});
		} catch {
			queries.add(reg);
		}
	};
	register(run);
	return {
		get current() {
			return current;
		},
		get loading() {
			return loading;
		},
		get error() {
			return error;
		},
		get ready() {
			return ready;
		},
		refresh: run,
		set(v) {
			current = v;
		},
		/** optimistic-update hook: fn receives a setter for current. */
		withOverride(fn) {
			fn((v) => (current = v));
		},
		then: (a, b) => promise.then(a, b),
		catch: (f) => promise.catch(f),
		finally: (f) => promise.finally(f),
	};
}

/** kit `query(fn)` / `query('unchecked', fn)` → RemoteQueryFunction. */
export function query(...args) {
	const fn = firstFn(args);
	const cache = new Map(); // same args → same resource within a mount
	return function remoteQuery(...callArgs) {
		const key = callArgs.length ? JSON.stringify(callArgs) : '';
		const hit = cache.get(key);
		if (hit) return hit;
		const res = createResource(fn, callArgs, () => cache.delete(key));
		cache.set(key, res);
		return res;
	};
}

/** kit `command(fn)` / `command('unchecked', fn)` → RemoteCommand.
 *  Callable → Promise<result>; `f.pending` is reactive; the returned promise
 *  has `.updates(...resources)` to scope the post-call refresh (kit's
 *  single-flight mutation semantics — no args → refreshAll). */
export function command(...args) {
	const fn = firstFn(args);
	let pending = $state(0);
	function remoteCommand(...callArgs) {
		pending++;
		const p = __remoteInvoke(() => fn(...callArgs))
			.then((r) => {
				refreshAll();
				return r;
			})
			.finally(() => pending--);
		p.updates = (...qs) =>
			p.then((r) => {
				if (qs.length) for (const q of qs) q?.refresh?.();
				return r;
			});
		return p;
	}
	Object.defineProperty(remoteCommand, 'pending', { get: () => pending > 0 });
	remoteCommand.updates = (...qs) => (p) =>
		p.then((r) => {
			for (const q of qs) q?.refresh?.();
			return r;
		});
	return remoteCommand;
}

/** kit `prerender(fn)` — marks a query as build-time prerenderable. Nothing
 *  prerenders in-process; behaves exactly like query(). */
export const prerender = query;

// ── remote form() ───────────────────────────────────────────────────────────

let formSeq = 0;
const remoteForms = new Map();

function fieldProxy(path) {
	const field = {
		as: (type, extra = {}) => ({ name: path.join('.'), type, ...extra }),
		set: (v) => ({ name: path.join('.'), value: v }),
		invalid: (msg) => {
			const ev = getRequestEvent();
			(ev.__issues ??= []).push({ field: path.join('.'), message: msg });
			throw { __invalidIssue: true };
		},
	};
	return new Proxy(field, {
		get: (t, k) => (k in t ? t[k] : fieldProxy([...path, k])),
	});
}

/** kit `form(fn)` / `form('unchecked', fn)` → RemoteForm.
 *  Spread onto <form {...f}> — method/action/data-remote-form dispatch the
 *  call through the normal submit pipeline. */
export function form(...args) {
	const fn = firstFn(args);
	const id = `rf${formSeq++}`;
	const state = $state({ result: undefined, pending: false, issues: null });
	const props = {
		method: 'POST',
		action: '?',
		'data-remote-form': id,
	};
	// only method/action/data-remote-form are enumerable — `{...f}` spreads
	// clean DOM attributes, everything else stays property-only access
	const f = { ...props };
	Object.defineProperties(f, {
		result: { get: () => state.result },
		pending: { get: () => state.pending },
		issues: { get: () => state.issues },
		buttonProps: { value: { type: 'submit' } },
		fields: { value: fieldProxy([]) },
		preflight: { value: () => f },
		for: { value: () => f },
		/** kit `form.enhance(cb)` — cb gets {form, data, submit, submitter};
		 *  calling submit() runs the remote call. */
		enhance: {
			value: (cb) => ({
				...props,
				onsubmit: (e) => {
					e.preventDefault?.();
					const formData = new FormData(e.target);
					cb({
						form: e.target,
						data: formData,
						submitter: e.submitter,
						submit: () => remoteForms.get(id)?.dispatch(formData, e.submitter),
					});
				},
			}),
		},
	});
	remoteForms.set(id, {
		async dispatch(formData, submitter) {
			state.pending = true;
			try {
				const r = await __remoteInvoke((ev) => {
					ev.__issues = [];
					return Promise.resolve()
						.then(() => fn(formData, submitter))
						.then(
							(out) => {
								if (ev.__issues.length) throw { __issues: ev.__issues };
								return out;
							},
							(e) => {
								if (e?.__invalidIssue) throw { __issues: ev.__issues };
								throw e;
							},
						);
				});
				state.issues = null;
				state.result = r;
				refreshAll();
				return r;
			} catch (e) {
				if (isInvalidError(e)) {
					state.issues = [{ field: e.field, message: e.message }];
					state.result = undefined;
					return undefined;
				}
				if (e?.__issues) {
					state.issues = e.__issues;
					state.result = undefined;
					return undefined;
				}
				state.result = undefined;
				throw e;
			} finally {
				state.pending = false;
			}
		},
	});
	return f;
}

// kit runtime bridges — read by the router's submit pipeline
globalThis.__kitRemote = {
	get: (id) => remoteForms.get(id),
	dispatch: (id, formData, submitter) => remoteForms.get(id)?.dispatch(formData, submitter),
};
