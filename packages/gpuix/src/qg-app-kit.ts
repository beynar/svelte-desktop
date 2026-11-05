/** Worker side for the kit app on QuickGUI. */
import { runApplication } from '@quickgui/native/runtime';

await runApplication(() => import('./qg-mount-kit.ts'), {
	name: 'svelte-kit-quickgui',
	version: '0.0.0',
	identifier: 'dev.svelte-desktop.poc.kit',
});
