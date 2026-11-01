// Native plugin in Swift: every command is callable from pages and server code with `native`
// (or `host.native`) — native.greeter.hello({ name }). Codable arguments and results are typed
// for you (src/native.d.ts, written by the build). Compiled automatically by the Vite plugin
// (dev) and into the .app (build).
import AppKit

struct HelloArgs: Codable { let name: String }
struct AddArgs: Codable { let a: Double; let b: Double }

func desktopSetup() {
  Desktop.command("greeter.hello") { (a: HelloArgs) in
    "Hello \(a.name) from Swift \(ProcessInfo.processInfo.operatingSystemVersionString)"
  }

  // Runs on the main thread: AppKit is safe here.
  Desktop.command("greeter.windowTitle") { Desktop.window()?.title }

  Desktop.command("greeter.add") { (args: AddArgs) in
    try await Task.sleep(nanoseconds: 50_000_000) // async work is fine
    return args.a + args.b
  }

  Desktop.command("greeter.ping") { () -> Bool in
    Desktop.emit("greeter.pong", ["at": Date().timeIntervalSince1970])
    return true
  }
}
