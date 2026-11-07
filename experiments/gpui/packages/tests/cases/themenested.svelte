<script>
	import { theme } from '@svelte-desktop/gpuix/gen/nkit/theming.js';
	import Nested from './nestedtheme.svelte';
	const app = theme({ defaultTheme: 'dark', enableSystem: false, storageKey: null });
</script>
<div>
	<span>parent={app.resolvedTheme}</span>
	<Nested />
</div>
