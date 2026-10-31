<script lang="ts">
	import '../app.css';
	import { resolve } from '$app/paths';
	let { children } = $props();
</script>

<nav>
	<img src="/logo.svg" alt="logo" width="24" height="24" />
	<a href={resolve('/')}>home</a>
	<a href={resolve('/about')}>about</a>
	<a href="/api/stats">api</a>
</nav>

{@render children()}
