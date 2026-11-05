<script lang="ts">
	let { data, children } = $props();
</script>

<nav>
	<a href="/">home</a> <a href="/load">load</a> <a href="/actions">actions</a> <a href="/remote">remote</a>
	<a href="/params/hello">params</a> <a href="/invalidate">invalidate</a> <a href="/prerendered">prerendered</a>
</nav>
<p id="layout">{data.layout}</p>
{@render children()}
