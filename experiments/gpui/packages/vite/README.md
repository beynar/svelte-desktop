# svelte-desktop-native

A Vite plugin that compiles a **SvelteKit-shaped `src/routes` app for the
native GPUI/Gpuix renderer** — no DOM, no webview. You author ordinary
SvelteKit-style routes, components, `load` functions and `$app/*` imports;
the plugin transparently compiles them for the in-process kit-shaped runtime
(`@svelte-desktop/svelte`) and the gdom → native-op pipeline
(`@svelte-desktop/gpuix`).

This is the packaged form of `packages/svelte/build.ts` (which remains the
specification and is untouched). There is **no `@sveltejs/kit` dependency**:
the kit-shaped client runtime in `packages/svelte/kit` is the runtime.

## What it does

| authored code                         | what happens                                                            |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `src/routes/**/+page.svelte` etc.     | scanned into `virtual:svelte-native/manifest` (`routes`, `endpoints`, `matchers`) |
| `<script>`/markup in `.svelte`        | `svelte/compiler` → `generate: 'client'`                                  |
| `.svelte.js` / `.svelte.ts`           | `compileModule` (runes lowered, TS stripped)                              |
| `import { page } from '$app/state'`   | aliased to `runtime/` shims → kit runtime                                 |
| `import ... from '@sveltejs/kit'`     | aliased to the same kit runtime surface                                   |
| `<style>` in a component              | `css: 'external'` → `parseStylesheet` → `registerSheet(id, rules)`        |
| `import './x.css'`                    | stripped from JS, harvested into the native stylesheet registry           |
| `src/hooks.ts` (optional)             | passed to `createRouter({ hooks })`                                       |
| `src/params/foo.ts` (optional)        | emitted as matchers (`[foo=bar]` constraints)                             |

### Route files

`+page.svelte`, `+page.{ts,js}`, `+page.server.{ts,js}`, `+layout.svelte`,
`+layout.{ts,js}`, `+layout.server.{ts,js}`, `+error.svelte`, `+server.{ts,js}`.

- `(group)` directories strip to no URL segment.
- Dynamic segments `[id]`, rest `[...rest]`, optional `[[opt]]`, and
  `[id=matcher]` constraints work; matchers resolve from `src/params`.
- Layouts dedupe by directory and are shared across routes (kit semantics).
- `+page.server`'s `actions` is only emitted when the file exports it.

## Install / setup

The package lives at `packages/vite` in this repo. The native stack it
compiles against is the sibling workspace packages — `@svelte-desktop/gpuix`
(`gdom`, `native.ts`, `native-css`) and `@svelte-desktop/svelte` (`kit/`) —
see `paths.js` if those ever move.

### `vite.config.js` in your app

```js
import { svelteNative } from '@svelte-desktop/vite';

export default {
	plugins: [svelteNative()],
};
```

Options (all optional):

```js
svelteNative({
	routesDir: 'src/routes', // route surface
	paramsDir: 'src/params', // param matcher modules
});
```

### `svelte.config.js` (optional)

Not required — the plugin drives `svelte/compiler` itself and doesn't read
`preprocess`/`compilerOptions`. Keep one only if you also run real kit.

## Build

```sh
bun packages/vite/build.js <appRoot> \
	--title "My App" --width 1180 --height 780 --path /
```

Output: `<appRoot>/.svelte-native/app.js` — a spawnable bundle:

```sh
bun <appRoot>/.svelte-native/app.js
```

Flags: `--outDir`, `--backend` (default `@gpuix/native`), `--renderer`
(constructor name, default `GpuixRenderer`), `--headless`, `--routes`,
`--params`, `--title`, `--width`, `--height`, `--path`.

`--headless --renderer TestGpuixRenderer` builds a no-window smoke bundle:
it pumps renderer events, prints `[svelte-native painted] <text>` to stdout
and exits — the CI path used by `test/e2e.test.ts`.

You can also call `buildNativeApp({ root, ... })` from `emit.js` directly —
it's the shared emission + `vite build` path used by the CLI, the dev script
and the adapter.

## Dev

```sh
bun packages/vite/dev.js <appRoot> [same flags]
```

Builds, spawns the app, watches `<appRoot>/src`, `packages/gpuix/src` and
`packages/svelte`, and
**restarts the process** on rebuild. Restart — not a remount signal — is the
correct seam today: `gpuix/src/native.ts` exposes no remount/re-init API, and the
mounted tree, router singleton, gdom doc and its listener registry are
module-level state with no teardown. If a remount API lands, swap
`restart()` in `dev.js` for a signal emit.

`--once` does a single build+launch without watching.

## Adapter vs CLI

`adapter.js` exports `adapterSvelteNative()` — a `{ name, async adapt(builder) }`
object with the SvelteKit adapter shape. It exists for config compatibility
and standalone invocation, but a real `svelte-kit build` can't run here
(that pipeline *is* `@sveltejs/kit` internals, which this stack deliberately
avoids). **The `build.js` CLI is the supported production path.**

## Transparency limits

- **No SSR** — components compile to the client runtime only.
- **No real DOM** — elements are gdom nodes → native mutation ops. DOM-only
  APIs (`innerHTML`, `querySelector`, canvas, observers…) don't exist.
- **No webview** — there is no browser anywhere in the pipeline.
- **`<style>` is the native subset** — rules go through
  `@svelte-desktop/gpuix/native-css/parse` → the Rust stylesheet engine
  (`stylesheet.register` op). Selectors/properties outside that subset are
  dropped with a warning; if `parse.ts` is missing the sheet registers empty
  and a warning is emitted.
- **Renderer ops** — class tokens use the `setClass` op and stylesheets use
  `stylesheet.register`/`stylesheet.unregister`. These need the owned
  renderer build (`packages/gpuix/native/`, built with cargo); the published
  `@gpuix/native` 0.8.0 binary predates them — on it the tree mounts but
  class/sheet styling is silently dropped (the op batch retries once then
  drops).
- **`+server.ts` runs in-process** — "server" loads, actions and endpoints
  execute in the same Bun process as the renderer. `browser = true` is
  intentional: this *is* the client runtime.
- **`@gpuix/native` must be resolvable** from the app root (native backend).
- **No HMR** — dev mode restarts the process (see Dev).

## Layout

```
vite-plugin.js   the plugin (aliases, transforms, virtual modules, watchers)
manifest.js      src/routes scan → manifest code (build.ts algorithm)
emit.js          entry emission + vite build (shared by CLI/dev/adapter)
build.js         CLI: bun build.js <appRoot>
dev.js           dev loop: build → spawn → rebuild → restart
adapter.js       kit-adapter-shaped wrapper over emit.js
paths.js         repo paths + svelte-client-entry/subpath resolution
runtime/         $app/* shims → @svelte-desktop/svelte kit runtime
test/            bun tests + fixture app (test/fixtures/app)
```

## Tests

```sh
cd packages/vite && bun test
```

18 tests: alias/transform/unit coverage plus an end-to-end that builds the
fixture and executes it on `TestGpuixRenderer`, asserting painted text.
The e2e needs `@gpuix/native` resolvable from the fixture (deployed
`.node` copies live under `test/fixtures/app/node_modules/@gpuix/native/`)
and a renderer binary with the newer ops (see Transparency limits).
