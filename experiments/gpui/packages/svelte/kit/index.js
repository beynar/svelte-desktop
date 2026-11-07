/**
 * Public kit API — import as `#kit` from route modules and components.
 * ($app/navigation + $app/state + $app/forms + $app/paths + $app/environment
 *  + $app/server + @sveltejs/kit control-flow, in-process.)
 */
export {
	createRouter,
	// $app/navigation
	goto,
	invalidate,
	invalidateAll,
	refreshAll,
	back,
	pushState,
	replaceState,
	preloadData,
	preloadCode,
	beforeNavigate,
	afterNavigate,
	onNavigate,
	disableScrollHandling,
	snapshot,
	// $app/forms
	applyAction,
	enhance,
	deserialize,
	// $app/state
	page,
	navigating,
	updated,
	// $app/environment
	browser,
	building,
	dev,
	version,
	// $app/paths
	base,
	assets,
	asset,
	resolve,
	match,
	// $app/server
	read,
	getRequestEvent,
	requested,
	// @sveltejs/kit control flow + helpers
	redirect,
	error,
	fail,
	invalid,
	isRedirect,
	isHttpError,
	isActionFailure,
	isInvalidError,
	json,
	text,
	// internal: remote.svelte.js bridge
	__remoteInvoke,
} from './runtime.js';
