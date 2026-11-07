/**
 * Single indirection point: every $app/* shim re-exports from here, which
 * re-exports the kit-shaped client runtime that ships in the sibling
 * packages/svelte package (kit/runtime.svelte.js — the same file build.ts
 * compiles into src/gen/kit/). A `.svelte.js` module — the plugin's
 * compileModule transform handles it like any other source file.
 *
 * If the runtime ever moves, this is the only file that changes.
 */
export * from '@svelte-desktop/svelte/kit/runtime.svelte.js';
