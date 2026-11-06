import { defineConfig } from '@kitop/shell/config';

export default defineConfig({
	// This example exercises the whole API from its pages. A real app lists what its pages use.
	bridge: { allow: ['*'] },
	appName: 'Panes',
	identifier: 'dev.kitop.panes',
	window: { width: 1280, height: 820, minWidth: 640, minHeight: 400, titleBarStyle: 'hiddenInset' }
});
