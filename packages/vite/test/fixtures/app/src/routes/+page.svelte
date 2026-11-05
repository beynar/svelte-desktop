<script>
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import Card from './Card.svelte';
	import './chrome.css';

	let { data } = $props();
	let count = $state(0);
</script>

<h1 class="title">home — {data.greeting} ({page.url.pathname})</h1>
<Card n={count} />
<button onclick={() => count++}>inc</button>
<button onclick={() => goto('/about')}>about</button>

<style>
	.title {
		color: #fff;
		padding: 4px;
	}
</style>
