// Swift layer over svelte_desktop.h — compiled together with an app's native/*.swift.
// The app defines one function:
//
//   struct HelloArgs: Codable { let name: String }
//
//   func desktopSetup() {
//     Desktop.command("greeter.hello") { (a: HelloArgs) in "Hello \(a.name)" }   // typed for `native`
//     Desktop.command("greeter.title") { Desktop.window()?.title }              // no arguments
//     Desktop.command("greeter.raw") { args in args["x"] }                      // untyped: [String: Any]
//   }
//
// Handlers run on the main thread (MainActor), may be async. Throw DesktopError.invalidArgs("…")
// (or any Error → "internal") to reject. Typed commands (Codable arguments and result) get their
// TypeScript in src/native.d.ts: the build reads them with sd_plugin_describe.
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
  nonisolated(unsafe) static var host: UnsafePointer<sd_host>?

  /// A registered command: JSON arguments in, JSON result out.
  final class Entry {
    let service: String, op: String
    /// TypeScript of the arguments (nil: none) and result; `typed` false: untyped ([String: Any]).
    let args: String?, result: String, typed: Bool
    let run: @MainActor (String) async throws -> String
    init(_ name: String, args: String?, result: String, typed: Bool, run: @escaping @MainActor (String) async throws -> String) {
      let parts = name.split(separator: ".", maxSplits: 1).map(String.init)
      precondition(parts.count == 2, "Desktop.command name must be \"service.op\"")
      service = parts[0]
      op = parts[1]
      self.args = args
      self.result = result
      self.typed = typed
      self.run = run
    }
  }
  nonisolated(unsafe) static var entries: [Entry] = []

  /// Register "service.op" with Codable arguments and result: typed in `native`.
  public static func command<A: Decodable, R: Encodable>(_ name: String, _ body: @escaping @MainActor (A) async throws -> R) {
    entries.append(Entry(name, args: TypeScript.of(A.self), result: TypeScript.of(R.self), typed: true) { raw in
      let a: A
      do { a = try JSONDecoder().decode(A.self, from: Data(raw.utf8)) } catch { throw DesktopError.invalidArgs(String(describing: error)) }
      return try encode(try await body(a))
    })
  }

  /// Register "service.op" without arguments: typed in `native`.
  public static func command<R: Encodable>(_ name: String, _ body: @escaping @MainActor () async throws -> R) {
    entries.append(Entry(name, args: nil, result: TypeScript.of(R.self), typed: true) { _ in try encode(try await body()) })
  }

  /// Register "service.op" taking the raw arguments: `unknown` in `native`.
  @_disfavoredOverload
  public static func command(_ name: String, _ body: @escaping @MainActor ([String: Any]) async throws -> Any?) {
    entries.append(Entry(name, args: nil, result: "unknown", typed: false) { raw in
      let args = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any] ?? [:]
      return json(try await body(args))
    })
  }

  /// Broadcast an event to every page and to server code.
  public static func emit(_ event: String, _ data: Any? = nil) {
    host?.pointee.emit(event, json(data))
  }

  /// NSWindow for a public window id (0 = main). Main thread.
  @MainActor public static func window(_ id: Int = 0) -> NSWindow? {
    guard let p = host?.pointee.window(Int32(id)) else { return nil }
    return Unmanaged<NSWindow>.fromOpaque(p).takeUnretainedValue()
  }

  public static func log(_ message: String) { host?.pointee.log(message) }

  static func encode<R: Encodable>(_ value: R) throws -> String {
    String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
  }

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
  let entry = Unmanaged<Desktop.Entry>.fromOpaque(user!).takeUnretainedValue()
  let raw = argsJson.map { String(cString: $0) } ?? "{}"
  nonisolated(unsafe) let call = call
  Task { @MainActor in
    guard let host = Desktop.host else { return }
    do {
      host.pointee.resolve(call, try await entry.run(raw))
    } catch let e as DesktopError {
      host.pointee.reject(call, e.code, e.message)
    } catch {
      host.pointee.reject(call, "internal", String(describing: error))
    }
  }
}

@_cdecl("sd_plugin_init")
public func sdPluginInit(_ host: UnsafePointer<sd_host>) -> Int32 {
  guard host.pointee.abi == SD_ABI_VERSION else { return -1 }
  Desktop.host = host
  Desktop.entries = []
  desktopSetup()
  for e in Desktop.entries {
    let user = Unmanaged.passRetained(e).toOpaque()
    if host.pointee.register_op(e.service, e.op, desktopTrampoline, user) != 0 {
      Desktop.log("\(e.service).\(e.op) is already taken (the shell or another plugin); not registered")
    }
  }
  return 0
}

