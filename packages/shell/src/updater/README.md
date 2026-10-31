# Auto-updater

`@svelte-desktop/shell/updater` works with static hosting (S3, R2, GitHub Releases, any CDN). The release manifest is signed, and every archive is pinned by its hash. Files are swapped by a helper that runs after the app exits, and an update that never confirms a healthy start is rolled back automatically.

The design follows Electrobun's updater (a static `update.json`, full archives, and a swap helper that runs after exit, with rollback), with one gap closed: **Electrobun signs neither the manifest nor the archives; this updater does.**

```
src/updater/
  index.ts      createUpdater(): check / download / apply / confirm / rollbackIfNeeded / restart
  manifest.ts   schema, canonical JSON, Ed25519 sign/verify
  crypto.ts     Ed25519 (WebCrypto, node:crypto fallback), PEM
  download.ts   streaming download with SHA-256 + size enforcement
  archive.ts    tar.zst / tar.gz extraction & creation (system tar + Bun zstd)
  helper.ts     generated swap helper (sh on macOS/Linux, PowerShell on Windows)
  platform.ts   platform keys, data dirs, install location
  state.ts      state.json
scripts/updater-cli.ts   keygen / sign / verify / pack / make-manifest
```

## Security model

1. **Signed manifest.** `update.json` carries an Ed25519 `signature`. The signed bytes are:

   ```
   UTF-8( "svelte-desktop/update-manifest/v1\n" + canonicalize(manifest minus "signature") )
   ```

   `canonicalize` produces JSON with object keys sorted recursively (JS default string order), no whitespace, and `undefined` members dropped. Non-finite numbers are rejected. The signature covers every field, including unknown and future ones (`patches`). Because verification re-serializes the parsed object, pretty-printing or reordering the file does not break it, while changing any value does. The context prefix provides domain separation, so the key's signatures cannot be replayed in another protocol.

   The client verifies the signature **before** reading any field. It then checks that `name` equals `appName`, that `channel` equals the configured channel (so a signed beta manifest can't be pushed to stable users), and that `version` is **strictly newer** than the current version (so replaying an old signed manifest can't downgrade anyone).

2. **Hash pinning.** Each artifact pins `sha256` and `size` inside the signed manifest. The download is hashed while it streams. The byte count is enforced during the stream: an oversized body is cut off, not written to disk. Size and hash are verified before the file is renamed into place, and nothing is extracted until both match. A compromised CDN or a MITM can therefore only cause a failed update, not a malicious one.

3. **HTTPS is still recommended.** The signature and hashes give integrity without TLS, but TLS still adds:
   - privacy: who updates, and which version they run;
   - some resistance to *freeze* attacks, where an attacker keeps serving an old but validly signed manifest so users never see a fix.

   `releasedAt` is signed, so you can add a staleness policy on top (for example, warn if the newest manifest is older than N days).

4. **The private key never ships.** The app embeds only the 32-byte public key (base64). Keep the private key in your CI secret store (`--key-env`).

5. **Key rotation.** `publicKey` accepts an array, and a manifest is valid if *any* listed key verifies it. To rotate:
   1. ship a release that embeds `[oldKey, newKey]`, still signed with `oldKey`;
   2. once most users are on it, sign releases with `newKey`;
   3. later, drop `oldKey` from the embedded list.

   For a compromised key, run the same steps urgently, then publish a `minimumVersion` so stragglers are told the update is mandatory.

6. **Platform code signing** (Apple notarization, Authenticode) is separate and still needed for Gatekeeper and SmartScreen. The updater does not re-verify it. A natural hardening step is to run `codesign --verify --deep --strict` on the staged `.app` before `apply()`.

7. **Not defended against:** an attacker who can already write to the install directory or to the updater's data directory as the user. That attacker owns the app anyway.

## Manifest

```jsonc
{
  "name": "MyApp",                       // must equal createUpdater({ appName })
  "version": "1.4.0",                    // semver, no leading "v"
  "channel": "stable",                   // must equal createUpdater({ channel }) (default "stable")
  "releasedAt": "2026-10-30T12:00:00.000Z",
  "notes": "Bug fixes",                  // optional
  "minimumVersion": "1.2.0",             // optional: installs < this get info.mandatory = true
  "artifacts": {
    "darwin-arm64": { "url": "MyApp-1.4.0-darwin-arm64.tar.zst", "sha256": "<64 hex>", "size": 51234567, "format": "tar.zst" },
    "windows-x64":  { "url": "https://cdn.example.com/MyApp-1.4.0-windows-x64.tar.zst", "sha256": "…", "size": 1, "format": "tar.zst" }
  },
  "signature": "<base64 Ed25519>"
}
```

