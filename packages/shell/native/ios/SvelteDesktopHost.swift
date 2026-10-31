// iOS host for a svelte-desktop app ("thin client"). iOS can't run Bun, so the
// SvelteKit server runs where you deploy it (or `vite dev` on your Mac); this
// app is a WKWebView on that origin with the same page bridge as the desktop
// shells: window.__shell → WKScriptMessageHandler `__shell__`, main frame of
// the app origin only, `permissions.pages` enforced here, and the desktop wire
// format {id, service, op, args} → platformResult {id, ok, value|error}.
//
// Configuration comes from Info.plist (written by src/build/package-ios.ts):
//   SDServerURL, SDAppName, SDIdentifier, SDPagePermissions (array, optional).
// SVELTE_DESKTOP_SERVER_URL overrides SDServerURL (dev); SVELTE_DESKTOP_TEST
// (debug builds) connects the e2e runner of @svelte-desktop/shell/test.
import AVFoundation
import LocalAuthentication
import Security
import UIKit
import UserNotifications
import WebKit

struct OpError: Error {
  let code: String
  let message: String
}

typealias Reply = (Result<Any?, OpError>) -> Void
typealias Op = (_ args: [String: Any], _ reply: @escaping Reply) throws -> Void

private let bridgeScript = """
  (()=>{if(window.__shell)return;const q=[];let sink=null;\
  const post=(m)=>window.webkit.messageHandlers.__shell__.postMessage(JSON.stringify(m));\
  window.__shell=Object.freeze({\
  post:(req)=>post({t:'call',req:typeof req==='string'?JSON.parse(req):req}),\
  setSink:(fn)=>{sink=fn;for(const [n,d] of q.splice(0))fn(n,d);},\
  deliver:(n,d)=>{sink?sink(n,d):q.push([n,d]);}});\
  document.addEventListener('DOMContentLoaded',()=>post({t:'ready'}));})();
  """

private func info(_ key: String) -> Any? { Bundle.main.object(forInfoDictionaryKey: key) }

private func originOf(_ url: URL?) -> String {
  guard let url, let scheme = url.scheme, let host = url.host else { return "" }
  return "\(scheme)://\(host)" + (url.port.map { ":\($0)" } ?? "")
}

private func json(_ value: Any?) -> String {
  let v = value ?? NSNull()
  guard let data = try? JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed]) else { return "null" }
  return String(decoding: data, as: UTF8.self)
}

// MARK: - Host

final class Host: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, UNUserNotificationCenterDelegate {
  static let shared = Host()
  var webView: WKWebView!
  weak var controller: UIViewController?
  var ops: [String: Op] = [:]
  var serverURL: URL!
  var origin = ""
  var pendingURLs: [String] = []
  var pageReady = false
  // Notification responses (NOTIFICATIONS.md): ring of the last 64, and the ones no page handled yet.
  var notificationSeq = 0
  var notificationRing: [[String: Any]] = []
  var unclaimedResponses: [[String: Any]] = []
  var foregroundBanners = true
  var pushToken: String?
  var pushReplies: [Reply] = []
  private var test: TestChannel?

  // Services with no iOS equivalent answer `unsupported`, as on Linux for macOS-only ops.
  let desktopOnly: Set<String> = ["menu", "tray", "popover", "dock", "shortcuts", "view", "capture", "screen", "power", "windows", "plugins"]

