# kitop

A desktop app from your SvelteKit app, which stays a website: one Vite plugin, one config file, Bun, the system's web view, and a single binary.

```diff vite.config.ts
 import { sveltekit } from '@sveltejs/kit/vite';
+import { desktop } from '@kitop/shell/vite';
 import { defineConfig } from 'vite';

 export default defineConfig({
-  plugins: [sveltekit({ adapter: adapter() })],
+  plugins: [sveltekit({ adapter: adapter() }), desktop()],
 });
```

```sh
bun run dev                             # the website, as before
bun run dev --mac                       # a native window, with hot reload
bun run build                           # the website, with your adapter
bun run build --mac --windows --linux   # the desktop apps
```

Routes, load functions, remote functions, form actions, endpoints and hooks stay as they are, and run on Bun inside the app. `host` adds what a browser doesn't have: windows, menus, tray, notifications, files, self-update.

## Status

Early, and not yet used in production. `@kitop/shell` isn't on npm yet, and its API can still change.

| | Web view | Output | Tested in CI |
| --- | --- | --- | --- |
| macOS | WKWebView | `.app`, zip, DMG | macOS 15, arm64, in a runner's session: the unit tests, the native suites (one hot key check skipped), the built examples in real windows, a real update. Nothing that needs a person at the screen |
| Linux | WebKitGTK | Folder, `.tar.gz`, AppImage | The unit tests on Ubuntu. Ubuntu 24.04 in Docker under Xvfb, x64: the native suites, the built examples, real updates, the packed tarball. No real display or desktop |
| Windows | WebView2 | Folder, zip, NSIS installer | A Windows runner, x64: the app built on Linux and driven end to end, a real update, the unit tests (Linux's and macOS's updater tests skipped), and `kitop dev` and `kitop build`, website and app, with a `shell.dll` built on Linux. Not Docker Desktop, which building `shell.dll` on Windows takes |

Signing with a real identity hasn't been run. See [what's limited on each platform](website/docs/shipping/limitations.mdx).

## Try it

With [Bun](https://bun.sh) 1.4 or newer. On macOS you also need the Xcode command line tools. On Windows, [Docker Desktop in Linux containers mode](website/docs/shipping/distribution.mdx#windows).

```sh
(cd packages/shell && bun install)
cd examples/notes
bun install
bun run dev      # a native window, with hot reload
bun run build    # the app, in .desktop/dist
```

To make your own app a desktop app too, follow [Convert a SvelteKit app](website/docs/convert-sveltekit-app.mdx).

## What's where

| Folder | What it is |
| --- | --- |
| `packages/shell` | The framework: `@kitop/shell`, its CLI, and the native shells in `native/` |
| `packages/push-worker` | The optional push notification service |
| `examples/notes` | The app most tests run against |
| `examples/dashboard`, `examples/panes` | Tabs, panes and a larger layout |
| `examples/kit-conformance` | SvelteKit's features in the app, a closed bridge list, the build to distribute |
| `website` | The documentation. Run it with `bun run docs` |

kitop uses nothing else in this repository. `experiments/gpui` is an earlier project that renders Svelte through GPUI instead of a web view ([its notes](experiments/gpui/README.md)), with its own `package.json`, and `documentation` is its documentation. The rest of `experiments` is earlier work too, kept for reference.

## Tests

```sh
bun run test                # the unit tests, no window (packages/shell: bun test src)
cd packages/shell
test/docker/run.sh platform # Linux native suites, in Docker
test/docker/run.sh e2e      # Linux end to end, in Docker
test/run-platform.sh        # macOS native suites: real windows
```

`bun test` in `examples/*` opens real windows and takes the keyboard. `.github/workflows` shows what runs on each platform. [CONTRIBUTING.md](CONTRIBUTING.md) has the rest, and [SECURITY.md](SECURITY.md) how to report a vulnerability.

## License

[MIT](LICENSE)
