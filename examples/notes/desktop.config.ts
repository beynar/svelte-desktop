import { defineConfig } from '@svelte-desktop/shell/config';

export default defineConfig({
	appName: 'Svelte Notes',
	identifier: 'dev.svelte-desktop.notes',
	window: { width: 960, height: 680, minWidth: 520, minHeight: 400, autosaveName: 'main' },
	fileTypes: [{ name: 'Markdown', extensions: ['md'], role: 'Viewer' }],
	usageDescriptions: { camera: 'Notes can attach photos from your camera.' }
});