  func makeWebView() -> WKWebView {
    let env = ProcessInfo.processInfo.environment
    let raw = env["SVELTE_DESKTOP_SERVER_URL"] ?? (info("SDServerURL") as? String) ?? ""
    serverURL = URL(string: raw)
    origin = originOf(serverURL)

    let config = WKWebViewConfiguration()
    if (info("SDOffline") as? Bool) == true {
      // Offline mode: the bundled build (www/) at app://localhost.
      config.setURLSchemeHandler(BundleSchemeHandler(root: Bundle.main.bundleURL.appendingPathComponent("www")), forURLScheme: "app")
    }
    let ucc = WKUserContentController()
    ucc.add(self, name: "__shell__")
    ucc.addUserScript(WKUserScript(source: bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    config.userContentController = ucc
    config.allowsInlineMediaPlayback = true
    webView = WKWebView(frame: .zero, configuration: config)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = true
    #if DEBUG
      webView.isInspectable = true
    #endif
    registerServices()
    #if SD_PLUGIN
      desktopSetup() // the app's Swift plugin (native/*.swift, native/ios/*.swift)
    #endif
    UNUserNotificationCenter.current().delegate = self
    if let url = env["SVELTE_DESKTOP_TEST"], isDebugBuild, url.hasPrefix("ws://127.0.0.1:") { test = TestChannel(url: url, host: self) }
    return webView
  }

  var isDebugBuild: Bool { (info("SDDebug") as? Bool) == true }

  func start() {
    guard let serverURL, !origin.isEmpty else {
      webView.loadHTMLString("<h2 style='font:17px -apple-system;padding:40px'>No server URL: set <code>ios.serverUrl</code> in desktop.config.ts.</h2>", baseURL: nil)
      return
    }
    webView.load(URLRequest(url: serverURL))
  }

  // MARK: bridge

  func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
    // Main frame of the app origin only: third-party frames and navigations away never reach native.
    guard message.frameInfo.isMainFrame else { return }
    let o = message.frameInfo.securityOrigin
    let from = "\(o.protocol)://\(o.host)" + (o.port > 0 ? ":\(o.port)" : "")
    guard from == origin, let body = message.body as? String,
      let msg = (try? JSONSerialization.jsonObject(with: Data(body.utf8))) as? [String: Any]
    else { return }
    if msg["t"] as? String == "ready" {
      pageReady = true
      flushURLs()
      return
    }
    guard msg["t"] as? String == "call", let req = msg["req"] as? [String: Any] else { return }
    let id = req["id"] ?? 0
    let service = req["service"] as? String ?? "", op = req["op"] as? String ?? ""
    guard pageAllowed(service, op) else {
      deliver("platformResult", ["id": id, "ok": false, "error": ["code": "denied", "message": "\(service).\(op) is not in permissions.pages"]])
      return
    }
    dispatch(service, op, req["args"] as? [String: Any] ?? [:]) { [weak self] result in
      self?.deliver("platformResult", Host.reply(id, result))
    }
  }

  static func reply(_ id: Any, _ result: Result<Any?, OpError>) -> [String: Any] {
    switch result {
    case .success(let v): return ["id": id, "ok": true, "value": v ?? NSNull()]
    case .failure(let e): return ["id": id, "ok": false, "error": ["code": e.code, "message": e.message]]
    }
  }

  private lazy var pagePermissions: [String]? = info("SDPagePermissions") as? [String]

  func pageAllowed(_ service: String, _ op: String) -> Bool {
    guard let rules = pagePermissions else { return true }
    return rules.contains { $0 == "*" || $0 == "\(service).\(op)" || ($0.hasSuffix(".*") && String($0.dropLast(2)) == service) }
  }

  func dispatch(_ service: String, _ op: String, _ args: [String: Any], _ done: @escaping Reply) {
    var sent = false
    let once: Reply = { r in
      DispatchQueue.main.async {
        guard !sent else { return }
        sent = true
        done(r)
      }
    }
    guard let handler = ops["\(service).\(op)"] else {
      let known = desktopOnly.contains(service) || ops.keys.contains { $0.hasPrefix("\(service).") }
      once(.failure(known ? OpError(code: "unsupported", message: "\(service).\(op) is not available on iOS") : OpError(code: "unknown", message: "unknown platform service `\(service)`")))
      return
    }
    do { try handler(args, once) } catch let e as OpError { once(.failure(e)) } catch { once(.failure(OpError(code: "internal", message: "\(error)"))) }
  }

  func deliver(_ name: String, _ data: Any) {
    webView.evaluateJavaScript("window.__shell&&window.__shell.deliver(\(json(name)),\(json(data)))", completionHandler: nil)
  }

  /** Events go to the page and to the test runner. */
  func emit(_ name: String, _ data: [String: Any]) {
    DispatchQueue.main.async {
      self.deliver(name, data)
      self.test?.event(name, data)
    }
  }

  // MARK: deep links

  func open(url: URL) {
    pendingURLs.append(url.absoluteString)
    flushURLs()
  }

  private func flushURLs() {
    guard pageReady, !pendingURLs.isEmpty else { return }
    emit("openUrls", ["urls": pendingURLs])
    pendingURLs.removeAll()
  }

  // MARK: navigation

  func webView(_ wv: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    let url = action.request.url
    // The app origin stays in the web view; other main-frame navigations open outside.
    if action.targetFrame?.isMainFrame != false, originOf(url) != origin, let url, url.scheme != "about" {
      decisionHandler(.cancel)
      UIApplication.shared.open(url)
      return
    }
    decisionHandler(.allow)
  }

  func webView(_ wv: WKWebView, didStartProvisionalNavigation nav: WKNavigation!) { pageReady = false }

  func webViewWebContentProcessDidTerminate(_ wv: WKWebView) { wv.reload() }

  func webView(_ wv: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
    let msg = error.localizedDescription.replacingOccurrences(of: "<", with: "&lt;")
    wv.loadHTMLString("<h2 style='font:17px -apple-system;padding:40px'>Cannot reach \(origin)<br><small>\(msg)</small></h2><script>setTimeout(()=>location.replace(\(json(serverURL.absoluteString))),3000)</script>", baseURL: nil)
  }

  // target=_blank / window.open → outside the app
  func webView(_ wv: WKWebView, createWebViewWith c: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url { UIApplication.shared.open(url) }
    return nil
  }

  // JS dialogs as native alerts.
  func webView(_ wv: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    alert(message, nil, ["OK"], cancel: 0) { _ in completionHandler() }
  }

  func webView(_ wv: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    alert(message, nil, ["OK", "Cancel"], cancel: 1) { completionHandler($0 == 0) }
  }

  // getUserMedia: the app origin only (the system prompt follows the Info.plist usage strings).
  func webView(_ wv: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    let from = "\(origin.protocol)://\(origin.host)" + (origin.port > 0 ? ":\(origin.port)" : "")
    decisionHandler(from == self.origin ? .prompt : .deny)
  }

  func alert(_ title: String, _ message: String?, _ buttons: [String], cancel: Int, done: @escaping (Int) -> Void) {
    let a = UIAlertController(title: title, message: message, preferredStyle: .alert)
    for (i, b) in buttons.enumerated() {
      a.addAction(UIAlertAction(title: b, style: i == cancel ? .cancel : .default) { _ in done(i) })
    }
    controller?.present(a, animated: true)
  }

  // MARK: notifications

  static func payload(_ info: [AnyHashable: Any]) -> String? {
    if let s = info["sd"] as? String { return s }
    if let o = info["sd"], JSONSerialization.isValidJSONObject(o), let d = try? JSONSerialization.data(withJSONObject: o) { return String(decoding: d, as: UTF8.self) }
    return nil
  }

  /** A user response: to the page now (target), or kept for its `claim` when no page is loaded. */
  func deliverResponse(_ base: [String: Any], cold: Bool = false) {
    var r = base
    notificationSeq += 1
    r["seq"] = notificationSeq
    r["tag"] = r["id"]
    notificationRing.append(r)
    if notificationRing.count > 64 { notificationRing.removeFirst() }
    if pageReady && !cold {
      r["target"] = true
    } else {
      unclaimedResponses.append(r)
    }
    emit("notificationResponse", r)
  }

  static func pushMessage(_ info: [AnyHashable: Any], _ content: UNNotificationContent?, foreground: Bool) -> [String: Any] {
    var data: [String: Any] = [:]
    for (k, v) in info where (k as? String) != "aps" && JSONSerialization.isValidJSONObject(["v": v]) { data["\(k)"] = v }
    var m: [String: Any] = ["data": data, "foreground": foreground]
    if let p = payload(info) { m["payload"] = p }
    if let c = content, !(c.title.isEmpty && c.body.isEmpty) { m["notification"] = ["title": c.title, "body": c.body] }
    if let id = info["sd_id"] as? String { m["id"] = id }
    return m
  }

  func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    let info = n.request.content.userInfo
    let push = n.request.trigger is UNPushNotificationTrigger
    var shown: [String: Any] = ["id": n.request.identifier, "push": push]
    if let p = Host.payload(info) { shown["payload"] = p }
    emit("notificationShown", shown)
    if push {
      var m = Host.pushMessage(info, n.request.content, foreground: true)
      m["id"] = n.request.identifier
      emit("pushMessage", m)
    }
    let show = (info["sdf"] as? Bool) ?? foregroundBanners
    done(show ? [.banner, .list, .sound] : [])
  }

