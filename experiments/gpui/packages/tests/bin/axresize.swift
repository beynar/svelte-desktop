#!/usr/bin/env swift
// AX-resize repro: writes AXSize on a target app's window like Swish does.
// Usage: swift axresize.swift <pid> [writes]
// Prints per-write latency + total — each AXUIElementSetAttributeValue is a
// synchronous MIG call that blocks until the target's runloop services it.
import Cocoa
import ApplicationServices

let pid = pid_t(CommandLine.arguments[1])!
let raiseOnly = CommandLine.arguments.count > 2 && CommandLine.arguments[2] == "raise"
let writes = raiseOnly ? 0 : (CommandLine.arguments.count > 2 ? Int(CommandLine.arguments[2])! : 40)
let raiseFirst = ProcessInfo.processInfo.environment["AXRESIZE_RAISE"] == "1" || raiseOnly

let app = AXUIElementCreateApplication(pid)

// The window registers with AX asynchronously — poll until it exists.
var win: AXUIElement?
for _ in 0..<100 {
    var windowsRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsRef) == .success,
       let windows = windowsRef as? [AXUIElement], let first = windows.first {
        win = first
        break
    }
    usleep(100_000)
}
guard let win else {
    print("no AX windows for pid \(pid)")
    exit(1)
}

// `raise` mode: front the target app and raise its window, then exit — the
// probe's own activate/focus ops don't fully front a bare bun process, and
// AX writes to a visible-but-backgrounded window take the slow WS path.
// AXRESIZE_RAISE=1 does the same but continues into the write loop.
if raiseFirst {
    AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, true as CFTypeRef)
    AXUIElementPerformAction(win, kAXRaiseAction as CFString)
    if raiseOnly {
        print("raised")
        exit(0)
    }
}

// settle
usleep(200_000)

var times: [Double] = []
for i in 0..<writes {
    var size = CGSize(width: 900 + (i % 3) * 160, height: 640 + (i % 2) * 120)
    guard let value = AXValueCreate(.cgSize, &size) else { exit(2) }
    let t0 = CFAbsoluteTimeGetCurrent()
    let err = AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, value)
    times.append((CFAbsoluteTimeGetCurrent() - t0) * 1000)
    if err != .success { print("write \(i) err \(err.rawValue)") }
}
usleep(300_000) // settle window: reads still pending after writes return

times.sort()
let total = times.reduce(0, +)
let q = { (p: Double) in times[min(times.count - 1, Int(Double(times.count) * p))] }
print(String(format: "writes=%d total=%.0fms p50=%.1f p90=%.1f max=%.1f",
             writes, total, q(0.5), q(0.9), times.last!))