/// The commands and their TypeScript, for the build (no host: nothing runs but desktopSetup()).
@_cdecl("sd_plugin_describe")
public func sdPluginDescribe() -> UnsafePointer<CChar> {
  if Desktop.entries.isEmpty { desktopSetup() }
  let commands: [[String: Any]] = Desktop.entries.map {
    ["service": $0.service, "op": $0.op, "args": $0.args ?? NSNull(), "result": $0.result, "typed": $0.typed]
  }
  let text = Desktop.json(["abi": 1, "language": "swift", "commands": commands] as [String: Any])
  return UnsafePointer(strdup(text)!)
}

// ---------------------------------------------------------------------------
// TypeScript of a Decodable type: decode it once with a decoder that records what is asked
// (keys, primitives, optionals, arrays) and answers placeholder values.

enum TypeScript {
  static func of<T>(_ type: T.Type) -> String {
    guard let decodable = type as? any Decodable.Type else { return "unknown" }
    return schema(decodable).render()
  }

  static func schema(_ type: any Decodable.Type) -> Shape {
    if type == String.self || type == URL.self || type == UUID.self { return .prim("string") }
    if type == Bool.self { return .prim("boolean") }
    if type is any BinaryInteger.Type || type is any BinaryFloatingPoint.Type { return .prim("number") }
    if type == Date.self { return .prim("number") } // JSONDecoder's default date strategy
    if let cases = stringCases(type) { return .prim(cases) }
    let d = Recorder()
    _ = try? type.init(from: d)
    return d.shape
  }
  /// Nesting limit: a recursive type stops here (its shape so far is kept).
  nonisolated(unsafe) static var depth = 0
  static func nested<T>(_ body: () throws -> T) throws -> T {
    depth += 1
    defer { depth -= 1 }
    if depth > 12 { throw DesktopError.unsupported("recursive type") }
    return try body()
  }

  /// `"a" | "b"` for a CaseIterable String enum.
  static func stringCases(_ type: Any.Type) -> String? {
    guard let all = type as? any CaseIterable.Type else { return nil }
    func values<C: CaseIterable>(_: C.Type) -> [String] { C.allCases.compactMap { ($0 as? any RawRepresentable)?.rawValue as? String } }
    let v = values(all)
    return v.isEmpty ? nil : v.map { "\"\($0)\"" }.joined(separator: " | ")
  }

  indirect enum Shape {
    case unknown, prim(String), array(Shape), object([(String, Shape, Bool)]), nullable(Shape)
    func render() -> String {
      switch self {
      case .unknown: return "unknown"
      case let .prim(t): return t
      case let .array(e):
        let s = e.render()
        return (s.contains("|") ? "(\(s))" : s) + "[]"
      case let .nullable(s): return s.render() + " | null"
      case let .object(fields):
        if fields.count == 1, fields[0].0 == Recorder.anyKey { return "Record<string, \(fields[0].1.render())>" }
        if fields.isEmpty { return "Record<string, never>" }
        return "{ " + fields.map { "\($0.0)\($0.2 ? "?" : ""): \($0.1.render())" }.joined(separator: "; ") + " }"
      }
    }
  }

  /// Records the shape of what a Decodable asks for; answers placeholders.
  final class Recorder: Decoder {
    static let anyKey = "__sd_key"
    var codingPath: [CodingKey] = []
    var userInfo: [CodingUserInfoKey: Any] = [:]
    var shape: Shape = .unknown
    var fields: [(String, Shape, Bool)] = [] { didSet { shape = .object(fields) } }
    /// Keys asked `decodeNil` first: optionals (decodeIfPresent for Int?, String?…).
    var maybeNil: Set<String> = []

    func container<Key: CodingKey>(keyedBy _: Key.Type) -> KeyedDecodingContainer<Key> {
      shape = .object(fields)
      return KeyedDecodingContainer(Keyed<Key>(self))
    }
    func unkeyedContainer() -> UnkeyedDecodingContainer { Unkeyed(self) }
    func singleValueContainer() -> SingleValueDecodingContainer { Single(self) }

    /// A value of `type`, recording its shape (one decode per nested type).
    func value<T: Decodable>(_ type: T.Type) throws -> (T, Shape) {
      if let v = Recorder.placeholder(type) { return (v, TypeScript.schema(type)) }
      let child = Recorder()
      let v = try TypeScript.nested { try T(from: child) }
      return (v, child.shape)
    }