  func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
    let req = r.notification.request
    var out: [String: Any] = ["id": req.identifier, "actionId": NSNull()]
    switch r.actionIdentifier {
    case UNNotificationDefaultActionIdentifier: out["kind"] = "click"
    case UNNotificationDismissActionIdentifier: out["kind"] = "dismiss"
    default:
      out["actionId"] = r.actionIdentifier
      out["kind"] = "action"
      if let t = r as? UNTextInputNotificationResponse {
        out["kind"] = "reply"
        out["input"] = t.userText
      }
    }
    if let p = Host.payload(req.content.userInfo) { out["payload"] = p }
    DispatchQueue.main.async {
      self.deliverResponse(out)
      done()
    }
  }

  // MARK: push (APNs) — AppDelegate forwards here

  /** aps-environment from the embedded provisioning profile (device), "development" on the simulator. */
  var apsEnvironment: String? {
    #if targetEnvironment(simulator)
      return "development"
    #else
      guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
        let text = try? String(contentsOf: url, encoding: .isoLatin1),
        let r = text.range(of: #"<key>aps-environment</key>\s*<string>([a-z]+)</string>"#, options: .regularExpression)
      else { return nil }
      return text[r].components(separatedBy: "<string>").last?.replacingOccurrences(of: "</string>", with: "")
    #endif
  }

  var pushTarget: [String: Any]? {
    guard let pushToken else { return nil }
    return ["provider": "apns", "token": pushToken, "topic": Bundle.main.bundleIdentifier ?? "", "environment": apsEnvironment ?? "development"]
  }

  func didRegister(token: Data) {
    let t = token.map { String(format: "%02x", $0) }.joined()
    let changed = t != pushToken
    pushToken = t
    if changed { emit("pushToken", ["provider": "apns", "token": t]) }
    let replies = pushReplies
    pushReplies.removeAll()
    for r in replies { r(.success(pushTarget)) }
  }

  func didFailToRegister(_ error: Error) {
    let replies = pushReplies
    pushReplies.removeAll()
    let hint = (error as NSError).localizedDescription.contains("aps-environment")
      ? " — set `push.apns` in desktop.config and sign with a provisioning profile that enables Push Notifications" : ""
    for r in replies { r(.failure(OpError(code: "unavailable", message: "push.register: \(error.localizedDescription)\(hint)"))) }
  }

  func didReceiveRemote(_ info: [AnyHashable: Any]) {
    // Alert pushes go through willPresent / didReceive; data pushes land here.
    if let aps = info["aps"] as? [String: Any], aps["alert"] != nil { return }
    emit("pushMessage", Host.pushMessage(info, nil, foreground: UIApplication.shared.applicationState == .active))
  }
}

// MARK: - Services (names, arguments and replies follow native/platform_*.mm)

extension Host {
  func sync(_ name: String, _ body: @escaping ([String: Any]) throws -> Any?) {
    ops[name] = { args, reply in reply(.success(try body(args))) }
  }

  func async(_ name: String, _ body: @escaping Op) { ops[name] = body }

  var appName: String { info("SDAppName") as? String ?? info("CFBundleDisplayName") as? String ?? "App" }
  var version: String { info("CFBundleShortVersionString") as? String ?? "0.0.0" }

  func themeInfo() -> [String: Any] {
    let dark = webView.traitCollection.userInterfaceStyle == .dark
    return ["appearance": dark ? "dark" : "light", "dark": dark]
  }

  func registerServices() {
    sync("app.whenReady") { _ in true }
    sync("app.getInfo") { _ in
      #if arch(arm64)
        let arch = "arm64"
      #else
        let arch = "x64"
      #endif
      return ["name": self.appName, "version": self.version, "identifier": info("SDIdentifier") as? String ?? Bundle.main.bundleIdentifier ?? "",
              "appPath": Bundle.main.bundlePath, "packaged": true, "platform": "ios", "arch": arch, "serverUrl": (self.serverURL?.absoluteString as Any?) ?? NSNull(), "offline": (info("SDOffline") as? Bool) == true]
    }
    sync("app.getName") { _ in self.appName }
    sync("app.getVersion") { _ in self.version }
    sync("app.getBundleType") { _ in ["type": "app"] }
    sync("app.getPath") { args in
      let fm = FileManager.default
      switch args["name"] as? String ?? "" {
      case "home": return NSHomeDirectory()
      case "userData", "appData": return fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].path
      case "documents": return fm.urls(for: .documentDirectory, in: .userDomainMask)[0].path
      case "temp": return NSTemporaryDirectory()
      case "caches", "cache": return fm.urls(for: .cachesDirectory, in: .userDomainMask)[0].path
      default: throw OpError(code: "invalid_args", message: "app.getPath: unknown name `\(args["name"] ?? "")`")
      }
    }

