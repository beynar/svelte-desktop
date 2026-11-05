<script>
	import { createRawSnippet } from 'svelte';
	const snip = createRawSnippet(() => ({
		render: () => `<div style="color: #ffcc00">raw-snippet-out</div>`,
		setup: (el) => { el.setAttribute('data-raw', '1'); },
	}));
</script>
<div>{@render snip()}</div>