- Keys have the form `<os>-<arch>`, where os is `darwin|linux|windows` and arch is `arm64|x64`. Unknown keys are tolerated, for forward compatibility.
- A relative `url` resolves against the **configured manifest URL** (not a redirect target), so a release directory can be uploaded as-is.
- `manifestUrl` may contain `{channel}`, for example `https://updates.example.com/myapp/{channel}/update.json`.
- **`minimumVersion` semantics:** "everyone older than this must update". `check()` still returns the update; `info.mandatory` tells the UI not to offer "later". Since every artifact is a full archive, any version can install it, so there is no "too old to update" gating.

### Archive formats

`tar.zst` (recommended) and `tar.gz`. Zip is deliberately not supported: Linux has no built-in unzip, zip drops the symlinks and modes that `.app` frameworks need, and `tar` exists on all three OSes (Windows 10 1803+ ships `tar.exe`).

Archive layout:

| Install | Archive top level | Swap |
|---|---|---|
| macOS `.app` | exactly one `<Name>.app/` (with `Contents/MacOS` and `Contents/Info.plist`) | `<Installed>.app` → `<Installed>.app.old`; staged `.app` moved in under the installed name |
| Linux / Windows / bare macOS binary | the executable, plus any sibling files (e.g. a native lib) | each entry `X` replaces `<installdir>/X`; previous file kept as `X.old`. If the archive holds a single file, it replaces the running executable whatever its name (renamed exes, AppImage via `$APPIMAGE`). Otherwise an entry named like the running executable is required. |

### Extension point: `patches` (reserved)

`patches` is reserved for Electrobun-style binary deltas: a chain of bsdiff patches from older versions to this one. It is **not interpreted** by this client, but it **is signed**. A future client could use a shape like:

```jsonc
"patches": { "darwin-arm64": [ { "from": "1.3.0", "url": "…", "sha256": "…", "size": 123, "resultSha256": "<sha256 of the reconstructed tar>" } ] }
```

The future client would:
1. select the patch chain starting at `currentVersion`;
2. download each patch with `downloadVerified()`;
3. apply them to a tarball of the current install;
4. check `resultSha256`;
5. fall back to the full artifact on any mismatch.

Everything after "verified archive on disk" (extract → `apply()`) stays unchanged. Old clients ignore the field.

## Client flow

```ts
import { createUpdater } from "@svelte-desktop/shell/updater";

const updater = createUpdater({
  manifestUrl: "https://updates.example.com/myapp/{channel}/update.json",
  publicKey: "q1r…base64…=",          // or [old, new] during rotation
  currentVersion: APP_VERSION,
  appName: "MyApp",
  channel: "stable",
  quit: () => postMessage({ type: "quit" }), // see "Quitting from the Worker"
});

// 1. Early at startup.
if (await updater.rollbackIfNeeded()) {
  await updater.restart();               // the previous version is back on disk; relaunch into it
}

// 2. Once the app is known to be healthy (window shown, server up, …).
await updater.confirm();

// 3. Whenever you want to check.
const info = await updater.check();      // null = up to date / no artifact for this platform
if (info) {
  const staged = await updater.download(info, { onProgress: (p) => ui.progress(p.fraction) });
  await updater.apply(staged, { relaunch: true });  // spawns the helper, then quits the app
}
```

What happens:

1. **`check()`** fetches `update.json`, verifies the signature, then checks name, channel, version (`Bun.semver.order`) and `minimumVersion`. It picks the artifact for `process.platform`/`process.arch`. A version previously rolled back is not offered again.
2. **`download()`** streams the archive to `<dataDir>/staging/<version>/` with progress and an `AbortSignal`. It verifies size and SHA-256, extracts to `payload/`, and validates the layout. A previously verified archive is reused, and older staged versions are deleted. The default `dataDir` is:
   - macOS: `~/Library/Application Support/<app>/updates`
   - Windows: `%LOCALAPPDATA%\<app>\updates`
   - Linux: `$XDG_DATA_HOME/<app>/updates` (default `~/.local/share`)
3. **`apply()`** locates the install from `process.execPath` (on macOS, the outermost enclosing `.app`) and checks that the install directory is writable. Then it:
   - writes `state.json` with `{phase:"applying"}`;
   - generates `<dataDir>/apply-helper.sh` (or `.ps1` on Windows) and starts it detached;
   - quits.

   The helper:
   - waits for the app's PID to exit (default timeout 120 s; on timeout it changes nothing and records `failed`);
   - deletes stale `.old` copies;
   - renames each current file or bundle to `.old` and moves the staged one in;
   - writes `{phase:"applied", from, to, attempts:0}`;
   - relaunches if asked, deletes itself, and exits.

   If any move fails, it restores what it already moved, records `failed`, and relaunches the old version. Output goes to `<dataDir>/helper.log`.
4. **`rollbackIfNeeded()`**, at each start of the new version, increments `attempts`. When `attempts` reaches `maxAttempts` (default 2) without a `confirm()`, it restores the `.old` copies, marks the state `rolled-back`, and returns `true`. On Windows it renames the running exe aside instead of deleting it; the leftover `.bad` copy is removed on a later start. It also recovers from a helper that died mid-swap: if the state is `applying` for longer than the wait timeout plus 60 s, it restores anything missing.
5. **`confirm()`** on the new version deletes the `.old` copies, the staging directory, the helper script, and `state.json`.