    // Reading the pasteboard may raise iOS's paste prompt, which blocks the reading
    // thread until the user answers: never read on the main thread. Format checks
    // (hasStrings…) don't prompt.
    async("clipboard.readText") { _, reply in
      DispatchQueue.global(qos: .userInitiated).async { reply(.success(UIPasteboard.general.string ?? NSNull())) }
    }
    sync("clipboard.availableFormats") { _ in
      let pb = UIPasteboard.general
      var out: [String] = []
      if pb.hasImages { out.append("image/png") }
      if pb.hasStrings { out.append("text/plain") }
      if pb.hasURLs { out.append("text/uri-list") }
      return out
    }
    sync("clipboard.has") { args in
      guard let f = args["format"] as? String else { throw OpError(code: "invalid_args", message: "clipboard.has: `format` is required") }
      let pb = UIPasteboard.general
      switch f {
      case "text/plain", "text": return pb.hasStrings
      case "image/png", "image": return pb.hasImages
      case "text/uri-list", "url": return pb.hasURLs
      default: return pb.contains(pasteboardTypes: [f])
      }
    }
    sync("clipboard.writeText") { args in
      UIPasteboard.general.string = args["text"] as? String ?? ""
      return nil
    }
    sync("clipboard.clear") { _ in
      UIPasteboard.general.items = []
      return nil
    }

    sync("theme.get") { _ in self.themeInfo() }
    sync("theme.getAppearance") { _ in self.themeInfo() }
    sync("theme.shouldUseDarkColors") { _ in self.themeInfo()["dark"] }

    sync("shell.openExternal") { args in
      guard let url = URL(string: args["url"] as? String ?? ""), let scheme = url.scheme?.lowercased(),
        ["http", "https", "mailto", "tel", "sms", "maps"].contains(scheme)
      else { throw OpError(code: "invalid_args", message: "shell.openExternal: only http(s)/mailto/tel/sms/maps URLs") }
      UIApplication.shared.open(url)
      return nil
    }
    // Mobile-only: the system share sheet {text, url?, title?}
    async("shell.share") { args, reply in
      var items: [Any] = []
      if let t = args["text"] as? String { items.append(t) }
      if let u = (args["url"] as? String).flatMap(URL.init(string:)) { items.append(u) }
      let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
      sheet.popoverPresentationController?.sourceView = self.webView
      sheet.completionWithItemsHandler = { activity, completed, _, _ in reply(.success(["completed": completed, "activity": (activity?.rawValue as Any?) ?? NSNull()])) }
      self.controller?.present(sheet, animated: true)
    }

