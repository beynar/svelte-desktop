// Reactive theme revision — the CSS-variable moment for the native lane.
// `s()` and `resolveTokens()` read `themeRev.v` at resolve time, so every
// $derived style subscribes; bumping it restyles the whole mounted tree
// without remounting (applyStyle.update pushes the new StyleDesc).
//
// Own module with zero imports — tokens.js and style.js can both subscribe
// without a cycle back through theming.svelte.js.

import { untrack } from 'svelte';

export const themeRev = $state({ v: 0 });
// untracked: `v++` reads v — inside an $effect that read would subscribe the
// caller to the very signal it bumps, retriggering it forever
export const bumpTheme = () => untrack(() => themeRev.v++);
