/** Worker side: initialize the binding, then run the service probes. */
import { runApplication } from '@quickgui/native/runtime';

await runApplication(() => import('./mission-qg-probe.ts'), {
	name: 'svelte-quickgui-probe',
	version: '0.0.0',
	identifier: 'dev.svelte-desktop.probe',
});