    sync("system.info") { _ in
      var sys = utsname()
      uname(&sys)
      let model = withUnsafeBytes(of: &sys.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
      return ["os": "ios", "family": "ios", "version": UIDevice.current.systemVersion, "model": model, "idiom": UIDevice.current.userInterfaceIdiom == .pad ? "pad" : "phone"]
    }

    // Permissions: camera / microphone (AVFoundation), notifications; the app's page in Settings.
    // The usage strings come from desktop.config `permissions` (Info.plist).
    func avStatus(_ s: AVAuthorizationStatus) -> String {
      switch s {
      case .authorized: return "granted"
      case .notDetermined: return "notDetermined"
      default: return "denied"
      }
    }
    let media: [String: AVMediaType] = ["camera": .video, "microphone": .audio]
    async("system.checkPermission") { args, reply in
      let name = args["name"] as? String ?? ""
      if let type = media[name] { return reply(.success(["status": avStatus(AVCaptureDevice.authorizationStatus(for: type))])) }
      if name == "notifications" {
        return UNUserNotificationCenter.current().getNotificationSettings { s in
          reply(.success(["status": s.authorizationStatus == .notDetermined ? "notDetermined" : s.authorizationStatus == .denied ? "denied" : "granted"]))
        }
      }
      reply(.success(["status": "unknown"]))
    }
    async("system.requestPermission") { args, reply in
      let name = args["name"] as? String ?? ""
      if let type = media[name] {
        let key = type == .video ? "NSCameraUsageDescription" : "NSMicrophoneUsageDescription"
        guard info(key) != nil else { throw OpError(code: "unavailable", message: "system.requestPermission \(name): Info.plist has no \(key) (declare it in desktop.config permissions)") }
        return AVCaptureDevice.requestAccess(for: type) { ok in reply(.success(["status": ok ? "granted" : "denied"])) }
      }
      if name == "notifications" {
        return UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { ok, _ in reply(.success(["status": ok ? "granted" : "denied"])) }
      }
      reply(.success(["status": "unknown"]))
    }
    sync("system.openSettings") { _ in
      if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
      return ["opened": true]
    }

    async("dialog.showMessageBox") { args, reply in self.messageBox(args, confirm: false, reply) }
    async("dialog.showConfirm") { args, reply in self.messageBox(args, confirm: true, reply) }

    notifications()
    secureStorage()

    // Mobile-only: {style: light|medium|heavy|soft|rigid|selection|success|warning|error}
    sync("haptics.impact") { args in
      switch args["style"] as? String ?? "medium" {
      case "selection": UISelectionFeedbackGenerator().selectionChanged()
      case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
      case "warning": UINotificationFeedbackGenerator().notificationOccurred(.warning)
      case "error": UINotificationFeedbackGenerator().notificationOccurred(.error)
      case "light": UIImpactFeedbackGenerator(style: .light).impactOccurred()
      case "heavy": UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
      case "soft": UIImpactFeedbackGenerator(style: .soft).impactOccurred()
      case "rigid": UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
      default: UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      }
      return true
    }

    async("webview.executeJavaScript") { args, reply in
      guard let code = args["code"] as? String else { throw OpError(code: "invalid_args", message: "webview.executeJavaScript: `code` is required") }
      let body = "const v = await (0, eval)(__code); return v === undefined ? 'null' : (JSON.stringify(v) ?? 'null');"
      // A navigation can drop the call without a completion: answer anyway (reply is once-only).
      DispatchQueue.main.asyncAfter(deadline: .now() + 30) { reply(.failure(OpError(code: "internal", message: "webview.executeJavaScript: no result (page navigated?)"))) }
      self.webView.callAsyncJavaScript(body, arguments: ["__code": code], in: nil, in: .page) { result in
        switch result {
        case .success(let v):
          let parsed = (v as? String).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8), options: [.fragmentsAllowed]) }
          reply(.success(parsed ?? NSNull()))
        case .failure(let e): reply(.failure(OpError(code: "internal", message: e.localizedDescription)))
        }
      }
    }
    async("webview.capturePage") { _, reply in
      self.webView.takeSnapshot(with: nil) { image, error in
        guard let png = image?.pngData() else { return reply(.failure(OpError(code: "internal", message: error?.localizedDescription ?? "snapshot failed"))) }
        reply(.success(["data": png.base64EncodedString(), "width": Int(image!.size.width), "height": Int(image!.size.height)]))
      }
    }
    sync("webview.reload") { _ in
      self.webView.reload()
      return nil
    }
    sync("webview.getURL") { _ in self.webView.url?.absoluteString ?? NSNull() }

    sync("events.emit") { args in
      self.emit("message", ["channel": args["channel"] ?? "", "data": args["data"] ?? NSNull(), "from": 0])
      return nil
    }
    sync("deepLink.getInitialUrls") { _ in self.pendingURLs }
    sync("window.getTitle") { _ in self.webView.title ?? "" }
    sync("window.setTitle") { _ in nil } // no window title on iOS
    sync("diagnostics.info") { _ in ["pid": ProcessInfo.processInfo.processIdentifier, "os": "ios", "renderer": "WKWebView"] }
    sync("capabilities.describe") { _ in
      var services: [String: [String: String]] = [:]
      for k in self.ops.keys {
        let p = k.split(separator: ".", maxSplits: 1).map(String.init)
        services[p[0], default: [:]][p[1]] = "implemented"
      }
      return ["platform": "ios", "services": services]
    }
  }

  func messageBox(_ args: [String: Any], confirm: Bool, _ reply: @escaping Reply) {
    var buttons = (args["buttons"] as? [Any])?.map { "\($0)" } ?? []
    if buttons.isEmpty { buttons = confirm ? ["OK", "Cancel"] : ["OK"] }
    let cancelId = args["cancelId"] as? Int ?? (buttons.count > 1 ? buttons.count - 1 : -1)
    let title = args["message"] as? String ?? args["title"] as? String ?? ""
    alert(title, args["detail"] as? String, buttons, cancel: cancelId) { i in
      reply(.success(confirm ? (i == 0) as Any : ["response": i, "canceled": i == cancelId] as [String: Any]))
    }
  }

  func notifications() {
    let center = UNUserNotificationCenter.current()
    let status: (UNAuthorizationStatus) -> String = { s in
      switch s {
      case .notDetermined: return "notDetermined"
      case .denied: return "denied"
      default: return "granted"
      }
    }
    let repeats = ["minute", "hour", "day", "week", "month", "year"]
    var categories: [String: UNNotificationCategory] = [
      "sd-plain": UNNotificationCategory(identifier: "sd-plain", actions: [], intentIdentifiers: [], options: [.customDismissAction])
    ]
    center.setNotificationCategories(Set(categories.values))

    func category(_ actions: [[String: Any]]) throws -> String {
      var list: [UNNotificationAction] = []
      var key: [String] = []
      for a in actions {
        guard let id = a["id"] as? String, !id.isEmpty, let title = (a["title"] ?? a["label"]) as? String else {
          throw OpError(code: "invalid_args", message: "notifications.show: each action needs string `id` and `title`")
        }
        var options: UNNotificationActionOptions = []
        if (a["foreground"] as? Bool) != false { options.insert(.foreground) }
        if (a["destructive"] as? Bool) == true { options.insert(.destructive) }
        if let input = a["input"], !(input is NSNull), (input as? Bool) != false {
          let i = input as? [String: Any] ?? [:]
          list.append(UNTextInputNotificationAction(identifier: id, title: title, options: options,
            textInputButtonTitle: i["button"] as? String ?? title, textInputPlaceholder: i["placeholder"] as? String ?? ""))
        } else {
          list.append(UNNotificationAction(identifier: id, title: title, options: options))
        }
        key.append("\(id)=\(title)=\(options.rawValue)=\(json(a["input"]))")
      }
      let ident = "sd-actions:" + key.joined(separator: "\u{1f}")
      if categories[ident] == nil {
        categories[ident] = UNNotificationCategory(identifier: ident, actions: list, intentIdentifiers: [], options: [.customDismissAction])
        center.setNotificationCategories(Set(categories.values))
      }
      return ident
    }

    func trigger(_ atMs: Double, _ rep: String?) -> UNNotificationTrigger {
      let at = Date(timeIntervalSince1970: atMs / 1000)
      guard let rep else { return UNTimeIntervalNotificationTrigger(timeInterval: max(at.timeIntervalSinceNow, 0.1), repeats: false) }
      var units: Set<Calendar.Component> = [.second]
      if rep != "minute" { units.insert(.minute) }
      if ["day", "week", "month", "year"].contains(rep) { units.insert(.hour) }
      if rep == "week" { units.insert(.weekday) }
      if rep == "month" || rep == "year" { units.insert(.day) }
      if rep == "year" { units.insert(.month) }
      return UNCalendarNotificationTrigger(dateMatching: Calendar.current.dateComponents(units, from: at), repeats: true)
    }

    /** Image bytes from a path, file:// or data: URL; http(s) is downloaded. */
    func image(_ src: String, _ done: @escaping (Data?, String) -> Void) {
      if src.hasPrefix("data:"), let comma = src.firstIndex(of: ",") {
        let meta = String(src[src.index(src.startIndex, offsetBy: 5)..<comma])
        let sub = meta.split(separator: ";").first?.split(separator: "/").last.map(String.init) ?? "png"
        let body = String(src[src.index(after: comma)...])
        let data = meta.hasSuffix(";base64") ? Data(base64Encoded: body, options: .ignoreUnknownCharacters) : body.removingPercentEncoding?.data(using: .utf8)
        return done(data, sub == "jpeg" ? "jpg" : sub)
      }
      if src.hasPrefix("http://") || src.hasPrefix("https://"), let url = URL(string: src) {
        URLSession.shared.dataTask(with: url) { data, _, _ in DispatchQueue.main.async { done(data, url.pathExtension.isEmpty ? "png" : url.pathExtension) } }.resume()
        return
      }
      let path = src.hasPrefix("file:") ? (URL(string: src)?.path ?? src) : src
      done(FileManager.default.contents(atPath: path), (path as NSString).pathExtension.isEmpty ? "png" : (path as NSString).pathExtension)
    }

    let show: Op = { args, reply in
      guard let title = args["title"] as? String else { throw OpError(code: "invalid_args", message: "notifications.show: `title` must be a string") }
      var id = (args["id"] ?? args["tag"]) as? String ?? ""
      if id.isEmpty { id = UUID().uuidString }
      let rep = args["repeat"] as? String
      if let rep, !repeats.contains(rep) { throw OpError(code: "invalid_args", message: "notifications.show: `repeat` must be minute|hour|day|week|month|year") }
      let at = args["at"] as? Double
      if rep != nil && at == nil { throw OpError(code: "invalid_args", message: "notifications.show: `repeat` needs `at`") }
      let content = UNMutableNotificationContent()
      content.title = title
      if let body = (args["body"] ?? args["message"]) as? String { content.body = body }
      if let subtitle = args["subtitle"] as? String { content.subtitle = subtitle }
      if let group = args["group"] as? String { content.threadIdentifier = group }
      if let badge = args["badge"] as? Double { content.badge = NSNumber(value: Int(badge)) }
      if (args["silent"] as? Bool) != true {
        let sound = args["sound"] as? String
        content.sound = sound == nil || sound == "default" ? .default : UNNotificationSound(named: UNNotificationSoundName(sound!))
      }
      switch args["urgency"] as? String {
      case "low": content.interruptionLevel = .passive
      case "critical": content.interruptionLevel = .timeSensitive
      default: break
      }
      var info: [String: Any] = [:]
      if let p = args["payload"] as? String { info["sd"] = p }
      if let f = args["foreground"] as? Bool { info["sdf"] = f }
      if let rep { info["sdr"] = rep }
      content.userInfo = info
      if let actions = args["actions"] as? [[String: Any]], !actions.isEmpty { content.categoryIdentifier = try category(actions) } else { content.categoryIdentifier = "sd-plain" }
      let scheduled = at.map { $0 / 1000 > Date().timeIntervalSince1970 + 0.5 || rep != nil } ?? false
      let post = {
        if scheduled { center.removeDeliveredNotifications(withIdentifiers: [id]) }
        let req = UNNotificationRequest(identifier: id, content: content, trigger: scheduled ? trigger(at!, rep) : nil)
        center.add(req) { error in
          if let error = error as NSError? {
            let denied = error.domain == UNErrorDomain && error.code == UNError.notificationsNotAllowed.rawValue
            reply(.failure(OpError(code: denied ? "denied" : "internal", message: "notifications.show: \(error.localizedDescription)")))
          } else {
            reply(.success(["id": id, "tag": id, "scheduled": scheduled]))
          }
        }
      }
      guard let src = args["image"] as? String else { return post() }
      image(src) { data, ext in
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("sd-notification-\(UUID().uuidString).\(ext)")
        guard let data, (try? data.write(to: file)) != nil, let a = try? UNNotificationAttachment(identifier: "image", url: file) else {
          return reply(.failure(OpError(code: "invalid_args", message: "notifications.show: image \(src.prefix(80)) could not be read")))
        }
        content.attachments = [a]
        post()
      }
    }
    async("notifications.show", show)
    async("notifications.notify", show)
    let dismiss: ([String: Any]) throws -> Any? = { args in
      guard let id = (args["id"] ?? args["tag"]) as? String else { throw OpError(code: "invalid_args", message: "notifications.dismiss: `id` must be a string") }
      center.removeDeliveredNotifications(withIdentifiers: [id])
      center.removePendingNotificationRequests(withIdentifiers: [id])
      return nil
    }
    sync("notifications.dismiss", dismiss)
    sync("notifications.close", dismiss)
    sync("notifications.dismissAll") { _ in
      center.removeAllDeliveredNotifications()
      center.removeAllPendingNotificationRequests()
      return nil
    }
    func describe(_ req: UNNotificationRequest) -> [String: Any] {
      let c = req.content
      var d: [String: Any] = ["id": req.identifier, "title": c.title, "body": c.body]
      if !c.subtitle.isEmpty { d["subtitle"] = c.subtitle }
      if !c.threadIdentifier.isEmpty { d["group"] = c.threadIdentifier }
      if let p = Host.payload(c.userInfo) { d["payload"] = p }
      return d
    }
    async("notifications.delivered") { _, reply in
      center.getDeliveredNotifications { list in
        reply(.success(list.map { n -> [String: Any] in
          var d = describe(n.request)
          d["date"] = Int64(n.date.timeIntervalSince1970 * 1000)
          return d
        }))
      }
    }
    async("notifications.pending") { _, reply in
      center.getPendingNotificationRequests { list in
        reply(.success(list.map { req -> [String: Any] in
          var d = describe(req)
          let next = (req.trigger as? UNCalendarNotificationTrigger)?.nextTriggerDate() ?? (req.trigger as? UNTimeIntervalNotificationTrigger)?.nextTriggerDate()
          if let next { d["at"] = Int64(next.timeIntervalSince1970 * 1000) }
          if let r = req.content.userInfo["sdr"] as? String { d["repeat"] = r }
          return d
        }))
      }
    }
    sync("notifications.claim") { [weak self] _ in
      let out = self?.unclaimedResponses ?? []
      self?.unclaimedResponses.removeAll()
      return out
    }
    sync("notifications.responses") { [weak self] _ in self?.notificationRing ?? [] }
    async("notifications.setBadge") { args, reply in
      let n = Int(args["count"] as? Double ?? 0)
      center.setBadgeCount(max(n, 0)) { error in
        if let error { reply(.failure(OpError(code: "internal", message: "notifications.setBadge: \(error.localizedDescription)"))) } else { reply(.success(nil)) }
      }
    }
    sync("notifications.setForeground") { [weak self] args in
      self?.foregroundBanners = args["show"] as? Bool ?? true
      return nil
    }
    for op in ["createChannel", "deleteChannel", "channels"] {
      sync("notifications.\(op)") { _ in throw OpError(code: "unsupported", message: "notifications.\(op): channels are Android-only") }
    }
    async("notifications.getPermissionStatus") { _, reply in
      center.getNotificationSettings { s in reply(.success(["status": status(s.authorizationStatus)])) }
    }
    async("notifications.requestPermission") { _, reply in
      center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
        if granted { return reply(.success(["status": "granted"])) }
        if let error { return reply(.failure(OpError(code: "unavailable", message: "notifications.requestPermission: \(error.localizedDescription)"))) }
        reply(.success(["status": "denied"]))
      }
    }
    // e2e tests: a user response to a delivered notification through the real path.
    if isDebugBuild {
      async("notifications.simulateResponse") { [weak self] args, reply in
        let id = args["id"] as? String ?? ""
        center.getDeliveredNotifications { list in
          DispatchQueue.main.async {
            let info = list.first { $0.request.identifier == id }?.request.content.userInfo ?? [:]
            let action = args["actionId"] as? String, input = args["input"] as? String
            var r: [String: Any] = ["id": id, "actionId": action ?? NSNull(), "kind": args["kind"] as? String ?? (input != nil ? "reply" : action != nil ? "action" : "click")]
            if let input { r["input"] = input }
            if let p = Host.payload(info) { r["payload"] = p }
            self?.deliverResponse(r, cold: args["cold"] as? Bool ?? false)
            reply(.success(r))
          }
        }
      }
    }

    // push.* — APNs
    async("push.register") { [weak self] _, reply in
      guard let self else { return }
      if let t = self.pushTarget { return reply(.success(t)) }
      self.pushReplies.append(reply)
      guard self.pushReplies.count == 1 else { return }
      center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
        // Alerts may be refused: a token still allows silent pushes.
        DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
      }
    }
    sync("push.unregister") { [weak self] _ in
      if self?.pushToken != nil { UIApplication.shared.unregisterForRemoteNotifications() }
      self?.pushToken = nil
      return nil
    }
    sync("push.token") { [weak self] _ in self?.pushTarget }
  }

  func secureStorage() {
    func key(_ args: [String: Any], _ op: String, needAccount: Bool) throws -> (String, String?) {
      guard let service = args["service"] as? String, !service.isEmpty else { throw OpError(code: "invalid_args", message: "secureStorage.\(op): `service` must be a non-empty string") }
      let account = args["account"] as? String
      if needAccount && (account ?? "").isEmpty { throw OpError(code: "invalid_args", message: "secureStorage.\(op): `account` must be a non-empty string") }
      return (service, account)
    }
    func query(_ service: String, _ account: String?) -> [String: Any] {
      var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
      if let account, !account.isEmpty { q[kSecAttrAccount as String] = account }
      return q
    }
    let fail: (String, OSStatus) -> OpError = { op, st in
      OpError(code: "internal", message: "secureStorage.\(op): \(SecCopyErrorMessageString(st, nil) as String? ?? "OSStatus \(st)")")
    }
    sync("secureStorage.setPassword") { args in
      let (service, account) = try key(args, "setPassword", needAccount: true)
      guard let password = args["password"] as? String else { throw OpError(code: "invalid_args", message: "secureStorage.setPassword: `password` must be a string") }
      let q = query(service, account)
      SecItemDelete(q as CFDictionary)
      var add = q
      add[kSecValueData as String] = Data(password.utf8)
      add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      let st = SecItemAdd(add as CFDictionary, nil)
      if st != errSecSuccess { throw fail("setPassword", st) }
      return nil
    }
    sync("secureStorage.getPassword") { args in
      let (service, account) = try key(args, "getPassword", needAccount: true)
      var q = query(service, account)
      q[kSecReturnData as String] = true
      q[kSecMatchLimit as String] = kSecMatchLimitOne
      var out: CFTypeRef?
      let st = SecItemCopyMatching(q as CFDictionary, &out)
      if st == errSecItemNotFound { return NSNull() }
      if st != errSecSuccess { throw fail("getPassword", st) }
      return (out as? Data).map { String(decoding: $0, as: UTF8.self) } ?? NSNull()
    }
    sync("secureStorage.deletePassword") { args in
      let (service, account) = try key(args, "deletePassword", needAccount: false)
      let st = SecItemDelete(query(service, account) as CFDictionary)
      if st != errSecSuccess && st != errSecItemNotFound { throw fail("deletePassword", st) }
      return nil
    }
    async("secureStorage.authenticate") { args, reply in
      let ctx = LAContext()
      var error: NSError?
      guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
        return reply(.success(["authenticated": false, "reason": error?.localizedDescription ?? "owner authentication unavailable"]))
      }
      ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: args["reason"] as? String ?? "authenticate to continue") { ok, err in
        reply(.success(ok ? ["authenticated": true] : ["authenticated": false, "reason": err?.localizedDescription ?? "authentication failed"]))
      }
    }
  }
}

