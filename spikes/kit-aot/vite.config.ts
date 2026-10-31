import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { stagedAdapter } from './scripts/staged-adapter.js';

// stagedAdapter wraps @sveltejs/adapter-bun@1.0.0-next.2 in its `compile` (embed)
// mode but intercepts the adapter's final Bun.build() call: instead of compiling,
// it writes the exact module graph the adapter would compile to ./stage so that
// `bun build --compile stage/entry.js` can be run by hand with any (canary) flag.
export default defineConfig({
	plugins: [
		sveltekit({
			adapter: stagedAdapter({ out: 'build-adapter', stage: 'stage' }),
			paths: { origin: 'http://localhost:42777' },
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
				experimental: { async: true }
			},
			experimental: { remoteFunctions: true }
		})
	]
});
