# Windows backend (Win32 + WebView2)

Builds on the portable core (`../portable`). Cross-compiled from macOS/Linux with
llvm-mingw in Docker: `native/build-windows.sh x64 arm64` → `native/build/windows-<arch>/shell.dll`.
Packaging is in `src/build/package-windows.ts` (`build: { target: 'windows' }`).

## Verified on Windows
CI runs `examples/notes/tests/windows.test.ts` on a real Windows runner (`.github/workflows/windows.yml`):
WebView2, WinRT toasts, the COM toast activator, windows, the title bar, menus, tray, dialogs, clipboard,
views, screen and DPI, jobs, MCP, relaunch and web content control; `windows-web.test.ts` the rest of
web control; `windows-sessions.test.ts` sessions, proxies, schemes, content rules, scripts and the input
policy; `windows-desktop.test.ts` the quit phases, metrics, the icon, the rich clipboard, route dialogs, the
jump list, bookmarks, drag out, the share sheet and Windows Hello. x64 only, on one display at 100%.

## Verified without Windows
- Clean build (`-Wall -Wextra`, llvm-mingw, WebView2 SDK headers); every `shell.h` export
  present; only system DLLs + UCRT imported; the built-in WebView2 loader (no WebView2Loader.dll).
- Wine smoke (`native/docker/windows/wine-smoke.sh`): ABI, window create, 60 platform calls
  with expected values, close veto → `willClose`, close → `closed`, last window ends the loop,
  popovers, `events.emit`, what web content control does without a web view (registration,
  validation, saved decisions). WebView2 is absent under Wine, so no page was loaded.
- Packaging: GUI-subsystem exe with icon/version/manifest resources (patched after
  cross-compilation, since Bun's `--windows-icon` etc. only work on a Windows host),
  zip, NSIS installer (per-user install, Start Menu, URL schemes, file associations,
  uninstaller — install/uninstall checked under Wine), Authenticode with osslsigncode,
  signed `update.json` (`windows-x64`, `windows-arm64`).

## Risks to check beyond what CI covers
1. WebView2 environment creation goes through the runtime's internal entry point
   (`CreateWebViewEnvironmentWithOptionsInternal`), as webview/webview's built-in loader does.
2. COM apartment: WebView2 needs STA on the UI thread; if Bun initialised the main thread
   as MTA, creation fails (logged).
3. Bun on Windows: FFI threadsafe `JSCallback`s and blocking the main thread in the Win32
   message loop are unexercised.
4. Bridge timing: `chrome.webview.postMessage` source origin and the `ready` message order.
5. If an icon doesn't fit Bun's resource section, a new section is appended after `.bun`
   (Bun is assumed to locate its payload by section name; the example used the in-place path).
6. Mixed-DPI multi-monitor coordinates; a real logoff (see below).
7. Missing WebView2 runtime → a dialog links to the Evergreen download
   (suppressed with `KITOP_TEST` / `KITOP_NO_DIALOGS`).

## Title bar
`titleBarStyle` other than `default` → a frameless window (WS_POPUP + resizable frame); drag regions
move it (WM_NCLBUTTONDOWN/HTCAPTION), double-click maximizes. Checked under Wine (style switch);
the drag needs WebView2, so it is part of the first real Windows run.

## Embedded views and capture
`view.*` (svc_embed.cc): a child HWND per view hosting its own WebView2 controller, browser-like
navigation, same ops/events as macOS and Linux. `capture.*`: displays (EnumDisplayMonitors) and
windows (EnumWindows), PNG through BitBlt / PrintWindow + WIC.

## Notifications
`svc_notifications.cc`: WinRT toasts through the ABI interfaces (combase resolved at run time),
AUMID = identifier registered under `HKCU\Software\Classes\AppUserModelId` + set on the process and
on the installer's Start Menu shortcut; ScheduledToastNotification for `at`/`repeat` (8 occurrences
ahead, topped up); taskbar overlay badge; balloons as the fallback; `toastXml` used as is.
Packaged apps also get a COM toast activator (CLSID derived from the identifier, `LocalServer32 =
"<exe>" -ToastActivated`, `CustomActivator`, shortcut `ToastActivatorCLSID`) so clicks after the app
quit launch it and land in the claim queue.

## Web content control
Same ops, result shapes and events as macOS, so `src/platform` doesn't know the difference.
`windows.test.ts` has a test for each.
- `svc_web_policy.cc`, permissions: `PermissionRequested` (camera, microphone, geolocation) and
  `ScreenCaptureStarting` (`screenRecording`) held with a deferral; `SavesInProfile` off, or WebView2
  would stop asking. Saved decisions in `%LOCALAPPDATA%\<identifier>\web-permissions.json`.
  `_permissionPolicyForTesting` as on macOS, for the test channel.