// MARK: - Offline mode: app://localhost/<path> → www/ in the bundle

final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
  let root: URL
  init(root: URL) { self.root = root }

  private static let types: [String: String] = [
    "html": "text/html", "js": "text/javascript", "mjs": "text/javascript", "css": "text/css", "json": "application/json",
    "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif",
    "ico": "image/x-icon", "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf", "txt": "text/plain", "wasm": "application/wasm",
    "webmanifest": "application/manifest+json", "map": "application/json",
  ]

  /// Static-host resolution: the file, <path>.html, <path>/index.html, then the SPA fallback (200.html).
  func resolve(_ path: String) -> URL {
    let clean = path.split(separator: "/").filter { $0 != ".." && $0 != "." }.joined(separator: "/")
    let fm = FileManager.default
    var isDir: ObjCBool = false
    for candidate in [clean, "\(clean).html", clean.isEmpty ? "index.html" : "\(clean)/index.html"] where !candidate.isEmpty {
      let url = root.appendingPathComponent(candidate)
      if fm.fileExists(atPath: url.path, isDirectory: &isDir), !isDir.boolValue { return url }
    }
    return root.appendingPathComponent("200.html")
  }

  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url else { return task.didFailWithError(URLError(.badURL)) }
    let file = resolve(url.path.removingPercentEncoding ?? url.path)
    guard let data = try? Data(contentsOf: file) else { return task.didFailWithError(URLError(.fileDoesNotExist)) }
    let type = Self.types[file.pathExtension.lowercased()] ?? "application/octet-stream"
    let headers = ["Content-Type": type, "Content-Length": "\(data.count)", "Cache-Control": "no-cache"]
    task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
    task.didReceive(data)
    task.didFinish()
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

