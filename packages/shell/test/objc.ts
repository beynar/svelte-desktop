// Tiny Objective-C / CoreGraphics bridge for suites: post real notifications
// (so the native observers are exercised end to end) and synthesize key events.
// Runs on the harness Worker thread; every call used here is thread-safe.
import { dlopen, FFIType as T, type Pointer } from "bun:ffi";

const OBJC = "/usr/lib/libobjc.A.dylib";
const CF = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const CG = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";

const rt = dlopen(OBJC, {
  objc_getClass: { args: [T.cstring], returns: T.ptr },
  sel_registerName: { args: [T.cstring], returns: T.ptr },
}).symbols;
// One objc_msgSend binding per signature (each dlopen gets its own wrapper).
const msg = (extra: T[]) => dlopen(OBJC, { objc_msgSend: { args: [T.ptr, T.ptr, ...extra], returns: T.ptr } }).symbols.objc_msgSend;
const send0 = msg([]);
const send2 = msg([T.ptr, T.ptr]);
const send4b = msg([T.ptr, T.ptr, T.ptr, T.bool]);
const cf = dlopen(CF, {
  CFStringCreateWithCString: { args: [T.ptr, T.cstring, T.u32], returns: T.ptr },
  CFRelease: { args: [T.ptr], returns: T.void },
}).symbols;
const cg = dlopen(CG, {
  CGEventCreateKeyboardEvent: { args: [T.ptr, T.u16, T.bool], returns: T.ptr },
  CGEventSetFlags: { args: [T.ptr, T.u64], returns: T.void },
  CGEventPost: { args: [T.u32, T.ptr], returns: T.void },
}).symbols;

const c = (s: string) => Buffer.from(s + "\0", "utf8");
const cls = (name: string) => rt.objc_getClass(c(name)) as Pointer;
const sel = (name: string) => rt.sel_registerName(c(name)) as Pointer;
function withString<R>(s: string, fn: (ns: Pointer) => R): R {
  const ns = cf.CFStringCreateWithCString(null, c(s), 0x08000100) as Pointer; // UTF-8
  try {
    return fn(ns);
  } finally {
    cf.CFRelease(ns);
  }
}

/** Post on NSWorkspace's (in-process) notification center. */
export function postWorkspace(name: string) {
  const nc = send0(send0(cls("NSWorkspace"), sel("sharedWorkspace")), sel("notificationCenter"));
  withString(name, (ns) => send2(nc, sel("postNotificationName:object:"), ns, null));
}

/** Post on NSNotificationCenter.defaultCenter with NSProcessInfo as object. */
export function postLocal(name: string) {
  const nc = send0(cls("NSNotificationCenter"), sel("defaultCenter"));
  const pi = send0(cls("NSProcessInfo"), sel("processInfo"));
  withString(name, (ns) => send2(nc, sel("postNotificationName:object:"), ns, pi));
}

/** Post a distributed notification (system-wide: only use harmless names). */
export function postDistributed(name: string) {
  const nc = send0(cls("NSDistributedNotificationCenter"), sel("defaultCenter"));
  withString(name, (ns) => send4b(nc, sel("postNotificationName:object:userInfo:deliverImmediately:"), ns, null, null, true));
}

export const CGFlags = { cmd: 0x100000n, shift: 0x20000n, ctrl: 0x40000n, alt: 0x80000n };

/** Synthesize a key press + release at the HID tap (needs Accessibility trust). */
export function pressKey(keyCode: number, flags: bigint) {
  for (const down of [true, false]) {
    const ev = cg.CGEventCreateKeyboardEvent(null, keyCode, down) as Pointer;
    if (!ev) continue;
    cg.CGEventSetFlags(ev, flags);
    cg.CGEventPost(0, ev); // kCGHIDEventTap
    cf.CFRelease(ev);
  }
}
