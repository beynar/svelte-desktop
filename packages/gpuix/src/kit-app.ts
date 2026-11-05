/**
 * Kit-app bootstrap: builds the router from the generated manifest + hooks,
 * mounts the recursive Shell into a gdom target. Backend-neutral — the caller
 * owns renderer wiring.
 */
import { createRouter } from './gen/kit/index.js';
import { routes, endpoints, matchers } from './gen/routes/manifest.js';
import * as hooks from './hooks.ts';
import Shell from './gen/kit/Shell.js';
// 'svelte' resolves to its server entry under bun — bypass the exports map
const { mount } = await import('../node_modules/svelte/src/index-client.js');

export async function startKit(target, path = '/') {
	const router = createRouter({ routes, endpoints, matchers, hooks });
	mount(Shell, { target, props: { router } });
	await router.start(path);
	return router;
}
