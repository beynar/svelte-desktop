import { defineConfig } from '@svelte-desktop/shell/config';

export default defineConfig({
	appName: 'Svelte Notes',
	identifier: 'dev.svelte-desktop.notes',
	window: { width: 960, height: 680, minWidth: 520, minHeight: 400, autosaveName: 'main', titleBarStyle: 'hiddenInset' },
	schemes: ['svelte-notes'],
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
	// APNs needs a provisioning profile with Push Notifications on devices/macOS; the simulator registers without one.
	push: { apns: true }
});
