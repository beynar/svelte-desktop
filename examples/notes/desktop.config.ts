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
	notifications: {
		channels: [
			{ id: 'messages', name: 'Messages', importance: 'high' },
			{ id: 'reminders', name: 'Reminders', importance: 'default' }
		]
	},
	push: {
		// iOS: APNs (needs a profile with Push Notifications on devices; the simulator registers without one).
		apns: true,
		// macOS / Windows / Linux: our own push server, no Apple or Google account
		// (`bun run push-server` here; in production, deploy servePush() anywhere).
		server: process.env.NOTES_PUSH_SERVER ?? 'http://127.0.0.1:47123'
	}
});
