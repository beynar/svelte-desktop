import { defineConfig } from '@svelte-desktop/shell/config';

export default defineConfig({
	appName: 'Dashboard',
	identifier: 'dev.svelte-desktop.dashboard',
	window: { width: 1280, height: 820, minWidth: 520, minHeight: 400, autosaveName: 'dashboard', titleBarStyle: 'hiddenInset' }
});
