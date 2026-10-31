// Native plugin: every `Desktop.command` becomes an op callable from pages and
// server code — `nativeModule<Greeter>('greeter').hello({ name })` (src/lib/native.ts).
// Compiled automatically by the Vite plugin (dev) and into the .app (build).
import AppKit

func desktopSetup() {
  Desktop.command("greeter.hello") { args in
    "Hello \(args["name"] as? String ?? "world") from Swift \(ProcessInfo.processInfo.operatingSystemVersionString)"
  }

  // Runs on the main thread: AppKit is safe here.
  Desktop.command("greeter.windowTitle") { _ in
    Desktop.window()?.title
  }

  Desktop.command("greeter.add") { args in
    try await Task.sleep(nanoseconds: 50_000_000) // async work is fine
    guard let a = args["a"] as? Double, let b = args["b"] as? Double else {
      throw DesktopError.invalidArgs("greeter.add needs numbers a and b")
    }
    return a + b
  }

  Desktop.command("greeter.ping") { _ in
    Desktop.emit("greeter.pong", ["at": Date().timeIntervalSince1970])
    return true
  }
}
