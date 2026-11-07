<script>
	// theme() — the app-level theme as a function call, no wrapper element.
	// Called at init: provides the ThemeState to descendants (useTheme reads
	// the same object back through context) and ships the resolved declaration
	// to Rust through the `setTheme` op. The `theme` attribute on the inner
	// div is the scoped lane — a plain prop, setCustomProp under the hood.
	import { theme, useTheme } from '@svelte-desktop/gpuix/gen/nkit/theming.js';
	const app = theme({ defaultTheme: 'dark', enableSystem: false, storageKey: null });
	const ctx = useTheme();
</script>
<div>
	<span>theme={app.resolvedTheme} ctx={ctx === app ? 'same' : 'diff'}</span>
	<div theme={{ colors: { brand: '#123456' } }}><span>scoped</span></div>
</div>
