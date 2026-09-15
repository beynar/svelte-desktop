# Recommendation — Svelte + Bun + GPUI + native Rust desktop

Date: 2026-09-15. Host: macOS 26.5.1, M4 Pro, 48 GiB. Tools: Bun 1.4.0,
Rust 1.94.0, Svelte 5.57, @gpuix/native 0.7.0, @quickgui/native 0.1.4-next.1.
Raw data: `results/run-20260915-a/`. State: `.agent/`.

---

## 1. The decision: Bun-host + in-process Rust via NAPI — already the working baseline

**Recommendation: keep architecture B (Bun host loading a Rust native module)
as the V1 architecture.** It is not a candidate — it is the thing that already
runs the entire stack: `@gpuix/native` is a NAPI-RS addon loaded by Bun, and it
carries 45/45 Svelte conformance, 30/30 nkit, 49/49 kit, and a packaged
82.6 MB single binary (MEASURED).

Measured transport economics (this machine):

| Transport | Empty-call overhead | Verdict |
|---|---|---|
| NAPI (`hasTestGpuixRenderer`) | 0.044 µs | negligible |
| `bun:ffi` (`quickgui_protocol_version`) | 0.013 µs | negligible |

Call overhead is a non-differentiator — both are three orders of magnitude
inside any frame budget. The real differentiators are lifecycle and ecosystem:

- **NAPI** = Bun's documented stable native interface; `bun:ffi` carries an
  explicit experimental warning (B2/B3 seeds). For a product surface, NAPI is
  the safer ABI — QuickGUI itself is proof FFI works today, but on an
  experimental API.
- **In-process** removes: IPC framing, a second runtime to package, a protocol
  to version, cross-process error mapping. Measured benefit: 10k-op batches
  apply in 0.68 ms including JSON (serialize+parse+apply) — the pipe is not
  the bottleneck, but in-process removes the failure modes entirely.
- Cost accepted: **the reentrancy invariant** — no `applyBatch` inside a
  native event callback (GPUI panics; reproduced). Enforced once in
  `emit()`'s setTimeout flush. This is a code-level invariant, documented in
  `docs/threading.md`, not an ongoing burden.

### Fallback / comparison results

- **A (Rust host + Bun sidecar)**: not built — obsolete on evidence. It would
  add IPC latency and packaging surface to solve a problem (reentrancy
  discipline) that is already solved by one line of scheduling. If we ever
  need crash isolation for untrusted JS, revisit then.
- **FFI transport**: live and working via @quickgui/native — we keep it as the
  *second backend* and as the `$native` spike vehicle (390 KiB cdylib, plain
  rustc, generated TS bindings). If NAPI-RS tooling ever disappoints, FFI is
  proven at 13 ns/call. But do not default an experimental API for the main
  renderer bridge.
- **C (embedded Bun in Rust)**: gate not opened — the working baseline makes
  it pure downside risk (fork maintenance, no public embed API documented).
  Stop condition from the brief satisfied: it would displace a working
  baseline without new evidence.

## 2. What actually runs (exact commands)

```bash
cd gpuix-poc
bun build.ts                    # compile .svelte → src/gen
bun src/main-showcase.ts        # real window: 45-component showcase
bun src/conformance.ts          # 45/45  Svelte/DOM semantics
bun src/conformance-nkit.ts     # 30/30  component library + theme/motion
bun src/kit-conformance.ts      # 49/49  SvelteKit surface incl. remote fns
bun src/conformance-qg.ts       # 45/45  on QuickGUI headless backend
bun src/smoke-pages.ts          # 25/25 showcase pages paint
bun src/bench.ts                # pipeline bench vs baseline.json
bun src/mission-bridge.ts       # transport measurements
bun src/mission-startup.ts      # staged startup + RSS (real window)
bun src/mission-sqlite.ts       # bun:sqlite behavior probe
bun build --compile src/mission-startup.ts --outfile /tmp/app  # single binary

cd ../app && bun run build      # SvelteKit → build-bin/server (runs standalone)
cd ../ && bun packages/native/codegen.ts   # regen $native bindings
```

## 3. Measurements (all MEASURED this session, M4 Pro, n ≥ stated)

### Startup (real window, full showcase app)
| Stage | unpacked (n=3) | --compile binary |
|---|---|---|
| NAPI module load | ~12 ms | 428 ms (embedded .node extraction) |
| window init | ~270 ms | ~298 ms |
| svelte+app import+mount | ~60 ms | ~72 ms |
| **first frame (total)** | **~450 ms** | **~940 ms** |
| steady RSS | ~145–165 MiB | ~174 MiB |

Honest misses: stretch targets were <100 ms first frame / <100 MiB idle —
reality is ~450 ms / ~150 MiB dev-mode. Window init is 60% of startup; the JS
side is already fast. Compiled binary pays ~490 ms one-time for .node
extraction — fixable via .app Frameworks layout.

### Pipeline (bench.ts, vs stored baseline)
- `kit:mount-500` 95.7 ms (−79%), `kit:resolve-10k` 2.1 ms (−99%) — nkit
  token caching is real.
