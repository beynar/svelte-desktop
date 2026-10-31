# Web view features (`webview.*`)

Native: `native/platform_webview.mm`. Typed API: `webview` in `src/platform/index.ts`.
Tests: `test/platform/webview.ts`.

Every WKWebView the shell creates, windows and popovers alike, goes through
`platform_webview_configure()`. That call attaches a per-view state object to the
web view. The state owns our `WKUIDelegate` (WKWebView only holds it weakly) and the
view's settings. WKWebView is patched once, at class level, for drag & drop and
`willOpenMenu:withEvent:`. Each patch calls through to the original, and does nothing
for views the shell didn't configure.

**Target of an op:** `popoverId`, else `windowId` (0 = primary), else the page that
made the call (window or popover), else the primary window. Every web-view event
carries either `windowId` or `popoverId`.

## Ops

| op | |
|---|---|
| `setZoom {zoom}` / `getZoom` | `pageZoom`, clamped to 0.25–5 |
| `find {text, backwards?, caseSensitive?, wraps?}` → `{matchFound}` | `findString:withConfiguration:` (macOS 11+) |
| `clearFind` | clears the selection (WebKit has no public API to hide the find highlight) |
| `setContextMenu {mode, items?, editMenu?, all?}` / `getContextMenu` | see below |
| `setFileDrop {enabled, all?}` | on by default |
| `download {url, path?}` → `{id}` | uses the page's session (cookies). Relative URLs resolve against the page |
| `setDownloadDirectory {path\|null}` / `getDownloadDirectory` | default `~/Downloads` |
| `cancelDownload {id}` / `listDownloads` | |
| `print {silent?, pdfPath?}` | see below |
| `printToPDF {path}` | paginated PDF from the print system, with no panel |
| `respondToDialog {accept?, text?}` / `getDialog` | answers the open alert, confirm or prompt (automation) |
| `executeJavaScript {code}` → JSON value | see below |
| `capturePage {rect?, width?, format?, quality?}` → `{data, width, height}` | base64 PNG or JPEG via `takeSnapshotWithConfiguration` |
| `reload {ignoreCache?}`, `stop`, `goBack`, `goForward`, `getInfo` | |
| `setUserAgent {userAgent}` (`''` = WebKit's default), `getUserAgent` | |
| `setInspectable {enabled}` | macOS 13.3+, otherwise `unsupported` |
| `app.getOpenedFiles` (alias `webview.getOpenedFiles`) → `{paths}` | returns the cold-launch document queue and clears it |
| `_test {action}` | internal test hooks; not part of the API |

**Events:** `fileDragEnter`, `fileDragLeave`, `fileDrop` `{paths, x, y}`,
`contextMenu`, `jsDialog`, `downloadStarted`, `downloadProgress`, `downloadFinished`,
`downloadFailed`, `printFinished`, `closeRequested`, `openFiles`.

## Behaviour and decisions

- **alert / confirm / prompt.** On a window, these are native sheets, so the run loop
  is never blocked. A popover, or a window that already shows a sheet, gets an
  app-modal alert instead. That modal is started outside any GCD block, so the
  dispatcher keeps running while it is up. Each dialog emits
  `jsDialog {type, message, defaultValue?}`.
- **`<input type=file>`.** Same behaviour as webview/webview (`allowsMultipleSelection`,
  `allowsDirectories`), but shown as a sheet.
- **getUserMedia.** Access is granted only to the app origin. The Info.plist must also
  contain `NSCameraUsageDescription` / `NSMicrophoneUsageDescription`: without the
  string, macOS kills the process on first capture, so the request is denied and a
  message is logged. If macOS has already denied access, the request is denied. If the
  user hasn't decided yet, the system prompt is shown first. Geolocation has no public
  WKUIDelegate API on macOS and is not handled.
- **window.open.** `createWebViewWithConfiguration` returns nil. The navigation policy
  already sends these URLs to the browser.
- **window.close().** An injected user script routes it to the shell, because WebKit
  only allows it on pages with at most one history entry. `webViewDidClose:` uses the
  same path. On a window, it calls `performClose:`, which respects the close veto. On a
  popover, it emits `closeRequested {popoverId}` and the app decides.
- **window.print().** Routed to the same print path as `webview.print` by the user
  script.
- **Print.**
  - Interactive (the default): the print panel opens as a sheet and the op resolves
    `{started:true}` immediately. `printFinished {success}` follows when the panel
    closes.
  - `silent`: prints to the default printer with no panel.
  - `pdfPath`: writes a paginated PDF instead of printing; it implies `silent`.
  - With `silent` or `pdfPath`, the op resolves only when the job is done.
  - If the window already shows a sheet, the op fails with `unavailable`.
- **File drop.**
  - The patched `draggingEntered:`, `draggingExited:` and `performDragOperation:`
    read `NSPasteboardTypeFileURL`, emit the events, then call WebKit.
  - **The page still gets its normal DOM `dragenter` / `dragover` / `drop` events**
    with `File` objects. The `fileDrop` event adds the real paths, which the DOM can't
    expose.
  - `x` and `y` are CSS px from the page's top-left corner (zoom is accounted for).
  - If the page doesn't `preventDefault()` the drop, WebKit tries to navigate to the
    file. The navigation policy cancels that, so the page stays.
- **Downloads.** Three sources start a download:
  - `<a download>`: `shouldPerformDownload` makes the navigation-action policy return
    Download.
  - A navigation response that WebKit can't show (`canShowMIMEType == NO`) or that has
    `Content-Disposition: attachment`: the response policy returns Download, and the
    page stays where it is.
  - The `webview.download` op.

  Files are saved to the download directory under a unique name (`name (1).ext`). An
  explicit `path` overwrites any existing file. The events:
  - `downloadStarted {id, url, path, suggestedFilename, totalBytes, mimeType}`.
  - `downloadProgress {receivedBytes, totalBytes, fraction}`, at most once every
    250 ms, and only when the byte count changed.
  - `downloadFinished {path, bytes}`.
  - `downloadFailed {error, canceled}`. A cancelled download also deletes its partial
    file.
- **executeJavaScript.** The code runs with
  `callAsyncJavaScript("return await (0, eval)(code)")` in the page world. It has
  script semantics: the result is the value of the last statement, promises are
  awaited, and the result comes back through `JSON.stringify`. A thrown error becomes
  `internal` with the JS message. If the page's CSP forbids `unsafe-eval`, the op falls
  back to `evaluateJavaScript`, which does not await promises.
- **Context menu.** Default mode: `none`, unless the view was created with `debug`, in
  which case it is `default`.
  - `default`: WebKit's own menu.
  - `none`: no menu. The exception is `editMenu` (default true): when the click is on
    editable text or a selection, WebKit's **Cut / Copy / Paste and spelling
    suggestions** stay. That is what production apps ship (Slack, VS Code, Discord):
    Reload, Back, "Look Up", "Search with Google", Share and the "Spelling and
    Grammar" submenu are gone, but a text field still works with the mouse. Pass
    `editMenu: false` for truly nothing. When no item is left, no menu is shown at
    all.
  - `custom`: your `MenuItemSpec[]` (items emit `menuAction {id}`), with the edit
    items above them when editing.
  - Debug views always keep **Inspect Element**, whatever the mode.
  - Independently of the mode, a capture-phase `contextmenu` listener emits
    `contextMenu {x, y, linkURL?, srcURL?, selectionText?, editable, mode}`. An app
    that wants to decide in JS can `preventDefault()` in its own listener, which
    suppresses the native menu, and then call `menu.popup`.
- **Open files.** `application:openURLs:` (platform_core.mm) passes file URLs to
  `openFiles {paths}` and scheme URLs to `openUrls`. Files received before any app
  page has reached DOMContentLoaded (a cold launch from a double-clicked document) are
  also queued. Read the queue with `app.getOpenedFiles()`, which clears it, and listen
  to `openFiles` for later opens.

## Packager: `fileTypes` → Info.plist

`fileTypes: [{ name: 'Markdown', extensions: ['md'], role: 'Editor' }]` should produce:

```xml
<key>CFBundleDocumentTypes</key>
<array>
  <dict>
    <key>CFBundleTypeName</key>            <string>Markdown</string>
    <key>CFBundleTypeRole</key>            <string>Editor</string>      <!-- role, default Editor -->
    <key>LSHandlerRank</key>               <string>Default</string>     <!-- rank, default Default -->
    <key>CFBundleTypeExtensions</key>      <array><string>md</string></array>
    <!-- only when utis is given: -->
    <key>LSItemContentTypes</key>          <array><string>net.daringfireball.markdown</string></array>
  </dict>
</array>
```

- **When `utis` is set**, LaunchServices uses `LSItemContentTypes` and ignores
  `CFBundleTypeExtensions`. In that case, emit `LSItemContentTypes` and keep the
  extensions only as a fallback.
- **For a custom extension with no system UTI**, also export one under
  `UTExportedTypeDeclarations`, for example:

  ```xml
  <dict>
    <key>UTTypeIdentifier</key>      <string>{identifier}.mytype</string>
    <key>UTTypeConformsTo</key>      <array><string>public.data</string></array>
    <key>UTTypeTagSpecification</key><dict><key>public.filename-extension</key><array><string>mytype</string></array></dict>
  </dict>
  ```

  Then reference that identifier in `LSItemContentTypes`.
- **Camera and microphone** (`getUserMedia`) need `NSCameraUsageDescription` and
  `NSMicrophoneUsageDescription`, which come from `usageDescriptions`.

## Not covered by the unattended tests

- A real Finder drag: the test feeds an in-process `NSDraggingInfo` to the patched
  WKWebView methods instead.
- The camera and microphone prompt (TCC).
- A Finder double-click on a document: the test calls the real
  `application:openURLs:` method in-process instead.
- A real printer.

The native context menu is tested with an in-process synthetic right-click: WebKit
builds its real menu and the menu is dismissed right away.
