<script lang="ts">
	import '../../app.css';
	import { resolve } from '$app/paths';
	import StatusItem from '@svelte-desktop/shell/platform/StatusItem.svelte';
	import { onMount } from 'svelte';
	let { children } = $props();
	let responses = $state<string[]>([]);

	// Notification clicks/actions/replies (one that launched the app included). A notification's
	// `url` navigates on its own; this only keeps a log.
	onMount(() => host.notifications.on('response', (e) => {
		responses = [...responses, `${e.kind} ${e.id}${e.actionId ? ` ${e.actionId}` : ''}${e.input ? `: ${e.input}` : ''}`].slice(-5);
	}));
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

<output id="notification-log" hidden={!responses.length}>{responses.join(' · ')}</output>

{@render children()}
