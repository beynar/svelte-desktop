import { runApplication } from '@quickgui/native/runtime';
await runApplication(() => import('./mission-qg-multiwin.ts'), {
	name: 'multiwin-probe', version: '0.0.0', identifier: 'dev.svelte-desktop.multiwin',
});
