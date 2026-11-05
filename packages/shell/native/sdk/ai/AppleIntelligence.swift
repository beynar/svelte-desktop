// host.ai on macOS: Apple's on-device language model (Foundation Models, macOS 26 with Apple
// Intelligence on). A plugin of the shell's own, built with the Swift SDK (include/Kitop.swift)
// by src/build/ai.ts and loaded with the app's plugins; src/ai.ts is its JavaScript side.
//
//   ai.availability()                         { available, reason? }
//   ai.createSession({ instructions? })       { session }            a conversation: it keeps its turns
//   ai.closeSession({ session })
//   ai.respond({ prompt, session?, instructions?, schema?, temperature?, maxTokens?, stream? })
//       → { text } or, with a JSON Schema, { object }. With `stream` (an id), each new piece is
//       emitted as `ai.stream` { stream, text (all so far), delta } — or { stream, object } with a
//       schema — before the call resolves with the whole response.
//   ai.cancel({ stream })                     stops a streamed response (it resolves with what it has)
//
// Handlers run on the main actor; the model runs elsewhere and the awaits suspend, so the UI
// thread is never held.
import Foundation

#if canImport(FoundationModels)
  import FoundationModels
#endif

@MainActor var cancelled = Set<String>()

func desktopSetup() {
  Desktop.command("ai.availability") { (_: [String: Any]) -> Any? in
    #if canImport(FoundationModels)
      if #available(macOS 26.0, *) { return AI.availability() }
    #endif
    return ["available": false, "reason": "unsupported"]
  }
  Desktop.command("ai.createSession") { (a: [String: Any]) -> Any? in
    #if canImport(FoundationModels)
      if #available(macOS 26.0, *) { return try AI.createSession(a) }
    #endif
    throw DesktopError.unsupported("host.ai needs macOS 26")
  }
  Desktop.command("ai.closeSession") { (a: [String: Any]) -> Any? in
    #if canImport(FoundationModels)
      if #available(macOS 26.0, *) { AI.sessions[a["session"] as? String ?? ""] = nil }
    #endif
    return nil
  }
  Desktop.command("ai.respond") { (a: [String: Any]) -> Any? in
    #if canImport(FoundationModels)
      if #available(macOS 26.0, *) { return try await AI.respond(a) }
    #endif
    throw DesktopError.unsupported("host.ai needs macOS 26")
  }
  Desktop.command("ai.cancel") { (a: [String: Any]) -> Any? in
    if let id = a["stream"] as? String { cancelled.insert(id) }
    return nil
  }
}

