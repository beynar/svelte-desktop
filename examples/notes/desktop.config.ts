import { defineConfig } from '@svelte-desktop/shell/config';

export default defineConfig({
	appName: 'Svelte Notes',
	identifier: 'dev.svelte-desktop.notes',
	window: { width: 960, height: 680, minWidth: 520, minHeight: 400, autosaveName: 'main', titleBarStyle: 'hiddenInset' },
	schemes: ['svelte-notes'],
	// Keeps running with no window (menu-bar icon, Dock click reopens): pushes keep arriving.
	quitOnLastWindowClosed: false,
	fileTypes: [{ name: 'Markdown', extensions: ['md'], role: 'Viewer' }],
	permissions: {
		camera: 'Notes can attach photos from your camera.',
		screenRecording: 'Notes can attach a screenshot of your screen.'
	},
	push: {
		// Our own push server, no Apple account
		// (`bun run push-server` here; in production, deploy servePush() anywhere).
		server: process.env.NOTES_PUSH_SERVER ?? 'http://127.0.0.1:47123'
	}
});
