// An iOS-only Swift plugin (native/ios/ is compiled for iOS only; the AppKit
// Greeter in native/ is macOS-only). Same `Desktop.command` API as on macOS.
import UIKit

func desktopSetup() {
  Desktop.command("device.info") { _ in
    let d = UIDevice.current
    return ["name": d.name, "system": "\(d.systemName) \(d.systemVersion)", "idiom": d.userInterfaceIdiom == .pad ? "pad" : "phone"]
  }

  Desktop.command("device.multiply") { args in
    try await Task.sleep(nanoseconds: 20_000_000) // async work is fine
    guard let a = args["a"] as? Double, let b = args["b"] as? Double else {
      throw DesktopError.invalidArgs("device.multiply needs numbers a and b")
    }
    return a * b
  }

  Desktop.command("device.ping") { _ in
    Desktop.emit("device.pong", ["at": Date().timeIntervalSince1970])
    return Desktop.window() != nil
  }
}
