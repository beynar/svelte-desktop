<script>
	// A theme() call under an existing theme context is the scoped lane:
	// provides its own ThemeState to descendants, skips the global setTheme
	// emit and the persistence lane. t.decl drops onto an element's `theme`
	// prop when the subtree also needs native rescoping.
	import { theme } from '@svelte-desktop/gpuix/gen/nkit/theming.js';
	const t = theme({ defaultTheme: 'light', enableSystem: false, storageKey: null });
</script>
<span>child={t.resolvedTheme}</span>