#if canImport(FoundationModels)
  @available(macOS 26.0, *)
  @MainActor enum AI {
    static var sessions: [String: LanguageModelSession] = [:]

    static func availability() -> [String: Any] {
      switch SystemLanguageModel.default.availability {
      case .available: return ["available": true]
      case .unavailable(let reason):
        let name: String
        switch reason {
        case .deviceNotEligible: name = "deviceNotEligible"
        case .appleIntelligenceNotEnabled: name = "appleIntelligenceNotEnabled"
        case .modelNotReady: name = "modelNotReady"
        @unknown default: name = "unavailable"
        }
        return ["available": false, "reason": name]
      @unknown default: return ["available": false, "reason": "unavailable"]
      }
    }

    static func createSession(_ a: [String: Any]) throws -> [String: Any] {
      try ensureAvailable()
      let id = UUID().uuidString
      sessions[id] = LanguageModelSession(instructions: a["instructions"] as? String)
      return ["session": id]
    }

    static func ensureAvailable() throws {
      if case .unavailable = SystemLanguageModel.default.availability {
        throw DesktopError.unavailable("Apple's on-device model is unavailable: \(availability()["reason"] ?? "unavailable")")
      }
    }

    static func respond(_ a: [String: Any]) async throws -> Any? {
      guard let prompt = a["prompt"] as? String, !prompt.isEmpty else { throw DesktopError.invalidArgs("ai.respond: prompt is empty") }
      // The caller's mistakes first: a bad schema is invalid_args wherever the model is.
      let schema = try (a["schema"] as? [String: Any]).map { try GenerationSchema(root: Schema.convert($0, name: "Response"), dependencies: []) }
      try ensureAvailable()
      let session: LanguageModelSession
      if let id = a["session"] as? String {
        guard let s = sessions[id] else { throw DesktopError.invalidArgs("ai.respond: no session \(id) (closed?)") }
        session = s
      } else {
        session = LanguageModelSession(instructions: a["instructions"] as? String)
      }
      let options = GenerationOptions(
        temperature: (a["temperature"] as? NSNumber)?.doubleValue,
        maximumResponseTokens: (a["maxTokens"] as? NSNumber)?.intValue)
      let stream = a["stream"] as? String
      do {
        switch (schema, stream) {
        case (nil, nil):
          return ["text": try await session.respond(to: prompt, options: options).content]
        case (let schema?, nil):
          return ["object": parse(try await session.respond(to: prompt, schema: schema, options: options).content.jsonString)]
        case (nil, let id?):
          defer { cancelled.remove(id) }
          var text = ""
          for try await snapshot in session.streamResponse(to: prompt, options: options) {
            if cancelled.contains(id) { return ["text": text, "cancelled": true] }
            let delta = snapshot.content.hasPrefix(text) ? String(snapshot.content.dropFirst(text.count)) : snapshot.content
            text = snapshot.content
            Desktop.emit("ai.stream", ["stream": id, "text": text, "delta": delta])
          }
          return ["text": text]
        case (let schema?, let id?):
          defer { cancelled.remove(id) }
          var last: Any = NSNull()
          for try await snapshot in session.streamResponse(to: prompt, schema: schema, options: options) {
            if cancelled.contains(id) { return ["object": last, "cancelled": true] }
            last = parse(snapshot.rawContent.jsonString)
            Desktop.emit("ai.stream", ["stream": id, "object": last])
          }
          return ["object": last]
        }
      } catch let e as LanguageModelSession.GenerationError {
        throw map(e)
      }
    }

    static func parse(_ json: String) -> Any {
      (try? JSONSerialization.jsonObject(with: Data(json.utf8), options: [.fragmentsAllowed])) ?? json
    }

    static func map(_ e: LanguageModelSession.GenerationError) -> DesktopError {
      let message = e.errorDescription ?? String(describing: e)
      switch e {
      case .guardrailViolation, .refusal: return .denied(message)
      case .assetsUnavailable, .rateLimited, .concurrentRequests: return .unavailable(message)
      case .exceededContextWindowSize, .unsupportedGuide, .unsupportedLanguageOrLocale, .decodingFailure: return .invalidArgs(message)
      @unknown default: return .failed(message)
      }
    }
  }

  /// A JSON Schema (the subset Apple's model can follow) as a DynamicGenerationSchema: objects with
  /// properties and `required`, arrays (`minItems`, `maxItems`), strings, string `enum`s,
  /// integers, numbers, booleans, `anyOf` / `oneOf`, and `["T", "null"]` (optional).
  @available(macOS 26.0, *)
  enum Schema {
    static func convert(_ s: [String: Any], name: String) throws -> DynamicGenerationSchema {
      let description = s["description"] as? String
      if let choices = s["enum"] as? [Any] {
        guard let strings = choices as? [String] else { throw DesktopError.invalidArgs("schema \(name): only string enums are supported") }
        return DynamicGenerationSchema(name: name, description: description, anyOf: strings)
      }
      if let options = (s["anyOf"] ?? s["oneOf"]) as? [[String: Any]] {
        let choices = try options.filter { type(of: $0) != "null" }.enumerated().map { try convert($0.element, name: "\(name)_\($0.offset)") }
        return choices.count == 1 ? choices[0] : DynamicGenerationSchema(name: name, description: description, anyOf: choices)
      }
      switch type(of: s) {
      case "object":
        let properties = s["properties"] as? [String: Any] ?? [:]
        let required = Set(s["required"] as? [String] ?? [])
        // Keep the schema's order (the model writes the fields in it): JSONSerialization loses it,
        // so `x-order` (written by the JS side) gives it back.
        let order = (s["x-order"] as? [String]) ?? properties.keys.sorted()
        return DynamicGenerationSchema(
          name: name, description: description,
          properties: try order.compactMap { key in
            guard let sub = properties[key] as? [String: Any] else { return nil }
            let optional = !required.contains(key) || nullable(sub)
            return DynamicGenerationSchema.Property(name: key, description: sub["description"] as? String, schema: try convert(sub, name: "\(name)_\(key)"), isOptional: optional)
          })
      case "array":
        let items = s["items"] as? [String: Any] ?? ["type": "string"]
        return DynamicGenerationSchema(arrayOf: try convert(items, name: "\(name)_item"), minimumElements: (s["minItems"] as? NSNumber)?.intValue, maximumElements: (s["maxItems"] as? NSNumber)?.intValue)
      case "string": return DynamicGenerationSchema(type: String.self)
      case "integer": return DynamicGenerationSchema(type: Int.self)
      case "number": return DynamicGenerationSchema(type: Double.self)
      case "boolean": return DynamicGenerationSchema(type: Bool.self)
      case let other: throw DesktopError.invalidArgs("schema \(name): type \(other) is not supported")
      }
    }

    /// The schema's type, the first that isn't "null" when it lists several.
    static func type(of s: [String: Any]) -> String {
      if let t = s["type"] as? String { return t }
      if let ts = s["type"] as? [String] { return ts.first { $0 != "null" } ?? "null" }
      return s["properties"] != nil ? "object" : s["items"] != nil ? "array" : "string"
    }

    static func nullable(_ s: [String: Any]) -> Bool {
      (s["type"] as? [String])?.contains("null") == true || ((s["anyOf"] ?? s["oneOf"]) as? [[String: Any]])?.contains { type(of: $0) == "null" } == true
    }
  }
#endif