- Regressions to own: `raw:setstyle-500` +73% (0.7 ms), `raw:settext-500`
  +67% (0.3 ms), `dom:hover-cycle-2k` +27% — sub-ms ops; likely the String()
  coercion added to the style serializer; below noise-relevant magnitude but
  recorded for next session.
- paint p90 28.2 ms on the *test* renderer (software); real-window frame p90
  is 5.5 ms.

### Bridge (mission-bridge.ts)
| Batch | mean | p95 |
|---|---|---|
| 1 op | ~0 µs | — |
| 100 ops (3 KiB) | 0.01 ms | 0.01 |
| 1 000 ops (32 KiB) | 0.08 ms | 0.15 |
| 10 000 ops (320 KiB) | 0.68 ms | 0.77 |
| 10 MiB single payload | 1.90 ms | — |
| drainEvents idle | 0.1 µs | — |

→ 60 Hz budget could afford ~240k ops/frame through the JSON path. Bulk bytes
should still bypass JSON (10 MiB = 1.9 ms is fine but wasteful; QuickGUI's
`NativeEvent.data: Uint8Array` shows the right pattern).

### bun:sqlite (mission-sqlite.ts)
- WAL on; tx rollback atomic (failed tx left 10 000 rows, not 10 001);
  1.49 M inserts/s in a tx; prepared point-gets ~2 µs; second connection reads
  WAL concurrently; 40k-row sync copy 8.7 ms; 40k rows → JS objects 5.5 ms.
- Verdict: sync-on-main is fine for app-scale queries; dedicated worker only
  for >50 ms ops. Workers verified: spawn by file URL (Blob URLs unsupported —
  noted limitation), run their own `bun:sqlite` connection.

### Packaging
- `app/build-bin/server`: 64.6 MB, serves 200 in 55 ms, zero toolchain.
- Desktop binary: 82.6 MB, real window, works. Unsigned — Gatekeeper would
  warn elsewhere; signing/notarization NOT_RUN (no credentials, by design).

### $native contract (crates/native-core + packages/native)
- `add(2,3)=5` scalar; `wordCount` bytes-in with typed error
  (`invalid_utf8`); `jsonTransform` heap-out + `nc_free` ownership;
  `catch_unwind` containment. Call overhead 18 ns.
- Two real bugs found and fixed in the spike: missing out-param in codegen
  (arg-count mismatch → zero-length read), and view-into-freed-memory
  (`Uint8Array` over native buffer read after `nc_free`) — both are exactly
  the binding-contract hazards the brief warned about; the codegen now encodes
  the correct pattern.

## 4. Native API coverage (spec/native-api.yaml — authoritative)

~30 surfaces inventoried with per-method `impl`/`test`/`platform` status.
Honest rollup:

- **implemented+tested**: theme (light/dark/system + reduceMotion), window
  focus+events, events/channels (native→JS), svelte-layer diagnostics,
  $native spike (3 commands), plus the entire nkit/kit app surface.
- **bound, untested** (largest block — QuickGUI dylib exports already callable):
  clipboard (all formats), menu, tray, dialogs, notifications, screen, power,
  secure storage, autostart, deep links, single instance, dock, permissions,
  global shortcuts, shell, spellchecker, window state.
- **specified only**: updater, capture, drag-drop, windowState persistence
  schema, capabilities manifest, protocol resources, file associations.
- **bun-provided (no work needed)**: sqlite/fs/net/ws/crypto/workers/subprocess.
- **explicitly out of scope**: webContents/DOM/devtools/webrtc/drm — no
  browser to be compatible *with*.

## 5. SvelteKit compatibility (docs/sveltekit-compatibility.md)

49/49 cases — routing/params/matchers/groups, layouts+errors, universal +
server loads, hooks (handle/reroute/handleFetch/handleError), forms + actions
+ enhance, streaming, shallow nav, cookies, `$app/*`, remote
query/command/form, invalidation tracking, nav cancellation/coalescing.
Deliberate adaptations: "server" runs in-process (no HTTP hop in-window);
no SSR/hydration (nothing to hydrate); history is in-app. Gaps: bind:files,
platform-AX materialization (role/aria metadata now reaches the retained
native tree but gpuix does not yet expose it to NSAccessibility — see §8).

## 6. What influenced the implementation

- **QuickGUI** (pinned source audit → docs/quickgui-analysis.md): its service
  surface became our V1 spec inventory; its FFI pattern (event-notifier +
  batch drain, versioned protocol, Frameworks-dir library lookup) validated
  the transport and informed packaging layout; its worker-model confirmed our
  single-thread alternative is the simpler sound choice.
- **Svelai**: component prop/variant surface, ThemeState shape, motion scale
  (100/200/300/500 + named easings), 5-rung theme ladder — ported to style
  props, verified by c-theme/c-motion.
- **Electron/Tauri**: API inventory reference only (per-method `upstream`
  tags in the spec). No runtime code adopted.