- `svc_web_policy.cc`, navigation policy: `NavigationStarting` and `FrameNavigationStarting` of views,
  and `WebResourceRequested` on documents, which keeps a refused request off the network.
  They have no deferral, so the handler pumps messages until the Worker answers (10 s at most). The
  answer comes through the run queue; WebView2 runs its callbacks serially and holds them meanwhile.
- `svc_downloads.cc`: `DownloadStarting` + `ICoreWebView2DownloadOperation`, records in
  `downloads.json`. WebView2 can't start a download: `webview.download` has the page do it, with
  `<a download>` on its own origin and a hidden frame elsewhere. Pause holds the operation, so a
  transfer resumes only in its own run.
- `svc_webview.cc`, printing: `ICoreWebView2PrintSettings(2)` from the options macOS takes, validated
  the same way (points → inches); `Print` for silent jobs, `EnumPrinters` for `getPrinters`. To check:
  whether `PrintToPdf` honors `PageRanges`, and a real silent job (no runner printer takes one quietly).
- `svc_web_policy.cc`, authentication: `BasicAuthenticationRequested`, `ServerCertificateErrorDetected` and
  `ClientCertificateRequested`, each with a deferral. No handler or `default`: no credential, no certificate,
  and a refused server certificate, never WebView2's login box, its picker or its error page with a way past it.
  `revokeCertificate` also calls `ClearServerCertificateErrorActions`, since an exception WebView2 was given
  stays otherwise. Client identities are the certificates with a private key in the user's personal store.
- `svc_web_control.cc`, what every web view gets: `find` through `ICoreWebView2Find`; JavaScript dialogs
  through `ScriptDialogOpening`, shown by the shell as a modal dialog so `respondToDialog` can answer;
  `IsMuted`, `IsDocumentPlayingAudio`, and a script in each document for `pauseMedia`, the playback state and
  the tracks `getUserMedia` gave (no WebView2 call says what a page captures); `setRecovery` and
  `_terminateForTesting` (`Page.crash`, a real crash).
- File drop: the OS talks to the browser process's own drop target, so the host never sees the drag. The page
  script reports it, with a nonce so a page can't forge one, and sends the drop's `File`s with
  `postMessageWithAdditionalObjects`, which `ICoreWebView2File` turns into paths. It takes `dragover` for file
  drags: without that a page with no drop zone gets no `drop`. A page doesn't see the paths before the drop,
  so `fileDragEnter` has none. Frames report through `ICoreWebView2Frame2`. `AllowExternalDrop` stays on:
  `setFileDrop(false)` stops the events, as elsewhere, not the page's own drop.
- `setBackgroundThrottling`: `IsVisible` is off while a window or view is hidden or minimized, which is what
  slows the page down, and it stays on with throttling off. A covered window isn't hidden: WebView2 isn't told.
- `clearData`: `ClearBrowsingData` has no site filter, and without `app` the app's data has to stay. Sites are
  cleared one by one with `Storage.clearDataForOrigin`, from the origins views and frames loaded
  (`web-sites.json`), cookies through the cookie manager. `ClearBrowsingData` does `app: true` and the disk cache.
  What a site stored before this record existed isn't reached without `app`.
- `svc_cookies.cc`: cookies of every session through `ICoreWebView2CookieManager`. No cookie event in
  WebView2: `watchCookies` compares the profiles with a view open once a second.
- `svc_web_sessions.cc`, sessions: a named one is a WebView2 profile (`ICoreWebView2ControllerOptions`
  `ProfileName`, `IsInPrivateModeEnabled`), with a hidden web view holding it open and reaching its cookies.
  The shell's `__kitop` cookie is copied in before each load of the app's pages, as on the other platforms.
  `sessions.json` says which profile a persistent id is, so a removed one comes back empty: WebView2 won't
  reopen a profile it's deleting.
