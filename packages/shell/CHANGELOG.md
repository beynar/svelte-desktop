# Changelog

Every release of `@kitop/shell`. The [versioning policy](https://svelte-desktop-docs.beynar.workers.dev/reference/versioning) says what each kind of release may change.

## 0.1.0

The first version made to be installed as a package.

### Breaking

Pages can't call native operations until you say so: without `bridge.allow`, the list is empty rather than everything. A refused call rejects with `denied`, and the console names the rule to add. `bridge: { allow: ['*'] }` brings back the old behavior. Server code isn't affected.

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

- Linux: `setNavigationPolicy` holds a navigation until the answer, so a refused one sends no request. `isMainFrame` is `null` there.
- Linux: `setPermissionHandler` and saved decisions, for camera, microphone, screen and location. `getUserMedia` now exists on Linux.
- Linux: `onAuthChallenge`, `allowCertificate` and `revokeCertificate`. `listClientIdentities` stays unsupported. Without a handler, a page asked for a login gets the server's answer instead of WebKit's login box.
- Linux: `find` and `clearFind`.
- Linux: `setContextMenu`, `getContextMenu` and `onContextMenu`, with the same modes as macOS. Without `debug`, a page now has no menu by default, as on macOS.
- Linux: `getDialog`, `respondToDialog` and `onJsDialog`. JavaScript dialogs are now the shell's own.
- Linux: `setAudioMuted`, `pauseMedia`, `getMediaState`, `setBackgroundThrottling` and `setRecovery`. Views now reload after a crash too, and `onLifecycle` reports `terminated`.
- Linux: `setFileDrop` with `onFileDragEnter`, `onFileDragLeave` and `onFileDrop`. `getInfo` reports real `fileDrop`, `contextMenu`, `backgroundThrottling` and `recovery` values.
- Linux: `download`, `setDownloadDirectory`, `host.downloads` and their events, with history across launches. `<a download>` works, and what a view can't show is saved instead of ignored. WebKitGTK can't pause: `pause` cancels and `resume` downloads the whole file again.
- Linux: `print`, `printToPDF` and `getPrinters`, with the options of the other platforms. `window.print()` now reports `onPrintFinished`.
- Linux: `clearData`.
- Linux: `host.sessions.cookies` and `onChanged`, HttpOnly cookies included. The default session's cookies are now kept across launches.
- Linux: `host.sessions` named profiles, private or persistent, with the `session` option of windows, views and popovers.
- Linux: `setProxy` and `getProxy` per session: HTTP, HTTP over TLS and SOCKS5, with credentials.
- Linux: custom protocols (`protocols` in the config, `host.protocol`), streaming, in every session.
- Linux: `setContentRules`, `removeContentRules` and `listContentRules`, in every session.
- Linux: `host.webview.scripts`, in the page or a named world.
- Linux: `setInputPolicy`, `getInputPolicy` and `onBeforeInput`. `meta` is the Super key.
- An update for a signed app has to be signed by the same Apple team or Windows publisher.
- `release merge` and `make-manifest` take `--expires-in-days`: after that date, clients refuse the manifest.
- A project can be a website and a desktop app. With `desktop()` next to `sveltekit({ adapter: adapter() })`, `kitop dev` and `kitop build` are the website, on your adapter, and `--mac`, `--windows` or `--linux` make them the desktop app. `kitop init` now sets a project up this way, and `desktop({ website: false })` is a desktop app only.
- The package is ready to publish: `files`, `exports` with `types` and `svelte` conditions, `engines`, `repository`, `publishConfig`, and `bun run check:package`, which fails if the package is incomplete. It stays `private` for now.
- `kitop create` pins `@kitop/shell` to the version that ran it, and takes the required versions of SvelteKit, the adapter and Svelte from the package.
- `kitop doctor` checks the installed versions of SvelteKit, the adapter and Svelte against the ones required.

### Fixed

- A job keeps running no longer when its app dies without a word: it gets its `signal` aborted, then two seconds to leave.
- A store or window-state write is on the disk when it returns, and the store comes back from its previous save if its file goes bad.
- A check that gets no answer gives up after 30 s, a download after 60 s without a byte.
- Windows: `app.relaunch()` started nothing, so neither did the restart after a server crash: the hidden PowerShell was created without a console and exited at once.
- Windows: an update never installed, for the same reason in its helper, and a user name with an accent broke the helper's script.
- `vite dev` works with the package installed in `node_modules`: the dependency optimizer could not read its `.svelte.ts` sources.
- The package's sources type-check under an app's config, through every entry point.
- A project from `kitop create` no longer has a test that fails off macOS: the Swift sample's test only runs there.
