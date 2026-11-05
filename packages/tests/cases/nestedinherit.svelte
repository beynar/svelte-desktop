<script>
	// Nested theme() with NO defaultTheme inherits the parent's resolved
	// theme instead of falling back to 'light'/system — a scoped override
	// should look like the app it sits under.
	import { theme } from '@svelte-desktop/gpuix/gen/nkit/theming.js';
	const t = theme({ enableSystem: false, storageKey: null });
</script>
<span>child={t.resolvedTheme}</span>
