<script>
	// forcedTheme wins over the selection — a nested/forced scope never
	// drifts to the OS or stored pref.
	import { theme } from '@svelte-desktop/gpuix/gen/nkit/theming.js';
	const app = theme({ defaultTheme: 'dark', forcedTheme: 'light', enableSystem: false, storageKey: null });
</script>
<span>forced={app.resolvedTheme}</span>
