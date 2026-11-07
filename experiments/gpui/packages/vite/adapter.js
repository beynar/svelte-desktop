/**
 * adapterSvelteNative() — SvelteKit-adapter-shaped object for
 * svelte.config.js compatibility.
 *
 * HONEST STATUS: kit's adapter contract (`adapt(builder)`) is only invoked
 * at the end of `svelte-kit build`, and that pipeline is driven by
 * @sveltejs/kit's own vite plugin + internals — which this stack
 * deliberately does not use (the kit-shaped runtime in packages/svelte/kit is
 * the client). So a real kit `adapt` call can never reach us in a
 * DOM-less project.
 *
 * What this file therefore ships: the same {name, async adapt} surface,
 * where adapt() performs OUR emission (virtual manifest → compiled bundle →
 * spawnable .svelte-native/app.js) through buildNativeApp(). When a real kit
 * Builder is passed we honor its build directory; when called standalone
 * (`bun build.js`, a post-build script, etc.) it emits to <root>/.svelte-native.
 * The supported entry point is the build.js CLI — see README.
 */
import { join, resolve as resolvePath } from 'node:path';
import { buildNativeApp } from './emit.js';

export function adapterSvelteNative(options = {}) {
	return {
		name: '@svelte-desktop/vite',
		/**
		 * @param {object} [builder] — kit's Builder when invoked from a real
		 *   svelte-kit build; absent/duck-typed otherwise.
		 */
		async adapt(builder) {
			const root = resolvePath(options.root ?? process.cwd());
			const outDir =
				typeof builder?.getBuildDirectory === 'function'
					? builder.getBuildDirectory('svelte-native')
					: (options.outDir ?? join(root, '.svelte-native'));
			builder?.log?.info?.('[svelte-native] emitting native bundle');
			const { bundlePath } = await buildNativeApp({ root, outDir, ...options });
			builder?.log?.success?.(`[svelte-native] ${bundlePath}`);
			return bundlePath;
		},
	};
}

export default adapterSvelteNative;
