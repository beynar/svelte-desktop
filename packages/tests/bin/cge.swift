import Cocoa
// usage: cge dbl x y        — real double-click: down/up (count 1), down/up (count 2)
//        cge drag x1 y1 x2 y2 — real drag: down, dragged…, up
//        cge click x y        — single click
//        cge scroll x y dy n  — n real pixel-delta wheel ticks at (x,y)
//        cge raise <pid>      — activate pid so its windows sit frontmost;
//                              CGEvent hit-tests the top window, so without
//                              this clicks land on whatever app covers the
//                              probe window's rect (no TCC needed)
func post(_ type: CGEventType, _ p: CGPoint, _ count: Int64 = 1) {
    let ev = CGEvent(mouseEventSource: nil, mouseType: type,
                     mouseCursorPosition: p, mouseButton: .left)!
    ev.setIntegerValueField(.mouseEventClickState, value: count)
    ev.post(tap: .cghidEventTap)
    usleep(40_000)
}
let a = CommandLine.arguments
let mode = a[1]
switch mode {
case "raise":
    let pid = pid_t(a[2])!
    NSRunningApplication(processIdentifier: pid)?.activate()
    usleep(300_000)
case "dbl":
    let p = CGPoint(x: Double(a[2])!, y: Double(a[3])!)
    post(.leftMouseDown, p, 1); post(.leftMouseUp, p, 1)
    post(.leftMouseDown, p, 2); post(.leftMouseUp, p, 2)
case "click":
    let p = CGPoint(x: Double(a[2])!, y: Double(a[3])!)
    post(.leftMouseDown, p, 1); post(.leftMouseUp, p, 1)
case "drag":
    let p1 = CGPoint(x: Double(a[2])!, y: Double(a[3])!)
    let p2 = CGPoint(x: Double(a[4])!, y: Double(a[5])!)
    post(.leftMouseDown, p1, 1)
    for i in 1...6 {
        let t = CGFloat(i) / 6
        post(.leftMouseDragged, CGPoint(x: p1.x + (p2.x - p1.x) * t,
                                        y: p1.y + (p2.y - p1.y) * t), 1)
    }
    post(.leftMouseUp, p2, 1)
case "scroll":
    let p = CGPoint(x: Double(a[2])!, y: Double(a[3])!)
    let dy = Int32(a[4])!
    let n = Int(a[5])!
    for _ in 0..<n {
        let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
                         wheelCount: 2, wheel1: dy, wheel2: 0, wheel3: 0)!
        ev.location = p
        ev.post(tap: .cghidEventTap)
        usleep(12_000) // ~80Hz — trackpad flick cadence
    }
case "wscroll": // warp the cursor into the window first — wheel events
                // hit-test the window under the pointer, not the key window
    let p = CGPoint(x: Double(a[2])!, y: Double(a[3])!)
    let dy = Int32(a[4])!
    let n = Int(a[5])!
    CGWarpMouseCursorPosition(p)
    CGAssociateMouseAndMouseCursorPosition(1)
    usleep(150_000)
    for _ in 0..<n {
        let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
                         wheelCount: 2, wheel1: dy, wheel2: 0, wheel3: 0)!
        ev.location = p
        ev.post(tap: .cghidEventTap)
        usleep(12_000)
    }
case "pscroll": // postToPid — straight into the app's event queue, no hit-test
    let pid = pid_t(a[2])!
    let p = CGPoint(x: Double(a[3])!, y: Double(a[4])!)
    let dy = Int32(a[5])!
    let n = Int(a[6])!
    for _ in 0..<n {
        let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
                         wheelCount: 2, wheel1: dy, wheel2: 0, wheel3: 0)!
        ev.location = p
        ev.postToPid(pid)
        usleep(12_000)
    }
default: break
}
