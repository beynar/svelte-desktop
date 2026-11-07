/** Worker side: initialize the binding, then load the app module. */
import { runApplication } from '@quickgui/native/runtime';

await runApplication(() => import('./qg-mount.ts'), {
	name: 'svelte-quickgui',
	version: '0.0.0',
	identifier: 'dev.svelte-desktop.poc',
});
