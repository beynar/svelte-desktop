<script>
	// <ComponentTheme components={{button:{…}, chip:{…}}}> — the svelai
	// setComponentTheme subtree override as a component: entries register via
	// context and apply to descendants only (below the <Theme components>
	// registry, above instance `theme` props in the ladder).
	//   entry: { size:'large'…(prop defaults), root|slot: StyleProps|{base,…},
	//            motion:{in,out,duration,easing}, override:true }
	import { setComponentTheme } from './theming.svelte.js';

	let { components = {}, children } = $props();
	for (const [name, entry] of Object.entries(components)) setComponentTheme(name, entry);
</script>

{@render children?.()}