// MARK: - Swift plugin API (same surface as native/include/SvelteDesktop.swift on macOS)

#if SD_PLUGIN
  public enum DesktopError: Error {
    case invalidArgs(String), unsupported(String), unavailable(String), denied(String), failed(String)
    var code: String {
      switch self {
      case .invalidArgs: "invalid_args"
      case .unsupported: "unsupported"
      case .unavailable: "unavailable"
      case .denied: "denied"
      case .failed: "internal"
      }
    }
    var message: String {
      switch self {
      case let .invalidArgs(m), let .unsupported(m), let .unavailable(m), let .denied(m), let .failed(m): m
      }
    }
  }

  public enum Desktop {
    /// Register "service.op" as a platform op (pages: `nativeModule()`). Runs on the main thread.
    public static func command(_ name: String, _ body: @escaping @MainActor ([String: Any]) async throws -> Any?) {
      let parts = name.split(separator: ".", maxSplits: 1).map(String.init)
      precondition(parts.count == 2, "Desktop.command name must be \"service.op\"")
      let host = Host.shared
      guard host.ops[name] == nil else { return log("\(name) is a built-in op; not registered") }
      host.async(name) { args, reply in
        Task { @MainActor in
          do { reply(.success(try await body(args))) } catch let e as DesktopError { reply(.failure(OpError(code: e.code, message: e.message))) } catch {
            reply(.failure(OpError(code: "internal", message: "\(error)")))
          }
        }
      }
    }

    /// Broadcast an event to the page (and the test runner).
    public static func emit(_ event: String, _ data: Any? = nil) {
      Host.shared.emit(event, data as? [String: Any] ?? ["value": data ?? NSNull()])
    }

    /// The app's window (id 0) / root view controller. Main thread.
    @MainActor public static func window(_ id: Int = 0) -> UIWindow? { id == 0 ? Host.shared.webView.window : nil }
    @MainActor public static func viewController() -> UIViewController? { Host.shared.controller }

    public static func log(_ message: String) { NSLog("[plugin] %@", message) }
  }
