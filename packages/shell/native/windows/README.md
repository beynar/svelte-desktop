# Windows backend (Win32 + WebView2)

Builds on the portable core (`../portable`). Cross-compiled from macOS/Linux with
llvm-mingw in Docker: `native/build-windows.sh x64 arm64` → `native/build/windows-<arch>/shell.dll`.
Packaging is in `src/build/package-windows.ts` (`build: { target: 'windows' }`).

## Verified on Windows
CI runs `examples/notes/tests/windows.test.ts` on a real Windows runner (`.github/workflows/windows.yml`):
WebView2, WinRT toasts, the COM toast activator. What's listed below as not run yet still hasn't been.
The same file now also tests windows, the title bar, menus, tray, dialogs, clipboard, views, screen and
DPI, jobs, MCP, relaunch and web content control: those tests haven't run yet either.

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
6. Mixed-DPI multi-monitor coordinates; best-effort graceful quit at logoff.
7. Missing WebView2 runtime → a dialog links to the Evergreen download
   (suppressed with `KITOP_TEST` / `KITOP_NO_DIALOGS`).

## Title bar
`titleBarStyle` other than `default` → a frameless window (WS_POPUP + resizable frame); drag regions
move it (WM_NCLBUTTONDOWN/HTCAPTION), double-click maximizes. Checked under Wine (style switch);
the drag needs WebView2, so it is part of the first real Windows run.

## Embedded views and capture
`view.*` (svc_embed.cc): a child HWND per view hosting its own WebView2 controller, browser-like
navigation, same ops/events as macOS and Linux. `capture.*`: displays (EnumDisplayMonitors) and
windows (EnumWindows), PNG through BitBlt / PrintWindow + WIC. Compiled (x64, arm64), not run:
both need WebView2 / a real desktop session.

## Notifications (compiled, not run)
`svc_notifications.cc`: WinRT toasts through the ABI interfaces (combase resolved at run time),
AUMID = identifier registered under `HKCU\Software\Classes\AppUserModelId` + set on the process and
on the installer's Start Menu shortcut; ScheduledToastNotification for `at`/`repeat` (8 occurrences
ahead, topped up); taskbar overlay badge; balloons as the fallback; `toastXml` used as is.
Packaged apps also get a COM toast activator (CLSID derived from the identifier, `LocalServer32 =
"<exe>" -ToastActivated`, `CustomActivator`, shortcut `ToastActivatorCLSID`) so clicks after the app
quit launch it and land in the claim queue. To check on Windows: toasts show with the app name/icon,
Activated/Dismissed reach the UI thread, reply input, scheduled toasts while closed, a click after
quitting (cold start → claim), taskbar grouping with the pinned shortcut.

## Web content control (compiled, not run)
Same ops, result shapes and events as macOS, so `src/platform` doesn't know the difference. None of
this COM code has executed on Windows: `windows.test.ts` has a test for each, and those are the first
thing to read after a CI run.
- `svc_web_policy.cc`, permissions: `PermissionRequested` (camera, microphone, geolocation) and
  `ScreenCaptureStarting` (`screenRecording`) held with a deferral; `SavesInProfile` off, or WebView2
  would stop asking. Saved decisions in `%LOCALAPPDATA%\<identifier>\web-permissions.json`.
  `_permissionPolicyForTesting` as on macOS, for the test channel.
- `svc_web_policy.cc`, navigation policy: `NavigationStarting` and `FrameNavigationStarting` of views.
  They have no deferral, so the handler pumps messages until the Worker answers (10 s at most). The
  answer comes through the run queue; WebView2 runs its callbacks serially and holds them meanwhile.
- `svc_downloads.cc`: `DownloadStarting` + `ICoreWebView2DownloadOperation`, records in
  `downloads.json`. WebView2 can't start a download: `webview.download` has the page do it, with
  `<a download>` on its own origin and a hidden frame elsewhere. Pause holds the operation, so a
  transfer resumes only in its own run.
- `svc_webview.cc`, printing: `ICoreWebView2PrintSettings(2)` from the options macOS takes, validated
  the same way (points → inches); `Print` for silent jobs, `EnumPrinters` for `getPrinters`. To check:
  whether `PrintToPdf` honors `PageRanges`, and a real silent job (no runner printer takes one quietly).
- `svc_cookies.cc`: `sessions.*` on the default profile through `ICoreWebView2CookieManager`.
  No cookie event in WebView2: `watchCookies` compares the profile once a second.

## Not implemented (answer `unsupported`)
Window: simple fullscreen, controlsArea, shadow, movable, all workspaces,
focusable, represented file, character palette. App: activation policy, hide others,
default icon. Dock menu. Permission checks / settings panes. Thermal state. Keychain-style
`authenticate`. Webview: find, file drop, JS dialog automation, custom context menu, lifecycle events,
`clearData`, registered scripts, content rules, authentication challenges (`configurePolicy` with
kind `auth`), certificate exceptions, client identities. Sessions: named profiles (`create`, `remove`,
through `ICoreWebView2ControllerOptions` when they come), proxies.
`shortcutReleased` (Windows has no hotkey key-up).
