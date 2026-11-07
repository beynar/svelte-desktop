/**
 * `$app/server` equivalent for modules compiled out of the real app (app/).
 *
 * In SvelteKit this module carries the remote-function constructors
 * (query/command/form/prerender) plus the request-scope APIs
 * (getRequestEvent/read/requested/invalid). Here both halves exist in-process:
 * remote functions live in #remote (src/gen/remote.js — remote.svelte.js
 * compiled) and the request scope lives in #kit (src/gen/kit/index.js —
 * runtime.svelte.js compiled). Every remote call is wrapped by the router in
 * a synthesized RequestEvent (__remoteInvoke → __als), so getRequestEvent(),
 * cookies and locals work inside remote functions exactly like kit.
 *
 * Plain JS, no compile step — gen-app output imports this file by relative
 * path; the `#remote`/`#kit` specifiers resolve via this package's
 * `imports` regardless of the importing file's location inside the package.
 */
export { query, command, form, prerender, refreshAll, requested } from '#remote';
export { getRequestEvent, read, invalid } from '#kit';