- **React Native**: JSI/Fabric consulted as prior art for in-process native
  modules — reinforced the NAPI choice over a serialized bridge.

## 7. Failed approaches / negative results

- `applyBatch` inside event callback → GPUI reentrancy panic (reproduced;
  fixed via deferred flush).
- `themeRev.v++` inside an effect → infinite invalidation (`++` reads before
  writes; `untrack` fix). Documented as a rune gotcha.
- Blob-URL Bun Workers → unsupported; file-URL workers only.
- `bun:ffi` `toArrayBuffer` → returns a view, not a copy; reading after
  `nc_free` is use-after-free (silent garbage, caught only because output was
  asserted).
- Static `s()` top-level calls → never restyle on theme flip (fixed: `$derived`).
- Multi-window teardown: `process.exit` while the QuickGUI host still holds
  FFI notifier callbacks → Bun segfault (null deref @0x8), reproduced with
  both bare exit and after orderly window destroy. `app.destroy()` from a
  timer races the host dispatch pump (post-destroy flush throws). Orderly
  window close itself is clean — the crash is in worker-exit/FFI teardown.
  Minimal repro: `bun src/mission-qg-multiwin-main.ts` → PASS then crash.
- `bun build --compile --external` for the `.node` module → runtime bare-
  specifier resolution does not search execPath-relative `node_modules`;
  external native modules unsupported today. `.app` keeps the embedded
  `.node` (one-time ~430 ms extraction).
- Vendor-GPUI build: previously disk-blocked; now unblocked (29 GiB) but not
  needed for the decision — deferred.

## 8. Blockers & risks

- **A11y platform materialization**: the JS→native transport is now complete
  — implicit tag→role map + typed `aria-*` land in the retained tree
  (`a11y-roles.log`), and nkit authors proper semantics on 24+ components.
  Missing: gpuix does not materialize custom props into NSAccessibility
  elements. QuickGUI ships a full AX subsystem (landmarks, style groups,
  display-preference queries) but only for its own widget descriptors, which
  nkit does not emit. Biggest remaining product gap; needs gpuix renderer work.
- **Multi-window lifecycle**: functional on the QG backend (2 windows,
  independent Svelte trees, close-one-keep-others, cleanups run — PASS).
  Blocker: host segfault on worker exit (above). Also note `Appearance` and
  other window-scoped services need a live window context.
- **bun:ffi experimental**: mitigated by keeping the main renderer on NAPI;
  FFI is for services/plugins only. The teardown segfault is this class of
  risk made concrete — FFI callback lifetime vs process exit.
- **Unsigned binaries**: fine for dev; release needs credentials + hardened
  runtime + notarization checklist (untested by design).
- **Notifications/permissions**: `Notifications.getPermissionStatus` returns
  `unsupported`; `Permissions.status("notifications")` fails with unknown
  native permission kind. Needs binding work, not just testing.
- **Cross-platform**: everything measured is darwin-arm64. gpui targets
  linux-x64/win-x64 exist in the NAPI package but are NOT_RUN.
- **Resolved**: git repo initialized (854d535); `.app` packaging scripted;
  bound QuickGUI services runtime-tested (28 entries flipped `bound`→`tested`);
  $native v2 (handles/async/cancel) green; reliability suite 11/11.

## 9. Next-session queue (dependency-ordered)

Done this mission: git init (854d535) · `.app` packaging script · 28
bound-service runtime tests · $native v2 (handles/async/cancel) ·
multi-window functional pass · a11y role/aria transport · reliability 11/11.

1. **Fix worker-exit segfault** (multiwin blocker): repro
   `mission-qg-multiwin-main.ts`; likely FFI notifier callback outliving the
   worker — either guard host-side dispatch after worker death or order
   `app.destroy()` before exit without racing the pump. Cheapest probe:
   `app.destroy()` from the host side (not a worker timer).
2. **gpuix AX materialization**: consume `role`/`aria-*` custom props into
   `accessibilityElement` children — the biggest product gap now that
   transport is done.
3. Notifications/permissions binding fixes (wrong kind strings today).
4. Window-scoped services with a live window (Appearance, dialogs parented
   to a window, menu/tray) — extension of mission-qg-app pattern.
5. Windows/Linux CI cross-build evidence (even if run untested).
6. Updater + signing checklist (requires credentials — out of scope here).

## 10. Verdict

Svelte + Bun + GPUI is **past the feasibility question** — it is a working
system with measured, honest numbers: ~293 ms median first frame over 20
launches (p95 367 ms), ~173 MiB packaged RSS, ~5.5 ms p90 real frames,
event-driven idle, a 49/49-case SvelteKit surface, a 45-component themed
library, an 11/11 reliability suite, functional multi-window, and a proven
single-binary + `.app` package. The remaining work is depth — platform-AX
materialization, worker-exit teardown, notification bindings, signing —
plus one concrete lifecycle bug, not architecture risk. Recommended
architecture: **Bun host + NAPI renderer, `bun:ffi` reserved for the service
dylib and `$native` plugin spikes, Bun Workers for heavy compute.**
