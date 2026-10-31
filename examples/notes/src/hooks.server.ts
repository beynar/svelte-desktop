import { onDesktopReady } from '@svelte-desktop/shell/server';
import '#lib/server/update-probe.ts';

onDesktopReady((desktop) => {
	desktop.menu.set([
		{
			label: desktop.appName,
			submenu: [
				{ label: `About ${desktop.appName}`, role: 'about' },
				{ type: 'separator' },
				{ label: `Hide ${desktop.appName}`, role: 'hide', accelerator: 'Cmd+H' },
				{ type: 'separator' },
				{ label: `Quit ${desktop.appName}`, role: 'quit', accelerator: 'Cmd+Q' }
			]
		},
		{
			label: 'File',
			submenu: [
				{ label: 'New Note', id: 'new-note', accelerator: 'Cmd+N' },
				{ label: 'Export…', id: 'export', accelerator: 'Cmd+Shift+E' }
			]
		},
		{
			label: 'Edit',
			submenu: [
				{ label: 'Undo', role: 'undo', accelerator: 'Cmd+Z' },
				{ label: 'Redo', role: 'redo', accelerator: 'Cmd+Shift+Z' },
				{ type: 'separator' },
				{ label: 'Cut', role: 'cut', accelerator: 'Cmd+X' },
				{ label: 'Copy', role: 'copy', accelerator: 'Cmd+C' },
				{ label: 'Paste', role: 'paste', accelerator: 'Cmd+V' },
				{ label: 'Select All', role: 'selectAll', accelerator: 'Cmd+A' }
			]
		},
		{
			label: 'View',
			submenu: [
				{ label: 'Reload', role: 'reload', accelerator: 'Cmd+R' },
				{ label: 'Enter Full Screen', role: 'toggleFullScreen', accelerator: 'Cmd+Ctrl+F' }
			]
		},
		{
			label: 'Window',
			submenu: [
				{ label: 'Minimize', role: 'minimize', accelerator: 'Cmd+M' },
				{ label: 'Close', role: 'close', accelerator: 'Cmd+W' }
			]
		}
	]);
	// Menu clicks arrive in the Worker; forward the ones the page handles.
	desktop.on('menu', (e) => desktop.publish('menu', e.id));
	desktop.onBeforeQuit(() => console.log('[notes] beforeQuit: flushing'));
});
