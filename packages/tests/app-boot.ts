/**
 * App bootstrap — the same boot pattern as kit-app.ts but consuming the
 * gen-app tree (the real app/ compiled by build-app.ts):
 *
 *   createRouter({routes, endpoints, matchers, hooks})
 *   mount(Shell, { target, props: { router } })
 *   router.start(path)
 *
 * Backend-neutral — the caller owns renderer wiring. `ssr=false` semantics:
 * client mount only, no html shell, no hydration.
 */
import { createRouter } from '@svelte-desktop/svelte/gen/kit/index.js';
import { routes, endpoints, matchers } from '../../app/gen-app/routes/manifest.js';
import * as hooks from '../../app/gen-app/hooks.js';
import Shell from '@svelte-desktop/svelte/gen/kit/Shell.js';
// 'svelte' resolves to its server entry under bun — bypass the exports map
const { mount } = await import('@svelte-desktop/svelte/svelte-client.js') as {
	mount: (component: unknown, opts: { target: unknown; props?: Record<string, unknown> }) => unknown;
};

export async function startApp(target: unknown, path = '/') {
	const router = createRouter({ routes, endpoints, matchers, hooks });
	const handle = mount(Shell, { target, props: { router } });
	await router.start(path);
	return { router, handle };
}