#endif

// MARK: - E2E test channel (debug builds; same protocol as src/test-channel.ts)

final class TestChannel {
  private let task: URLSessionWebSocketTask
  private weak var host: Host?

  init(url: String, host: Host) {
    self.host = host
    task = URLSession.shared.webSocketTask(with: URL(string: url)!)
    task.resume()
    send(["t": "hello", "origin": host.origin, "appName": host.appName])
    receive()
  }

  // One frame in flight at a time, in order.
  private var outbox: [String] = []
  private var sending = false

  private func send(_ m: [String: Any]) {
    let text = json(m)
    DispatchQueue.main.async {
      self.outbox.append(text)
      self.pump()
    }
  }

  private func pump() {
    guard !sending, !outbox.isEmpty else { return }
    sending = true
    let text = outbox.removeFirst()
    task.send(.string(text)) { error in
      if let error { NSLog("[test-channel] send failed (%d bytes): %@", text.utf8.count, "\(error)") }
      DispatchQueue.main.async {
        self.sending = false
        self.pump()
      }
    }
  }

  func event(_ name: String, _ data: Any) { send(["t": "event", "name": name, "data": data]) }

  private func receive() {
    task.receive { [weak self] result in
      guard let self else { return }
      guard case .success(.string(let text)) = result else {
        NSLog("[test-channel] receive ended: %@", "\(result)")
        return
      }
      if let m = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] {
        DispatchQueue.main.async {
          self.host?.dispatch(m["service"] as? String ?? "", m["op"] as? String ?? "", m["args"] as? [String: Any] ?? [:]) { r in
            var reply = Host.reply(m["id"] ?? 0, r)
            reply["t"] = "result"
            self.send(reply)
          }
        }
      }
      self.receive()
    }
  }
}

// MARK: - App

final class ViewController: UIViewController {
  override func loadView() {
    let host = Host.shared
    host.controller = self
    view = host.makeWebView()
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    Host.shared.start()
  }

  override func traitCollectionDidChange(_ previous: UITraitCollection?) {
    super.traitCollectionDidChange(previous)
    if previous?.userInterfaceStyle != traitCollection.userInterfaceStyle { Host.shared.emit("appearanceChanged", Host.shared.themeInfo()) }
  }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
    guard let scene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: scene)
    window.rootViewController = ViewController()
    window.makeKeyAndVisible()
    self.window = window
    for ctx in options.urlContexts { Host.shared.open(url: ctx.url) }
  }

  func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
    for ctx in contexts { Host.shared.open(url: ctx.url) }
  }
}

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
  func application(_ app: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    // Before launch completes, so a notification tap that launched the app is delivered (and kept for the page).
    UNUserNotificationCenter.current().delegate = Host.shared
    return true
  }

  func application(_ app: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) { Host.shared.didRegister(token: token) }

  func application(_ app: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) { Host.shared.didFailToRegister(error) }

  func application(_ app: UIApplication, didReceiveRemoteNotification info: [AnyHashable: Any], fetchCompletionHandler done: @escaping (UIBackgroundFetchResult) -> Void) {
    Host.shared.didReceiveRemote(info)
    done(.newData)
  }

  func application(_ app: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
    let config = UISceneConfiguration(name: "Default", sessionRole: session.role)
    config.delegateClass = SceneDelegate.self
    return config
  }
}
