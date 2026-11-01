<!-- tests/tabs.test.ts drives the window's tabs through this (dev only). -->
<script lang="ts">
	import { useTabs } from '@svelte-desktop/shell/tabs';

	(globalThis as { __tabs?: unknown }).__tabs = useTabs();
</script>
