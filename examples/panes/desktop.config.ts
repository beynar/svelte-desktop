import { defineConfig } from '@svelte-desktop/shell/config';

export default defineConfig({
	appName: 'Panes',
	identifier: 'dev.svelte-desktop.panes',
	window: { width: 1280, height: 820, minWidth: 640, minHeight: 400, titleBarStyle: 'hiddenInset' }
});
