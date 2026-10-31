import { desktop } from '@svelte-desktop/shell/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		desktop({
			compilerOptions: {
				runes: ({ filename }: { filename: string }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
				experimental: { async: true }
			},
			experimental: { remoteFunctions: true }
		})
	]
});
