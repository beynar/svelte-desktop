import { defineConfig } from '@kitop/shell/config';

export default defineConfig({
	// This example exercises the whole API from its pages. A real app lists what its pages use.
	bridge: { allow: ['*'] },
	appName: 'Dashboard',
	identifier: 'dev.kitop.dashboard',
	// `dashboard file.md` in a terminal opens it here (the Modules page installs the command).
	command: 'dashboard',
	protocols: ['asset'],
	window: { width: 1280, height: 820, minWidth: 520, minHeight: 400, autosaveName: 'dashboard', titleBarStyle: 'hiddenInset' },
	// Asked the first time a page uses them (the Form page's voice note, getUserMedia).
	permissions: {
		microphone: 'Record voice notes in your forms.',
		camera: 'Take a photo for your avatar.'
	},
	// Also in French: the permission prompts and the standard menus (Édition, Fenêtre…) for French users.
	locales: {
		fr: {
			permissions: {
				microphone: 'Enregistrer des notes vocales dans vos formulaires.',
				camera: 'Prendre une photo pour votre avatar.'
			}
		}
	}
});
