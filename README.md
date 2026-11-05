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
| macOS | WKWebView | `.app`, zip, DMG | End to end on macOS 15 |
| Linux | WebKitGTK | Folder, `.tar.gz`, AppImage | End to end in Docker, without a real display |
| Windows | WebView2 | Folder, zip, NSIS installer | End to end on a Windows runner, x64 only |

Signing with a real identity hasn't been run. See [what's limited on each platform](website/docs/shipping/limitations.mdx).

## Try it

With [Bun](https://bun.sh) 1.4 or newer. On macOS you also need the Xcode command line tools.

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
| `website` | The documentation. Run it with `cd website && bun install && bun run dev` |

kitop uses nothing else in this repository. `app`, `documentation` and `packages/{gpuix,platform,svelte,tests,vite}` are a separate project that renders Svelte through GPUI instead of a web view ([its notes](experiments/gpui-README.md)). `experiments`, `spikes` and `results` are earlier work, kept for reference.

## Tests

```sh
cd packages/shell
bun test src                # unit tests, no window
test/docker/run.sh e2e      # Linux end to end, in Docker
```

`bun test` in `examples/*` opens real windows and takes the keyboard. `.github/workflows` shows what runs on each platform.

## License

[MIT](LICENSE)
