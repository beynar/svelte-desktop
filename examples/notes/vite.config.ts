import { sveltekit } from '@sveltejs/kit/vite';
import { desktop } from '@kitop/shell/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				runes: ({ filename }: { filename: string }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
				experimental: { async: true }
			},
			experimental: { remoteFunctions: true }
		}),
		desktop({ website: false })
	]
});
