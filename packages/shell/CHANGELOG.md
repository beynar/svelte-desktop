# Changelog

Every release of `@kitop/shell`. The [versioning policy](https://svelte-desktop-docs.beynar.workers.dev/reference/versioning) says what each kind of release may change.

## 0.1.0

The first version made to be installed as a package.

### Breaking

The updater refuses a manifest, archive or patch that isn't on `https`. `http` still works on a loopback address.

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
- Every build writes `THIRD_PARTY_NOTICES.txt` into what it ships: the licenses of Bun, kitop, the native shell's libraries and every npm package with code in the app, read from each package at build time.
- `kitop init` writes `bridge: { allow: [] }`, with what `host.store`, `host.windowState` and the rest need, and `notifications.*` when the pages use the web's `Notification` API.
- `kitop doctor` checks that the project's own `sveltekit()` shows the options kitop reads (`api.options`).
- Windows and Linux: `window.setParent`, `getParent`, `getChildren` and the `parentId` option, as owned and transient windows.
- Windows and Linux: `window.setAspectRatio`, `getAspectRatio`, `getLevel`, `setSimpleFullscreen`, `isSimpleFullscreen`, `setMovable`, `isMovable`, and the `aspectRatio`, `movable` and `focusable` options.
- Windows: `window.setFocusable`, `isFocusable`, `setHasShadow`, `hasShadow`, `controlsArea` and `showCharacterPalette`.
- Windows 11 22H2: `window.setVibrancy`, `getVibrancy`, `setGlass`, `getGlass` and the `vibrancy` option, as Mica and Acrylic backdrops.
- Linux: `window.setTheme`, `getTheme`, `setCursorHidden`, `isCursorHidden`, `setDocumentEdited`, `isDocumentEdited`, `setMinimizable`, `isMinimizable`, `setMaximizable`, `isMaximizable`.

- One project, two sides: `+page.desktop.svelte`, `+page.server.desktop.ts`, `+layout.desktop.svelte`, `+server.desktop.ts` and `hooks.server.desktop.ts` take the place of their file in the desktop app, and the website ignores them. `desktop({ routes: { exclude } })` keeps routes out of the app. `import.meta.env.KITOP_DESKTOP` says which side the code is built for, at build time.
- Windows: the cancellable quit, `host.app.onQuitRequested`, `onBeforeQuit` and `onWillQuit`, from the last window's close, the menu, the API, Ctrl+Break and a session's end, reported as `logout`, `shutdown` or `system`.
- Windows: `host.app.metrics`, with the window whose page each process draws.
- Windows: `host.app.showAll`, `setDockIcon`, `getDockIcon`, `defaultWindowIcon`, and `setActivationPolicy`: `accessory` is out of the taskbar.
- Windows: `host.clipboard.read` and `write`, with registered formats.
- Windows: `host.dialog.sheet` and `close`: a route as a modal window owned by its parent.
- Windows: `host.menu.closePopup`, and `setDockMenu` as the taskbar's jump list, whose tasks reach the app as `menuAction`.
- Windows: file bookmarks through NTFS ids, which follow a file within its volume.
- Windows: `host.shell.startDrag`, and `share` through the system's share sheet.
- Windows: `host.system.biometrics` and `host.secureStorage.authenticate` through Windows Hello. Its prompt hasn't been run.
- Windows: `host.sessions.create` and `remove`, and the `session` option of windows, views and popovers: WebView2 profiles, with cookies per session.
- Windows: `host.sessions.setProxy`, in a browser process of the session's own. It can't change while a view is open in the session, and the default session can't have one.
- Windows: custom protocols, declared with `protocols` and answered by `host.protocol`. A response reaches the page whole, when it ends: WebView2 can't take less.
- Windows: `setContentRules`, `removeContentRules` and `listContentRules`, matched by the shell. `block-cookies` is refused, and WebSockets aren't reached.
- Windows: `scripts.register`, `scripts.unregister` and `scripts.list`, named worlds included.
- Windows: `setInputPolicy`, `getInputPolicy` and `onBeforeInput`, for what's held with Control or Alt and keys that make no character. Other rules are refused.
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
- Windows: `onAuthChallenge`, `allowCertificate` and `revokeCertificate`, for Basic, Digest and NTLM, server certificates and client certificates.
- Windows: `listClientIdentities`, from the user's personal certificate store.
- Windows: `find` and `clearFind`.
- Windows: `getDialog`, `respondToDialog` and `onJsDialog`. JavaScript dialogs are now the shell's own.
- Windows: `setAudioMuted`, `pauseMedia` and `getMediaState`.
- Windows: `setBackgroundThrottling`. A hidden or minimized window now tells its page it's hidden, as a hidden view already did.
- Windows: `setRecovery`, and `onLifecycle` reports `terminated`.
- Windows: `setFileDrop` with `onFileDragEnter`, `onFileDragLeave` and `onFileDrop`. `getInfo` reports real `fileDrop`, `backgroundThrottling` and `recovery` values.
- Windows: `clearData`.
- Windows: `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` is honored, as with Microsoft's loader.
- An update for a signed app has to be signed by the same Apple team or Windows publisher.
- `release merge` and `make-manifest` take `--expires-in-days`: after that date, clients refuse the manifest.
- A project can be a website and a desktop app. With `desktop()` next to `sveltekit({ adapter: adapter() })`, `kitop dev` and `kitop build` are the website, on your adapter, and `--mac`, `--windows` or `--linux` make them the desktop app. `kitop init` now sets a project up this way, and `desktop({ website: false })` is a desktop app only.
- The package is ready to publish: `files`, `exports` with `types` and `svelte` conditions, `engines`, `repository`, `publishConfig`, and `bun run check:package`, which fails if the package is incomplete. It stays `private` for now.
- `kitop create` pins `@kitop/shell` to the version that ran it, and takes the required versions of SvelteKit, the adapter and Svelte from the package.
- `kitop doctor` checks the installed versions of SvelteKit, the adapter and Svelte against the ones required.
- Linux: the cancellable quit. `host.app.onQuitRequested` can veto a quit from the API, a signal, the menu or the last window closing; `onBeforeQuit` and `onWillQuit` are awaited, each within 10 seconds, with `quitCancelled` and `quitTimedOut`.
- Linux: `app.metrics`, real numbers from `/proc` for the app and what it started. No `windowId`.
- Linux: `addRecentDocument` and `clearRecentDocuments` through `GtkRecentManager`, and `showAll` for the app's own windows. `host.app.clearRecentDocuments` now exists on every OS.
- Linux: `setDockBadge`, `getDockBadge`, `setDockProgress` and `getDockProgress` through the Unity launcher signal. A badge is a number.
- Linux: `bounceDock` as the window's urgency hint, `setDockIcon`, `getDockIcon` and `setIcon` as the windows' icon, `setActivationPolicy('accessory')` as skip-taskbar and skip-pager.
- Linux: `clipboard.read` and `clipboard.write`: HTML, RTF, images, files and custom types, published together.
- Linux: `dialog.sheet` and `dialog.close`: a route of the app in a transient modal window.
- Linux: `menu.closePopup`.
- Linux: `files.createBookmark`, `openBookmark` and `releaseBookmark`: the path and the file's identity, `stale` when it was renamed or replaced.
- Linux: `power.getSystemIdleTime` on X11, `power.getThermalState` and `thermalStateChanged` from the kernel's trip points, `unavailable` where a machine has none.
- Linux: `shell.previewFile` through GNOME's previewer, `unavailable` without it. `shell.startDrag` as XDND.
- Linux: on Wayland, `host.shortcuts` and `host.capture` go through the desktop portal instead of answering `unsupported`. Run against a stand-in for the portal only.
- Linux: `getAccessibility` also reads GNOME's high-contrast switch and `GTK_THEME`.

### Fixed

- A website whose SvelteKit doesn't show its options the way kitop reads them (`api.options`) stops with an error that names the SvelteKit version, as the desktop side does. It used to go on without them, and `.desktop` files and `routes.exclude` stopped applying without a word.
- `kitop dev --windows` and `kitop build --windows` on a Windows machine: they looked for macOS's library, ran a shell script Windows can't run, and wrote imports with backslashes. They still need Docker Desktop in Linux containers mode, or a `shell.dll` from elsewhere, and `kitop doctor` says so.
- `kitop create` on Windows named the project after its whole path.
- On macOS, a canceled download that can't be resumed no longer leaves half a file behind.
- A page with `events.emit` could read and write any file in the app's data folder, on Linux its web permissions too. It's now limited to the store, the window state and the saved tabs.
- Without `events.emit`, `host.store` and `host.windowState` reject at once with `denied`, instead of timing out as if the server didn't answer.
- A write the disk takes only part of no longer leaves a cut-off file (the store, the window state, the updater's state). What the native side saves on Windows and Linux reaches the disk before it replaces the old file.
- Updater: on a signed app, `codesign` or PowerShell not answering refuses the update. On Windows every `.exe`, `.dll` and addon is checked and signed, not just some.
- Linux: `sessions.setProxy` refuses a host that isn't one.
- Windows: a page could hand its camera, microphone and location to a frame of another origin with `allow=`. HTML pages now carry a `Permissions-Policy` that keeps them to the app. A page's own header replaces it.
- Windows signing timestamps over https by default. `notarytool` has a timeout and tries again when it gets no answer.
- Windows: a double click on a drag region could do nothing: the first press started a move loop that swallowed the second.
- A job keeps running no longer when its app dies without a word: it gets its `signal` aborted, then two seconds to leave.
- A store or window-state write is on the disk when it returns, and the store comes back from its previous save if its file goes bad.
- A check that gets no answer gives up after 30 s, a download after 60 s without a byte.
- Windows: `app.relaunch()` started nothing, so neither did the restart after a server crash: the hidden PowerShell was created without a console and exited at once.
- Windows: an update never installed, for the same reason in its helper, and a user name with an accent broke the helper's script.
- `vite dev` works with the package installed in `node_modules`: the dependency optimizer could not read its `.svelte.ts` sources.
- The package's sources type-check under an app's config, through every entry point.
- A project from `kitop create` no longer has a test that fails off macOS: the Swift sample's test only runs there.
