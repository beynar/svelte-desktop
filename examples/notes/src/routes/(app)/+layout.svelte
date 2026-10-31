<script lang="ts">
	import '../../app.css';
	import { resolve } from '$app/paths';
	import StatusItem from '@svelte-desktop/shell/platform/StatusItem.svelte';
	let { children } = $props();
</script>

<!-- Menu-bar icon: click → the /quick route in a native popover (sized to its content). -->
<StatusItem icon="note.text" tooltip="Quick note" popover={{ route: '/quick', width: 320 }} />

<nav>
	<img src="/logo.svg" alt="logo" width="24" height="24" />
	<a href={resolve('/')}>home</a>
	<a href={resolve('/about')}>about</a>
	<a href={resolve('/platform')}>platform</a>
	<a href="/api/stats">api</a>
</nav>

{@render children()}