    static func placeholder<T>(_ type: T.Type) -> T? {
      switch type {
      case is String.Type: return "" as? T
      case is Bool.Type: return false as? T
      case is URL.Type: return URL(string: "about:blank") as? T
      case is UUID.Type: return UUID() as? T
      case is Date.Type: return Date() as? T
      default:
        if let n = numeric(type) { return n }
        if let all = type as? any CaseIterable.Type {
          func first<C: CaseIterable>(_: C.Type) -> Any? { C.allCases.first }
          return first(all) as? T
        }
        return nil
      }
    }
    static func numeric<T>(_ type: T.Type) -> T? {
      for v in [0 as Int, 0 as Double] as [Any] { if let x = v as? T { return x } }
      for t in [Int8(0), Int16(0), Int32(0), Int64(0), UInt(0), UInt8(0), UInt16(0), UInt32(0), UInt64(0)] as [Any] { if let x = t as? T { return x } }
      return (Float(0) as Any) as? T
    }

    struct Keyed<Key: CodingKey>: KeyedDecodingContainerProtocol {
      let r: Recorder
      init(_ r: Recorder) { self.r = r }
      var codingPath: [CodingKey] { [] }
      // One key a Dictionary iterates: its value type becomes Record<string, V>.
      var allKeys: [Key] { [Key(stringValue: Recorder.anyKey)].compactMap { $0 } }
      func contains(_: Key) -> Bool { true }
      func decodeNil(forKey key: Key) throws -> Bool {
        r.maybeNil.insert(key.stringValue)
        return false
      }
      func record(_ key: Key, _ shape: Shape, optional: Bool) {
        var (shape, optional) = (shape, optional)
        if r.maybeNil.contains(key.stringValue), !optional {
          (shape, optional) = (.nullable(shape), true)
        }
        if let i = r.fields.firstIndex(where: { $0.0 == key.stringValue }) { r.fields[i] = (key.stringValue, shape, optional) }
        else { r.fields.append((key.stringValue, shape, optional)) }
      }
      func decode<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> T {
        let (v, shape) = try r.value(type)
        record(key, shape, optional: false)
        return v
      }
      func decodeIfPresent<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> T? {
        let (v, shape) = try r.value(type)
        record(key, .nullable(shape), optional: true)
        return v
      }
      func nestedContainer<N: CodingKey>(keyedBy _: N.Type, forKey key: Key) throws -> KeyedDecodingContainer<N> {
        let child = Recorder()
        let c = child.container(keyedBy: N.self)
        record(key, .object([]), optional: false)
        return c
      }
      func nestedUnkeyedContainer(forKey key: Key) throws -> UnkeyedDecodingContainer {
        record(key, .array(.unknown), optional: false)
        return Unkeyed(Recorder())
      }
      func superDecoder() throws -> Decoder { r }
      func superDecoder(forKey _: Key) throws -> Decoder { Recorder() }
    }

    struct Unkeyed: UnkeyedDecodingContainer {
      let r: Recorder
      var currentIndex = 0
      init(_ r: Recorder) {
        self.r = r
        r.shape = .array(.unknown)
      }
      var codingPath: [CodingKey] { [] }
      var count: Int? { 1 }
      var isAtEnd: Bool { currentIndex >= 1 }
      mutating func decodeNil() throws -> Bool { false }
      mutating func decode<T: Decodable>(_ type: T.Type) throws -> T {
        let (v, shape) = try r.value(type)
        r.shape = .array(shape)
        currentIndex += 1
        return v
      }
      mutating func nestedContainer<N: CodingKey>(keyedBy _: N.Type) throws -> KeyedDecodingContainer<N> {
        currentIndex += 1
        return Recorder().container(keyedBy: N.self)
      }
      mutating func nestedUnkeyedContainer() throws -> UnkeyedDecodingContainer {
        currentIndex += 1
        return Unkeyed(Recorder())
      }
      mutating func superDecoder() throws -> Decoder { Recorder() }
    }

    struct Single: SingleValueDecodingContainer {
      let r: Recorder
      init(_ r: Recorder) { self.r = r }
      var codingPath: [CodingKey] { [] }
      func decodeNil() -> Bool {
        r.shape = .nullable(.unknown)
        return false
      }
      func decode<T: Decodable>(_ type: T.Type) throws -> T {
        let (v, shape) = try r.value(type)
        if case .nullable = r.shape { r.shape = .nullable(shape) } else { r.shape = shape }
        return v
      }
    }
  }
}
