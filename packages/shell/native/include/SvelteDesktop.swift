// Swift layer over svelte_desktop.h — compiled together with an app's native/*.swift.
// The app defines one function:
//
//   func desktopSetup() {
//     Desktop.command("greeter.hello") { args in "Hello \(args["name"] as? String ?? "?")" }
//     Desktop.command("greeter.title") { _ in Desktop.window()?.title }     // runs on the main thread
//   }
//
// Throw DesktopError.invalidArgs("…") (or any Error → "internal") to reject.
import AppKit
import Foundation

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
  nonisolated(unsafe) static var host: UnsafePointer<sd_host>!

  final class Handler {
    let body: ([String: Any]) async throws -> Any?
    init(_ body: @escaping ([String: Any]) async throws -> Any?) { self.body = body }
  }

  /// Register "service.op". The handler runs on the main thread (MainActor).
  public static func command(_ name: String, _ body: @escaping @MainActor ([String: Any]) async throws -> Any?) {
    let parts = name.split(separator: ".", maxSplits: 1).map(String.init)
    precondition(parts.count == 2, "Desktop.command name must be \"service.op\"")
    let handler = Handler { args in try await body(args) }
    let user = Unmanaged.passRetained(handler).toOpaque()
    if host.pointee.register_op(parts[0], parts[1], desktopTrampoline, user) != 0 {
      log("\(name) is a built-in op; not registered")
    }
  }

  /// Broadcast an event to every page and to server code.
  public static func emit(_ event: String, _ data: Any? = nil) {
    host.pointee.emit(event, json(data))
  }

  /// NSWindow for a public window id (0 = main). Main thread.
  @MainActor public static func window(_ id: Int = 0) -> NSWindow? {
    guard let p = host.pointee.window(Int32(id)) else { return nil }
    return Unmanaged<NSWindow>.fromOpaque(p).takeUnretainedValue()
  }

  public static func log(_ message: String) { host.pointee.log(message) }

  static func json(_ value: Any?) -> String {
    guard let value, !(value is NSNull) else { return "null" }
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
      let s = String(data: data, encoding: .utf8)
    {
      return s
    }
    return json(String(describing: value))
  }
}

private let desktopTrampoline: sd_op_fn = { call, argsJson, user in
  let handler = Unmanaged<Desktop.Handler>.fromOpaque(user!).takeUnretainedValue()
  let raw = argsJson.map { String(cString: $0) } ?? "{}"
  let args = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any] ?? [:]
  nonisolated(unsafe) let call = call
  Task { @MainActor in
    do {
      let value = try await handler.body(args)
      Desktop.host.pointee.resolve(call, Desktop.json(value))
    } catch let e as DesktopError {
      Desktop.host.pointee.reject(call, e.code, e.message)
    } catch {
      Desktop.host.pointee.reject(call, "internal", String(describing: error))
    }
  }
}

@_cdecl("sd_plugin_init")
public func sdPluginInit(_ host: UnsafePointer<sd_host>) -> Int32 {
  guard host.pointee.abi == SD_ABI_VERSION else { return -1 }
  Desktop.host = host
  desktopSetup()
  return 0
}
