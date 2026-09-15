# SvelteKit compatibility — measured matrix

Evidence: `gpuix-poc/src/kit-conformance.ts` — **49/49 cases pass**
(`bun src/kit-conformance.ts`, run 2026-09-15). Router/runtime: `src/kit/`
+ generated manifest `src/gen/routes/manifest.js` (17 routes, 2 endpoints,
1 matcher). Every row below cites a live case or an explicit gap.

## Working — exercised by conformance

| Feature | Status | Evidence |
|---|---|---|
| `+page.svelte`/`+layout.svelte`/`+error.svelte` | exact | boot, error-boundary cases |
| `+page.ts`/`+layout.ts` universal loads | exact | `boot`, `via-data` |
| `+page.server.ts`/`+layout.server.ts` | exact (native-adapted: same-process "server") | `notes-in-db` via bun:sqlite |
| `handle`, `locals`, `sequence` hooks | exact | boot case |
| `reroute`, `handleFetch`, `handleError` | exact | dedicated cases |
| `goto`/`invalidate`/`invalidateAll`/`refreshAll`/`preloadData`/`beforeNavigate`/`afterNavigate`/`onNavigate`/`pushState`/`back`/`forward` | exact | named cases |
| Link interception (`<a href>`) | exact | case |
| `[param]`, `[...rest]`, `[[optional]]`, `[param=matcher]`, `(group)` | exact | dedicated cases |
| `error()`→nearest `+error.svelte`, unexpected→500 boundary, 404→`route.id=null` | exact | cases |
| Form actions: default + `?/named`, `fail()`, `redirect()`, `use:enhance`, GET-as-nav, submitter value | exact | cases |
| Streaming load promises | exact | `stream` case |
| Shallow routing / `page.state` / hash nav | exact | cases |
| `$app/navigation` `$app/paths` `$app/environment` `$app/state` `$app/server` | exact | cases |
| `depends()`/`invalidate(url|predicate)` tracking | exact | cases |
| cookies incl. `cookies.set` in actions persisting | exact | case |
| `getRequestEvent`/`getClientAddress`/`read` | exact | `$app/server` case |
| Remote functions `query()/command()/form()` + spread-props dispatch | exact (SvelteKit 3-next experimental API) | remote cases |
| Nav coalescing/cancellation, `navigating` store + `.complete` | exact | cases |
| Layout state persistence across nav | exact | case |
| SSR | n/a — no browser target; "server" modules run in-process under Bun | deliberate native adaptation |

## Deliberate native adaptations (not bugs)

- "Server" code runs in the same Bun process (no HTTP hop) unless the app is
  also compiled as the `app/` server binary — remote functions then go through
  the real adapter-bun path (verified: `build-bin/server` serves them).
- No DOM hydration (nothing rendered server-side to hydrate).
- History is an in-app stack — no browser session history, no URL bar.
- `event.fetch` works; Request/Response are real, but there is no service
  worker / browser cache layer.

## Known gaps (honest)

| Feature | Status | Impact |
|---|---|---|
| SSR/prerender/ISR | unsupported (meaningless headless) | none for desktop |
| `service-worker` | unsupported | none |
| `+server.ts` OPTIONS/HEAD/HTTP semantics beyond GET/POST | partial | endpoints are real but not a general HTTP server in-window |
| CSRF/origin checks | adapted (fixed origin baked at compile for binary builds) | documented in vite.config.binary.ts |
| `disableScrollHandling` nuance | implemented, scroll semantics differ (native scroll) | minor |
| Multi-window routing state | untested | each window needs own router or shared service |
| Focus restore on nav | partial | a11y follow-up |
| `svelte/motion`, `animate:flip` | implemented-but-lightly-tested | README caveats |

## Svelte 5 surface (gpuix-poc conformance, 45/45)

runes (`$state`/`$derived`/`$effect`/`$props`/`$bindable`), stores, context,
`{#key}`/`{#if}`/`{#each}` keyed/`{#await}`, snippets, `use:` actions,
`transition:`/`in:`/`out:` (real outro keep-alive), `bind:*` (value/checked/
files **excluded** — bind:files unsupported), event modifiers, component
composition, lifecycle, cleanup. Component lib: nkit ~45 components, Theme,
motion ladder — 30/30 nkit cases.
