import { svelteNative } from '@svelte-desktop/vite';
import { defineConfig } from 'vite';

// `vite dev` boots the native GPUI window (emit → build → spawn, restart on
// change). `vite build` emits the spawnable bundle to .svelte-native/app.js.
export default defineConfig({
	plugins: [
		svelteNative({
			title: 'svelte·desktop — notes',			
			compilerOptions: {
				experimental: { async: true },
			},
		}),
	],
});
