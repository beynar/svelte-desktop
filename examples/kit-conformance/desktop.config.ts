import { defineConfig } from '@kitop/shell/config';

// A SvelteKit feature matrix, run in the real desktop shell (tests/kit.test.ts).
export default defineConfig({
	appName: 'Kit Conformance',
	identifier: 'dev.kitop.kit-conformance',
	window: { width: 900, height: 640 }
});
