import { defineConfig } from '@kitop/shell/config';

// A SvelteKit feature matrix, run in the real desktop shell (tests/kit.test.ts).
export default defineConfig({
	appName: 'Kit Conformance',
	identifier: 'dev.kitop.kit-conformance',
	window: { width: 900, height: 640 },
	// tests/bridge.test.ts: a list a real app would have. KIT_NO_LIST, tests/release.test.ts: none.
	...(process.env.KIT_NO_LIST ? {} : { bridge: { allow: ['clipboard.readText', 'window.*', 'events.emit'] } })
});
