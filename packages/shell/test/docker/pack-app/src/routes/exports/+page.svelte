<script lang="ts">
	// Every entry a page can use, imported from the installed package: statically, so that server
	// rendering and the page both have to load them. Copied in a new project by test/docker/pack.sh.
	import * as client from '@kitop/shell/client';
	import * as native from '@kitop/shell/native';
	import * as tabs from '@kitop/shell/tabs';
	import WindowTabs from '@kitop/shell/tabs/WindowTabs.svelte';
	import * as platform from '@kitop/shell/platform';
	import * as stores from '@kitop/shell/stores';
	import MenuBar from '@kitop/shell/platform/MenuBar.svelte';
	import StatusItem from '@kitop/shell/platform/StatusItem.svelte';
	import Popover from '@kitop/shell/platform/Popover.svelte';
	import PopoverContent from '@kitop/shell/platform/PopoverContent.svelte';
	import * as windowState from '@kitop/shell/platform/window-state';
	import * as store from '@kitop/shell/platform/store';
	import * as ai from '@kitop/shell/ai';
	import * as aiSdk from '@kitop/shell/ai-sdk';
	// Reached by a deep path: what matters is that it imports its dependency from inside
	// node_modules, which Vite doesn't prebundle. It has to work as it comes, in the browser.
	import { tabDrop } from '../../../node_modules/@kitop/shell/src/tabs/drag.ts';
	import { onMount } from 'svelte';

	const entries = [client, native, tabs, WindowTabs, platform, stores, MenuBar, StatusItem, Popover, PopoverContent, windowState, store, ai, aiSdk];
	let hydrated = $state(false);
	let target: HTMLElement;
	onMount(() => {
		hydrated = true;
		return tabDrop(target, { tabs: {} as never, indicate() {} }).destroy;
	});
</script>

<p id="entries" data-hydrated={hydrated}>{entries.filter(Boolean).length}</p>
<div id="drop" bind:this={target}></div>