`status()` returns the raw state, for example to tell the user "update 1.4.0 was rolled back".

### Quitting from the Worker

App code runs in a Bun Worker, and `process.exit()` inside a Bun Worker ends only the Worker, not the app. Pass `quit` so the main thread can close the WebView cleanly and exit. Without it, the updater sends `SIGTERM` to the whole process when running in a Worker (on Windows, `process.kill` terminates the process). The helper waits for the PID either way.

### Limitations and caveats

- **Crash-before-`rollbackIfNeeded()`:** rollback runs inside the new version, so a build that crashes before reaching that call never rolls back. Call it as the very first thing. A stronger design would have the helper relaunch, watch the child for N seconds, and roll back itself.
- **Permissions:** the install directory must be writable by the user. This means `/Applications` for an admin user on macOS, `%LOCALAPPDATA%\Programs\<app>` on Windows (not `Program Files`), and a user-owned directory on Linux. Otherwise `apply()` throws `not_writable`. A translocated (quarantined) macOS app is detected and refused.
- **Uncompiled runs:** `apply()` and `install()` refuse to run under `bun file.ts` unless `installPath` is given; otherwise the updater would "update" the `bun` binary itself. Compiled binaries are detected by `Bun.main` starting with `/$bunfs/` (or `B:/~BUN/` on Windows).
- **macOS relaunch** uses `open -n <App>.app`, so LaunchServices registers the new bundle.
- **Windows:** the helper runs through `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File …`. It retries moves for about 10 s, because AV scanners and WebView2 child processes can briefly lock files. Archives are extracted with `%SystemRoot%\System32\tar.exe`, never a `tar` from `PATH`: Git/MSYS GNU tar treats `C:\…` as `host:path`.

### Test and override options

`createUpdater({ installPath, platform, arch, dataDir, relaunchCommand, waitTimeoutSec, maxAttempts, fetch })` and `apply(staged, { quit: false, waitForPid, dryRun })` let tests run the real helper against fake installs in temp dirs. With `dryRun: true`, `apply()` only writes the script and returns the command it would run.

## Publishing

```sh
# once: create the signing key; embed the printed public key in the app
bun packages/shell/scripts/updater-cli.ts keygen --out updater.key      # writes updater.key (0600) + updater.key.pub

# per release, per platform: archive the build output
bun packages/shell/scripts/updater-cli.ts pack dist/MyApp.app --out release/MyApp-1.4.0-darwin-arm64.tar.zst
bun packages/shell/scripts/updater-cli.ts pack dist/myapp.exe dist/webview.dll --out release/MyApp-1.4.0-windows-x64.tar.zst

# write + sign the manifest (computes sha256 and size)
bun packages/shell/scripts/updater-cli.ts make-manifest \
  --name MyApp --version 1.4.0 --channel stable \
  --artifact darwin-arm64=release/MyApp-1.4.0-darwin-arm64.tar.zst \
  --artifact windows-x64=release/MyApp-1.4.0-windows-x64.tar.zst \
  --notes-file CHANGELOG-1.4.0.md --key-env UPDATER_PRIVATE_KEY \
  --out release/update.json                 # add --base-url https://cdn… for absolute URLs

# sanity check, then upload release/ to <host>/myapp/stable/ (upload update.json LAST)
bun packages/shell/scripts/updater-cli.ts verify release/update.json --public-key "$(cat updater.key.pub)"
```

- Upload the archives first and `update.json` last, so clients never see a manifest that points to missing files.
- Give `update.json` a short cache TTL. Archives are immutable (versioned names), so they can be cached forever.
- After editing a manifest by hand, re-sign it with `sign release/update.json --key updater.key`.
- macOS: sign and notarize `MyApp.app` **before** `pack`. The `pack` command sets `COPYFILE_DISABLE=1` so no `._*` AppleDouble files end up in the archive.


## Delta updates

`vite build` with `update` configured looks for the previous release in
`release/<version>/`, extracts it, and writes
`<App>-<new>-<platform>.from-<previous>.sdpatch` next to the full archive. The
signed manifest lists it:

```json
"patches": { "darwin-arm64": [{ "from": "0.1.0", "url": "0.2.0/App-0.2.0-darwin-arm64.from-0.1.0.sdpatch", "sha256": "…", "size": 14135 }] }
```

The patch is a zstd container of per-file operations (`same` / rsync-style
`delta` against the installed file / `new`), with the size and sha256 of every
resulting file (`delta.ts`). A client whose version matches `from` downloads the
patch (sha256-pinned by the signed manifest), rebuilds the new `.app` from its
installed copy, verifies every file, then applies it like a full update. Any
mismatch — a modified install, a bad patch — falls back to the full archive.
Measured on the example app: a one-line change is a 14 KB patch against a 39 MB
archive; creating it takes ~0.2 s, applying it ~60 ms.
