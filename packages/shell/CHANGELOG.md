# Changelog

Every release of `@kitop/shell`. The [versioning policy](https://svelte-desktop-docs.beynar.workers.dev/reference/versioning) says what each kind of release may change.

## 0.1.0

The first version made to be installed as a package.

### Breaking

`desktop()` no longer wraps SvelteKit's plugin: it goes next to it, `plugins: [sveltekit({ … }), desktop()]`, and SvelteKit's options stay in `sveltekit()`. A desktop-only app writes `desktop({ website: false })`, and what was the second argument of `desktop()` is now its only one.

These were made before there was a version to bump. They're listed for anyone who followed the repository.

**The project is now kitop.**

| Before | After |
| --- | --- |
| `@svelte-desktop/*` | `@kitop/*` |
| the `svelte-desktop` command | `kitop` |
| `SVELTE_DESKTOP_*` variables | `KITOP_*` |
| the Python package `svelte_desktop` | `kitop` |
| example identifiers | `dev.kitop.*` |

The native headers are `kitop.h` for the C ABI, `KitopObjC.h` and `KitopObjC.m` for Objective-C. The Windows toast activator CLSID is derived from the name, so it changes.

**Tabs.** `<WindowTabs>` is the one component, configured by its props and drawn with snippets: the window's tabs, which are your SvelteKit routes. Tabs inside a page are plain Svelte.

- `new Tabs({…})`, `<Tabs>`, `<TabPanels>`, `persist`, and `TabGroup`'s `primary`, `route` and `id` options are gone.
- `TabBar` and `TabContent` are internal.
- A tab is any object with an `id`, and your own fields: no more `data` wrapper.
- `newTab` replaces `create`. `initial` and `onLastClose` are gone.
- A control inside a tab no longer activates the tab.

**`host.store`** keeps each app's own file in its data folder, not one file shared by every app in the OS's app-data root. Nothing is migrated: an app that used it starts empty, and the old file stays where it was.

**Mobile is gone.** iOS can't run Bun, so the app's own server can't run there. The last version with mobile is tagged `mobile-last`.

- Removed config keys: `ios`, `build.androidArch`, `build.aab`, `sign.ios`, `sign.android`, `push.fcm`, `push.unifiedPush`, `notifications.channels`.
- Removed: FCM in `createPush`, the notification channel API and Android-only options (`channel`, `summary`, `color`, `visibility`), `launch({ android | ios })`, iOS and Android icon outputs.
- Kept: APNs on macOS, Web Push, the self-hosted push server.

**Built apps.**

- The app's server keeps its port across launches, derived from its identifier, so web views keep `localStorage` and IndexedDB. Changing an app's `identifier` changes its port, and so its stored data.
- A build signed to be distributed has no test channel. `KITOP_TEST_BUILD=1` keeps it.
- Packaged apps ignore `KITOP_LIB`, `KITOP_ADDONS` and `KITOP_SIDECAR_*`.
- The macOS hardened runtime no longer allows `DYLD` variables.

**The command.** `kitop doctor` exits with status 1 when a check fails. It used to exit 0 whatever it found, so a script that ran it for the report now has to accept that.

### Added

- A project can be a website and a desktop app. With `desktop()` next to `sveltekit({ adapter: adapter() })`, `kitop dev` and `kitop build` are the website, on your adapter, and `--mac`, `--windows` or `--linux` make them the desktop app. `kitop init` now sets a project up this way, and `desktop({ website: false })` is a desktop app only.
- The package is ready to publish: `files`, `exports` with `types` and `svelte` conditions, `engines`, `repository`, `publishConfig`, and `bun run check:package`, which fails if the package is incomplete. It stays `private` for now.
- `kitop create` pins `@kitop/shell` to the version that ran it, and takes the required versions of SvelteKit, the adapter and Svelte from the package.
- `kitop doctor` checks the installed versions of SvelteKit, the adapter and Svelte against the ones required.

### Fixed

- `vite dev` works with the package installed in `node_modules`: the dependency optimizer could not read its `.svelte.ts` sources.
- The package's sources type-check under an app's config, through every entry point.
- A project from `kitop create` no longer has a test that fails off macOS: the Swift sample's test only runs there.
