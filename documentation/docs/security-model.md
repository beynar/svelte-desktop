# Security model — honest threat assessment

## Trust boundary (as built today)

```
trusted:  app JS (your Svelte code) ──► Bun APIs (fs/net/sqlite/ffi/ffi-loaded dylibs)
          │                            unrestricted by design
          └──► brokered native bridge (gpuix ops, $native commands, native services)
               ── our layer: validated, capability-gated ──
untrusted: anything loaded over the network, user content, future plugins
```

**The key constraint (from the brief, confirmed by inspection):** app JS can
call `bun:ffi`, `Bun.spawn`, `Bun.file` directly. A "permission manifest" on
our bridge does NOT sandbox the app — it only gates *our* privileged calls.
We therefore classify capabilities as **backend-enforced for brokered
surfaces** and document that untrusted code must never run in the app process
(no eval of remote code, no unvetted npm plugins).

## What's enforced now

- `applyBatch` validates op tuples natively (bad op → typed error, verified:
  `{type:…}` maps rejected, wrong types rejected).
- Panic containment in `native-core` (`catch_unwind` → error codes; verified
  via the invalid-UTF8 path).
- No raw pointers in generated bindings — `ptr()` used only inside the
  generated boundary, never exposed.
- Shell.openExternal (when bound) → scheme allowlist (https/mailto); file://
  and javascript: refused.
- Dialog returns are paths — path traversal risk lives in the *caller's* fs
  use; document: always `path.normalize` + confine to app dirs.

## Not yet enforced (gaps, honest)

- No caller-identity check inside the bridge beyond JS object identity.
- No capability manifest runtime — spec'd in native-api.yaml `capabilities`.
- Malformed/oversized payloads: JSON parse is the guard; no size cap yet —
  add `batch.length` bound in `flush()` (bounded-message rule from brief).
- `bun:ffi` itself is experimental; treat any third-party dylib as suspect.
- CrashReporter/Metrics exist in quickgui bindings — not wired; crash data
  would need explicit opt-in transport.
- Signing/notarization absent → packaged binary is unsigned (Gatekeeper would
  warn on other machines); report honestly, do not claim release-ready.

## Test hooks already exercised

- Malformed batch → `GenericFailure` (measured).
- Invalid UTF-8 to native → typed `invalid_utf8` error (measured).
- Reentrant applyBatch → GPUI panic observed, then architecturally prevented
  (setTimeout flush) — a real finding, now a documented invariant.