- `svc_web_sessions.cc`, proxies: `--proxy-server` for a whole environment, so a session's first proxy gives it
  an environment and a user data folder of its own, in `WebView2-sessions`. Its cookies are copied, the rest of its
  storage is deleted. A later change waits for `BrowserProcessExited`, ends that process if it hasn't gone after five
  seconds (it once hadn't after 15 on the runner, reason unknown), and starts it again on the same folder.
  `setProxy` refuses while a view is open in the session, and on the default session. These arguments come from
  the app's server code: `g_browser_arguments` still keeps `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` out of
  distributed builds. The host is checked, since it ends up on a command line.
- `svc_web_sessions.cc`, schemes: `ICoreWebView2EnvironmentOptions4` on every environment, with an authority,
  not secure, any origin. `WebResourceRequested` with a deferral. A blocking `IStream` was tried and doesn't work:
  WebView2 reads a stream to its end before the page sees anything, and reads a document's on the UI thread, where
  `E_PENDING` ends the request and blocking would hold every web view's callbacks. So a response is held in
  memory until `protocol.finish`. A request's end is only known from its view or its document going.
- `svc_web_sessions.cc`, content rules: matched here from `WebResourceRequested`, only while rules exist, on a
  small NFA for WebKit's restricted syntax. `css-display-none` is a script in each document. Refused because tried
  and found not to hold: `block-cookies` (cookies are added after the event), `websocket` (no event).
- `svc_web_sessions.cc`, scripts: `AddScriptToExecuteOnDocumentCreated`; named worlds through the DevTools protocol
  (`Page.addScriptToEvaluateOnNewDocument`). On a change a web view's are removed and added again, for their order.
- `svc_web_sessions.cc`, input policy: `AcceleratorKeyPressed`. It reports what's held with Control or Alt and keys
  that make no character: real presses of Enter, Tab, Space, Backspace and characters with no event reached the
  page, so rules for those are refused. A low-level keyboard hook could reach them, but it's a system-wide hook in
  every app: not done.

## The app on the desktop
- `svc_app.cc`, quit: every source goes through the phases of `platform_app.mm`: `app.quit`, the menu, `shell_quit`, the
  console's Ctrl+C and Ctrl+Break, and a close of the last window, whose document stays until the vote ends. `window.close`
  destroys it first and asks after, as on macOS. A session's end wants an answer at once: with a guard it's refused, with a reason
  (`ShutdownBlockReasonCreate`), while the vote goes on. `WM_ENDSESSION` ends the vote one way or the other. Tried with those
  messages sent from another process, and with the Restart Manager (`RmShutdown`), which is the system's own. No real logoff.
- `svc_desktop.cc`, `app.metrics`: Toolhelp's process tree, `PrivateUsage` as the footprint, `GetProcessExtendedInfos` for which
  are renderers and, from their frames, which window's page they draw.
- `svc_desktop.cc`, the icon and `accessory`: `WM_SETICON` and `WS_EX_TOOLWINDOW`. Read back from another process; the taskbar's
  button really goes away and comes back, through UI Automation.
- `svc_desktop.cc`, `files.*`: `FILE_ID_INFO` in the bookmark, `OpenFileById` when it isn't at its path.
- `svc_desktop.cc`, `shell.startDrag`: `DoDragDrop` on the shell's data object. It takes the files as `CF_HDROP`: given as items with
  no parent folder, a drop target received nothing. The page's process has the keyboard, so `QueryContinueDrag` asks for Escape itself.
- `svc_clipboard.cc`, `read`, `write`: as on macOS, with `CF_UNICODETEXT` and `CF_HTML` turned to and from plain bytes.
- `svc_dialog.cc`, `dialog.sheet`: a window owned by its parent, which is disabled meanwhile, with a web view of its own. `X-Desktop-View`
  goes on its first request through `NavigateWithWebResourceRequest`.
- `svc_menu.cc`, `menu.setDockMenu`: the jump list's tasks, which start the executable with `--kitop-jump-task=<base64>`. The second
  instance forwards it like any other. The list was seen on the real taskbar, and a real click on a task reached the app.
- `svc_winrt.cc`, `shell.share`, Hello: a WinRT operation is looked at from the UI thread until it ends. The share sheet does open; on the
  runner it says it can't list targets, so nothing has been chosen. `DataPackage.Destroyed` ends the call if the sheet just goes away.
  The runner has no Hello: the prompt is unrun. The interfaces mingw-w64 has no header for are declared there, and a test asks the
  runner's factories for their ids.

## Not implemented
`hideOthers`, `previewFile`, `permissions.*`, `thermalState` (registered, answers `unavailable`) and the test-only
`simulateResponse`, `testScroll`: `website/docs/shipping/limitations.mdx` says why. Window: parent after creation, level, aspect ratio,
simple fullscreen, controlsArea, shadow, movable, all workspaces, focusable, represented file, character palette, and macOS's materials.
Webview: custom context menu, lifecycle events other than `terminated` and a session's failed load.
`shortcutReleased` (Windows has no hotkey key-up).
