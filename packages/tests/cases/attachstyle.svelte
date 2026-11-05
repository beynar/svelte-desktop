<script>
	import { style } from '@svelte-desktop/gpuix/gen/nkit/style.js';
	let hit = $state('no');
	const env = style({ p: 'md', bg: 'surface-raised' });
</script>
<div>
	<span {@attach env} {@attach (el) => { hit = el.styleProps === env ? 'yes' : 'no'; }}>a={hit}</span>
</div>
