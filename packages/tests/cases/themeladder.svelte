<script>
	// componentTheme's instance-theme arg takes a getter — `() => inst` —
	// so a REPLACED theme object stays visible. A captured value would
	// freeze the instance level at init: clicking would keep size=sm.
	// Also covers the slot-level crash guard: a primitive where a slot
	// entry belongs drops with a diagnostic instead of `for…in` walking
	// string indices.
	import { componentTheme, theme } from '@svelte-desktop/gpuix/gen/nkit/theming.js';
	import { isNativeStyle } from '@svelte-desktop/gpuix/gen/nkit/style.js';
	theme({ defaultTheme: 'dark', enableSystem: false, storageKey: null });
	let inst = $state({ size: 'sm' });
	const ct = componentTheme('probe', () => inst, ['icon']);
	const slotOk = () => isNativeStyle(ct.slot('icon', null, {}, null));
</script>
<div>
	<button onclick={() => (inst = { size: 'xl', icon: 'garbage' })}>size={ct.props({}).size ?? 'none'}</button>
	<span>slot={slotOk() ? 'ok' : 'bad'}</span>
</div>
