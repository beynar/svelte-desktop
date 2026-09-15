import adapter from '@sveltejs/adapter-bun';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Variant that produces a single self-contained executable (bun build --compile).
// paths.origin is baked because remote-function mutations are CSRF-checked against
// it — the binary is pinned to serve http://localhost:42777.
export default defineConfig({
	plugins: [
		sveltekit({
			adapter: adapter({
				out: 'build-bin',
				buildOptions: {
					compile: true
				}
			}),
			paths: {
				origin: 'http://localhost:42777'
			},
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
				experimental: {
					async: true
				}
			},
			experimental: {
				remoteFunctions: true
			}
		})
	]
});
