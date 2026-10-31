import { sveltekit } from '@sveltejs/kit/vite';
import desktop from '@svelte-desktop/shell/adapter';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			adapter: desktop({
				appName: 'HelloOurs',
				identifier: 'dev.bench.hello.ours',
				version: '1.0.0',
				window: { width: 800, height: 600 }
			}),
			compilerOptions: { runes: true }
		})
	]
});
