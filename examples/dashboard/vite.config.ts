import tailwindcss from '@tailwindcss/vite';
import { desktop } from '@kitop/shell/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		desktop({
			compilerOptions: {
				runes: ({ filename }: { filename: string }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			}
		})
	]
});
